// Applies the hand-written SQL in prisma/sql, in order, to the database in .env (DIRECT_URL).
//
// Prisma manages tables. It does not manage views, row-level security, functions, triggers or
// grants, and `prisma db push` neither creates nor notices them. Those live in prisma/sql as
// files that are safe to run again, and this is the one way they are applied — so the repo, not
// someone's memory of what they once ran in a SQL console, is the record of what the database has.
//
//   pnpm db:sql            apply every file in ORDER
//   pnpm db:sql --list     print the order and exit
//
// Run it after every `prisma db push`. New tables need public-rls.sql re-applied, and nothing
// else will remind you.
//
// To add a file: make it idempotent (IF NOT EXISTS, CREATE OR REPLACE, DROP ... IF EXISTS before
// CREATE), then add it to ORDER below. Files not listed are never run — that is how a rollback
// file stays out of the way.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Applied top to bottom. Later files may depend on earlier ones. */
const ORDER = [
  "public-rls.sql", // default-deny RLS on every public table; last, so it covers new tables
];

if (process.argv.includes("--list")) {
  ORDER.forEach((file, i) => console.log(`${i + 1}. prisma/sql/${file}`));
  process.exit(0);
}

for (const file of ORDER) {
  const path = join(ROOT, "prisma", "sql", file);
  if (!existsSync(path)) {
    console.error(`Missing prisma/sql/${file} — it is listed in ORDER but not on disk.`);
    process.exit(1);
  }
  process.stdout.write(`Applying ${file} ... `);
  // `prisma db execute` runs the file as one script against DIRECT_URL (the session-mode
  // connection — DDL does not work through the transaction pooler).
  // The file is passed relative to ROOT: the command goes through a shell (pnpm is a .cmd on
  // Windows), and an absolute path containing a space would be split in two.
  const result = spawnSync("pnpm", ["exec", "prisma", "db", "execute", "--file", `prisma/sql/${file}`, "--schema", "prisma/schema.prisma"], {
    cwd: ROOT,
    encoding: "utf8",
    shell: true,
  });
  if (result.status !== 0) {
    console.log("FAILED");
    console.error((result.stderr || result.stdout).trim());
    console.error(`Stopped at ${file}. Files after it were not applied.`);
    process.exit(1);
  }
  console.log("ok");
}
console.log(`Applied ${ORDER.length} file(s).`);
