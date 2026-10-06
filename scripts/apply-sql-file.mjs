// Applies one hand-written SQL file to the database in .env, as one transaction.
//
//   pnpm db:sql:file prisma/sql/customer-password-reset.sql
//
// For changes that must not go through `prisma db push` (see the file being applied for why).
// The file has to be safe to run twice. Statements are split on semicolons outside of
// comments, quotes and dollar-quoted blocks.
//
// It tries DIRECT_URL first and falls back to the same login on port 6543, because the
// session-mode port (5432) of the Supabase pooler sometimes accepts a connection and never answers.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("dotenv").config();
const { PrismaClient } = require("../generated/prisma");

const file = process.argv[2];
if (!file) {
  console.error("Usage: pnpm db:sql:file <path to .sql>");
  process.exit(1);
}

function splitStatements(sql) {
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
  return statements;
}

async function connect() {
  const direct = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  const candidates = [direct];
  const url = new URL(direct);
  if (url.port === "5432" && url.hostname.endsWith(".pooler.supabase.com")) {
    url.port = "6543";
    url.searchParams.set("pgbouncer", "true");
    candidates.push(url.toString());
  }
  for (const candidate of candidates) {
    const client = new PrismaClient({ datasources: { db: { url: candidate } } });
    try {
      await Promise.race([client.$queryRawUnsafe("SELECT 1"), new Promise((_, r) => setTimeout(() => r(new Error("timeout")), 8000))]);
      console.log(`Connected on port ${new URL(candidate).port}.`);
      return client;
    } catch {
      await client.$disconnect().catch(() => {});
    }
  }
  throw new Error("Could not connect to the database on either port.");
}

const statements = splitStatements(readFileSync(file, "utf8"));
const db = await connect();
try {
  await db.$transaction(statements.map((statement) => db.$executeRawUnsafe(statement)));
  console.log(`Applied ${file} (${statements.length} statements).`);
} finally {
  await db.$disconnect();
}
