import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

const cutoff = "20260716200000_account_change_log";
const mode = process.argv[2] ?? "--status";
const expected = readdirSync(new URL("../prisma/migrations", import.meta.url), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^\d+_/.test(entry.name) && entry.name <= cutoff)
  .map((entry) => entry.name)
  .sort();

const prisma = new PrismaClient();
let applied = new Set();
try {
  const [registry] = await prisma.$queryRawUnsafe(
    `SELECT to_regclass('public._prisma_migrations')::text AS name`,
  );
  if (registry?.name) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`,
    );
    applied = new Set(rows.map((row) => row.migration_name));
  }
} finally {
  await prisma.$disconnect();
}

const missing = expected.filter((name) => !applied.has(name));
if (mode === "--status") {
  if (missing.length === 0) {
    console.log(`Migration history is converged through ${cutoff}.`);
    process.exit(0);
  }
  console.log(`Migration history needs a one-time baseline for ${missing.length} existing migration(s).`);
  process.exit(2);
}

if (mode !== "--apply" || process.env.JUNO_ALLOW_MIGRATION_BASELINE !== "1") {
  throw new Error("Refusing to baseline migrations without --apply and JUNO_ALLOW_MIGRATION_BASELINE=1.");
}

for (const migration of missing) {
  const result = spawnSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["prisma", "migrate", "resolve", "--applied", migration],
    { stdio: "inherit", env: process.env },
  );
  if (result.status !== 0) {
    throw new Error(`Could not baseline ${migration}.`);
  }
}
console.log(`Baselined ${missing.length} migration(s) through ${cutoff}.`);
