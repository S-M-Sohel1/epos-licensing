// Applies the hand-written SQL in prisma/sql, in order, to the database in .env, as its owner.
//
// Prisma manages tables. It does not manage views, row-level security, functions, triggers or
// grants, and `prisma db push` neither creates nor notices them. Those live in prisma/sql as
// files that are safe to run again, and this is the one way they are applied — so the repo, not
// someone's memory of what they once ran in a SQL console, is the record of what the database has.
//
//   pnpm db:sql            apply every file in ORDER
//   pnpm db:sql --list     print the order and exit
//
// Run it after every `prisma db push`. A new table in `public` has RLS off until public-rls.sql runs
// again, and nothing else will remind you.
//
// To add a file: make it idempotent (IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS before
// CREATE), then add it to ORDER below. Files not listed are never run — that is how a rollback
// file stays out of the way.
//
// Each file runs as ONE transaction: it is applied completely or not at all. The statements are
// sent through the Prisma client rather than `prisma db execute`, because that command needs the
// session-mode port (5432), and the Supabase pooler sometimes accepts connections there without
// ever answering while the transaction-mode port (6543) is fine. The client works on both, so this
// script tries DIRECT_URL first and falls back to the same owner login on 6543.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
require("dotenv").config({ path: join(ROOT, ".env") });
const { PrismaClient } = require("../generated/prisma");

/** Applied top to bottom. Later files may depend on earlier ones. */
const ORDER = [
  "pos-sync-schema.sql", // the pos_sync schema: staged catalogue, sync log, grants
  "pos-sync-orders.sql", // online orders on their way to a till: queue, presence, the website's functions
  "public-rls.sql", // default-deny RLS on every public table; after anything that adds one
];

if (process.argv.includes("--list")) {
  ORDER.forEach((file, i) => console.log(`${i + 1}. prisma/sql/${file}`));
  process.exit(0);
}

/**
 * Splits a script into statements on top-level semicolons. A semicolon inside a `--` comment, a
 * quoted string, a quoted identifier or a dollar-quoted body ($$ ... $$, $tag$ ... $tag$) does not
 * end a statement — function bodies and DO blocks are full of them.
 */
export function splitStatements(sql) {
  const statements = [];
  let current = "";
  let i = 0;
  while (i < sql.length) {
    const rest = sql.slice(i);
    if (rest.startsWith("--")) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      continue;
    }
    if (rest.startsWith("/*")) {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (dollar) {
      const end = sql.indexOf(dollar[0], i + dollar[0].length);
      const stop = end === -1 ? sql.length : end + dollar[0].length;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      // A doubled quote inside a quoted run is an escaped quote, not the end of it.
      while (j < sql.length && (sql[j] !== ch || sql[j + 1] === ch)) j += sql[j] === ch ? 2 : 1;
      current += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (ch === ";") {
      if (current.trim()) statements.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) statements.push(current.trim());
  // The script's own BEGIN/COMMIT are dropped: each file already runs inside one transaction here.
  return statements.filter((s) => !/^(BEGIN|COMMIT|START TRANSACTION)$/i.test(s));
}

/** The owner login on the transaction-mode port, built from DIRECT_URL. */
function transactionPoolerUrl(direct) {
  const url = new URL(direct);
  if (url.port !== "5432" || !url.hostname.endsWith(".pooler.supabase.com")) return null;
  url.port = "6543";
  url.searchParams.set("pgbouncer", "true");
  return url.toString();
}

/** Connects as the owner, preferring DIRECT_URL and falling back to port 6543 if it does not answer. */
async function connectAsOwner() {
  const direct = process.env.DIRECT_URL;
  if (!direct) {
    console.error("DIRECT_URL is not set in .env.");
    process.exit(1);
  }
  const candidates = [["DIRECT_URL", direct]];
  const fallback = transactionPoolerUrl(direct);
  if (fallback) candidates.push(["port 6543", fallback]);

  for (const [label, base] of candidates) {
    const url = new URL(base);
    url.searchParams.set("connect_timeout", "8");
    const db = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    try {
      const [who] = await db.$queryRawUnsafe(`select current_user as "user"`);
      console.log(`Connected through ${label} as ${who.user}.`);
      return db;
    } catch (err) {
      await db.$disconnect();
      const reason = (err instanceof Error ? err.message : String(err)).split("\n").filter(Boolean).pop();
      console.log(`${label} did not answer (${reason?.slice(0, 90)}).`);
    }
  }
  console.error("Could not connect as the owner on either port.");
  process.exit(1);
}

const db = await connectAsOwner();
try {
  for (const file of ORDER) {
    const path = join(ROOT, "prisma", "sql", file);
    if (!existsSync(path)) {
      console.error(`Missing prisma/sql/${file} — it is listed in ORDER but not on disk.`);
      process.exit(1);
    }
    const statements = splitStatements(readFileSync(path, "utf8"));
    process.stdout.write(`Applying ${file} (${statements.length} statements) ... `);
    let at = 0;
    try {
      await db.$transaction(
        async (tx) => {
          for (const statement of statements) {
            at += 1;
            await tx.$executeRawUnsafe(statement);
          }
        },
        { timeout: 60_000, maxWait: 15_000 },
      );
    } catch (err) {
      console.log("FAILED");
      console.error(`Statement ${at} of ${statements.length}:\n${statements[at - 1]?.slice(0, 400)}\n`);
      console.error((err instanceof Error ? err.message : String(err)).split("\n").filter(Boolean).slice(-3).join("\n"));
      console.error(`\n${file} was rolled back. Files after it were not applied.`);
      process.exit(1);
    }
    console.log("ok");
  }
  console.log(`Applied ${ORDER.length} file(s).`);
} finally {
  await db.$disconnect();
}
