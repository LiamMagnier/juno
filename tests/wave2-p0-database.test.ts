import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const url = "postgresql://postgres@127.0.0.1:55439/alevr_ownership_test";
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "alevr-qa-db-"));
  for (const sub of ["scripts/qa/lib", "node_modules/.bin", "run"]) mkdirSync(path.join(dir, sub), { recursive: true });
  for (const file of ["ensure-test-db.mjs", "lib/safe-env.mjs"]) cpSync(path.join(root, "scripts/qa", file), path.join(dir, "scripts/qa", file));
  const cli = path.join(dir, "node_modules/.bin/prisma");
  writeFileSync(cli, `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const sql = fs.readFileSync(0, "utf8");
fs.appendFileSync(path.join(root, "calls.jsonl"), JSON.stringify({ args: process.argv.slice(2), sql }) + "\\n");
if (sql.startsWith("CREATE") && fs.existsSync(path.join(root, "fail-create"))) process.exit(1);
if (sql.startsWith("DROP") && fs.existsSync(path.join(root, "fail-drop"))) process.exit(1);
if (process.argv.includes("migrate") && fs.existsSync(path.join(root, "fail-migrate"))) process.exit(1);
`);
  chmodSync(cli, 0o755);
  return {
    dir,
    ownership: path.join(dir, "run/database.json"),
    run(args: string[] = [], extra: Record<string, string> = {}) {
      return spawnSync(process.execPath, [path.join(dir, "scripts/qa/ensure-test-db.mjs"), ...args], {
        cwd: dir,
        env: { PATH: process.env.PATH, HOME: dir, NODE_ENV: "test", DATABASE_URL: url, DIRECT_URL: url, ALEVR_QA_RUN_DIR: path.join(dir, "run"), ...extra },
        encoding: "utf8",
        timeout: 10_000,
      });
    },
    calls(): { args: string[]; sql: string }[] {
      const log = path.join(dir, "calls.jsonl");
      return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
    },
    cleanup() { rmSync(dir, { recursive: true, force: true }); },
  };
}

test("a failed CREATE never resets or drops an existing database", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.dir, "fail-create"), "");
    assert.notEqual(f.run().status, 0);
    assert.equal(existsSync(f.ownership), false);
    assert.equal(f.run(["--drop"]).status, 0);
    assert.equal(f.calls().length, 1);
    assert.match(f.calls()[0].sql, /^CREATE DATABASE/);
  } finally { f.cleanup(); }
});

test("successful creation records ownership and teardown drops it once", () => {
  const f = fixture();
  try {
    const run = f.run();
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(readFileSync(f.ownership, "utf8")), { database: "alevr_ownership_test" });
    assert.equal(f.run(["--drop"]).status, 0);
    assert.equal(existsSync(f.ownership), false);
    assert.equal(f.run(["--drop"]).status, 0);
    const calls = f.calls();
    assert.equal(calls.length, 3);
    assert.match(calls[0].sql, /^CREATE DATABASE/);
    assert.deepEqual(calls[1].args, ["migrate", "deploy"]);
    assert.match(calls[2].sql, /^DROP DATABASE IF EXISTS "alevr_ownership_test"/);
  } finally { f.cleanup(); }
});

test("a migration failure keeps ownership so the runner can clean up its database", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.dir, "fail-migrate"), "");
    assert.notEqual(f.run().status, 0);
    assert.equal(existsSync(f.ownership), true);
    assert.equal(f.run(["--drop"]).status, 0);
    assert.match(f.calls().at(-1)!.sql, /^DROP DATABASE/);
  } finally { f.cleanup(); }
});

test("teardown refuses a database different from the recorded owner", () => {
  const f = fixture();
  try {
    writeFileSync(f.ownership, JSON.stringify({ database: "another_test" }));
    assert.notEqual(f.run(["--drop"]).status, 0);
    assert.deepEqual(f.calls(), []);
    assert.equal(existsSync(f.ownership), true);
  } finally { f.cleanup(); }
});

test("database changes require the runner's existing temporary directory", () => {
  const f = fixture();
  try {
    const run = f.run([], { ALEVR_QA_RUN_DIR: "" });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /ALEVR_QA_RUN_DIR/);
    assert.deepEqual(f.calls(), []);
  } finally { f.cleanup(); }
});

test("a failed drop retains ownership so cleanup can be retried", () => {
  const f = fixture();
  try {
    assert.equal(f.run().status, 0);
    writeFileSync(path.join(f.dir, "fail-drop"), "");
    assert.notEqual(f.run(["--drop"]).status, 0);
    assert.equal(existsSync(f.ownership), true);
    rmSync(path.join(f.dir, "fail-drop"));
    assert.equal(f.run(["--drop"]).status, 0);
    assert.equal(existsSync(f.ownership), false);
  } finally { f.cleanup(); }
});

test("the direct database helper refuses dotenv files before invoking Prisma", () => {
  const f = fixture();
  try {
    writeFileSync(path.join(f.dir, ".env.local"), "DATABASE_URL=postgresql://fake.example/production");
    assert.notEqual(f.run().status, 0);
    assert.deepEqual(f.calls(), []);
  } finally { f.cleanup(); }
});

test("a run that already holds an ownership record never overwrites it: the new database is dropped again", () => {
  // The exclusive (`wx`) write is the guard now, not a separate existence check
  // that could race it (CodeQL js/file-system-race on PR #99).
  const f = fixture();
  try {
    writeFileSync(f.ownership, JSON.stringify({ database: "alevr_ownership_test" }));
    const run = f.run();
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Could not record database ownership/);
    assert.deepEqual(JSON.parse(readFileSync(f.ownership, "utf8")), { database: "alevr_ownership_test" }, "the existing record is untouched");
    const calls = f.calls();
    assert.equal(calls.length, 2);
    assert.match(calls[0].sql, /^CREATE DATABASE/);
    assert.match(calls[1].sql, /^DROP DATABASE IF EXISTS "alevr_ownership_test"/);
    assert.ok(!calls.some((call) => call.args.includes("migrate")), "nothing is migrated into a database this run does not own");
  } finally { f.cleanup(); }
});

test("an unreadable ownership record refuses the drop", () => {
  const f = fixture();
  try {
    writeFileSync(f.ownership, "{not json");
    const run = f.run(["--drop"]);
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /unreadable; refusing to drop anything/);
    assert.deepEqual(f.calls(), []);
  } finally { f.cleanup(); }
});
