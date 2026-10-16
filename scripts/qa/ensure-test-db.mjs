#!/usr/bin/env node
// Creates the disposable QA database and migrates it, or drops it (spec §14).
//
//   node scripts/qa/ensure-test-db.mjs          drop if present, create, prisma migrate deploy
//   node scripts/qa/ensure-test-db.mjs --drop   DROP DATABASE IF EXISTS ... WITH (FORCE)
//
// It re-checks DATABASE_URL and DIRECT_URL itself rather than trusting its
// caller: both must be postgresql://postgres@127.0.0.1:55439/<name>_test and
// name the same database. Prisma runs with only those two variables (plus
// PATH and HOME so the CLI can start, and the checkpoint opt-out), so nothing
// else in the parent environment can steer a migration.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseQaDatabaseUrl, QA_MAINTENANCE_URL } from "./lib/safe-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PRISMA = path.join(ROOT, "node_modules", ".bin", "prisma");

function fail(message) {
  console.error(`[qa:db] ${message}`);
  process.exit(2);
}

function prismaEnv(extra = {}) {
  /** @type {Record<string, string>} */
  const env = { CHECKPOINT_DISABLE: "1", ...extra };
  if (process.env.PATH) env.PATH = process.env.PATH;
  if (process.env.HOME) env.HOME = process.env.HOME;
  return env;
}

function prisma(args, { input, env, label }) {
  const run = spawnSync(PRISMA, args, { cwd: ROOT, env, input, encoding: "utf8", stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] });
  if (run.error) fail(`${label}: ${run.error.message}`);
  if (run.status !== 0) {
    process.stderr.write(run.stdout ?? "");
    process.stderr.write(run.stderr ?? "");
    fail(`${label} failed with exit ${run.status}.`);
  }
  return run;
}

function main() {
  const drop = process.argv.includes("--drop");
  const primary = parseQaDatabaseUrl(process.env.DATABASE_URL, "DATABASE_URL");
  const direct = parseQaDatabaseUrl(process.env.DIRECT_URL, "DIRECT_URL");
  if (!primary.ok) fail(primary.reason);
  if (!direct.ok) fail(direct.reason);
  if (primary.database !== direct.database) fail("DATABASE_URL and DIRECT_URL name different databases.");
  if (!existsSync(PRISMA)) fail(`Prisma CLI not found at ${PRISMA}. Run npm ci first.`);

  const name = primary.database;
  // The name already matched /^[a-z][a-z0-9_]*_test$/, so quoting it is safe.
  const dropSql = `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`;
  const maintenance = prismaEnv();

  prisma(["db", "execute", "--url", QA_MAINTENANCE_URL, "--stdin"], { input: dropSql, env: maintenance, label: `drop ${name}` });
  if (drop) {
    console.error(`[qa:db] Dropped ${name}.`);
    return;
  }
  prisma(["db", "execute", "--url", QA_MAINTENANCE_URL, "--stdin"], {
    input: `CREATE DATABASE "${name}";`,
    env: maintenance,
    label: `create ${name}`,
  });
  console.error(`[qa:db] Created ${name}. Applying migrations...`);
  const migrate = prisma(["migrate", "deploy"], {
    env: prismaEnv({ DATABASE_URL: String(process.env.DATABASE_URL), DIRECT_URL: String(process.env.DIRECT_URL) }),
    label: "prisma migrate deploy",
  });
  const applied = /(\d+) migrations? found/.exec(migrate.stdout ?? "");
  console.error(`[qa:db] ${name} is migrated${applied ? ` (${applied[1]} migrations)` : ""}.`);
}

main();
