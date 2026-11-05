#!/usr/bin/env node
// Creates the disposable QA database and migrates it, or drops it (spec §14).
//
//   node scripts/qa/ensure-test-db.mjs          create a new database, prisma migrate deploy
//   node scripts/qa/ensure-test-db.mjs --drop   drop only this run's recorded database
//
// It re-checks DATABASE_URL and DIRECT_URL itself rather than trusting its
// caller: both must be postgresql://postgres@127.0.0.1:55439/<name>_test and
// name the same database. Prisma runs with only those two variables (plus
// PATH and HOME so the CLI can start, and the checkpoint opt-out), so nothing
// else in the parent environment can steer a migration.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseQaDatabaseUrl, QA_MAINTENANCE_URL, checkSafeEnv } from "./lib/safe-env.mjs";

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
  const safety = checkSafeEnv({ env: process.env, dirs: [ROOT, process.cwd()], root: ROOT });
  if (!safety.ok) fail(safety.errors.join("\n"));
  const primary = parseQaDatabaseUrl(process.env.DATABASE_URL, "DATABASE_URL");
  const direct = parseQaDatabaseUrl(process.env.DIRECT_URL, "DIRECT_URL");
  if (!primary.ok) fail(primary.reason);
  if (!direct.ok) fail(direct.reason);
  if (primary.database !== direct.database) fail("DATABASE_URL and DIRECT_URL name different databases.");
  if (!existsSync(PRISMA)) fail(`Prisma CLI not found at ${PRISMA}. Run npm ci first.`);

  const runDir = process.env.ALEVR_QA_RUN_DIR;
  if (!runDir || !path.isAbsolute(runDir) || !existsSync(runDir) || !statSync(runDir).isDirectory()) {
    fail("ALEVR_QA_RUN_DIR must name this runner's existing temporary directory.");
  }
  const ownershipFile = path.join(runDir, "database.json");
  const name = primary.database;
  // The name already matched /^[a-z][a-z0-9_]*_test$/, so quoting it is safe.
  const dropSql = `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`;
  const maintenance = prismaEnv();

  if (drop) {
    // A failed CREATE must never make teardown drop somebody else's database.
    // Only a successful CREATE below can write this run's ownership record.
    // Read, never check-then-read: the record is the only licence to drop.
    let record;
    try {
      record = readFileSync(ownershipFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        console.error("[qa:db] No database was created by this run; leaving existing databases alone.");
        return;
      }
      fail("The database ownership record is unreadable; refusing to drop anything.");
    }
    let ownership;
    try { ownership = JSON.parse(record); }
    catch { fail("The database ownership record is unreadable; refusing to drop anything."); }
    if (ownership.database !== name) fail("The database does not match this run's ownership record.");
    prisma(["db", "execute", "--url", QA_MAINTENANCE_URL, "--stdin"], { input: dropSql, env: maintenance, label: `drop ${name}` });
    unlinkSync(ownershipFile);
    console.error(`[qa:db] Dropped ${name}.`);
    return;
  }
  // CREATE fails if the name exists. Never reset an earlier run's database.
  // The ownership record below is written with `wx` (exclusive create), so a
  // run that somehow already holds a record cannot overwrite it: the write
  // fails and the database this call just created is dropped again. No
  // separate existence check, which would only race that write.
  prisma(["db", "execute", "--url", QA_MAINTENANCE_URL, "--stdin"], {
    input: `CREATE DATABASE "${name}";`,
    env: maintenance,
    label: `create ${name}`,
  });
  try {
    writeFileSync(ownershipFile, JSON.stringify({ database: name }), { flag: "wx", mode: 0o600 });
  } catch {
    // CREATE succeeded, so this process owns the database even if recording
    // ownership fails. Clean it up immediately rather than leaking it.
    prisma(["db", "execute", "--url", QA_MAINTENANCE_URL, "--stdin"], { input: dropSql, env: maintenance, label: `clean up ${name}` });
    fail("Could not record database ownership.");
  }
  console.error(`[qa:db] Created ${name}. Applying migrations...`);
  const migrate = prisma(["migrate", "deploy"], {
    env: prismaEnv({ DATABASE_URL: String(process.env.DATABASE_URL), DIRECT_URL: String(process.env.DIRECT_URL) }),
    label: "prisma migrate deploy",
  });
  const applied = /(\d+) migrations? found/.exec(migrate.stdout ?? "");
  console.error(`[qa:db] ${name} is migrated${applied ? ` (${applied[1]} migrations)` : ""}.`);
}

main();
