#!/usr/bin/env node

/**
 * Run a disposable, local backup/restore drill.
 *
 * The drill creates a temporary PostgreSQL cluster on loopback, seeds a small
 * deterministic database and object corpus, and then exercises the production
 * backup, verification, and restore scripts. It never needs application or
 * cloud credentials. The temporary cluster and files are removed on exit
 * unless JUNO_RESTORE_DRILL_KEEP=1 is set for local debugging.
 */

import { createHash } from "node:crypto";
import { access, constants, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const requiredCommands = ["initdb", "pg_ctl", "postgres", "createdb", "pg_isready", "psql", "pg_dump", "pg_restore"];
const postgresUser = "juno_restore_drill";
const sourceDatabase = "juno_drill_source";
const targetDatabase = "juno_drill_target";
const drillEnvironmentKeys = [
  "DATABASE_URL",
  "DIRECT_URL",
  "JUNO_BACKUP_DIR",
  "JUNO_BACKUP_CONFIRM",
  "JUNO_UPLOADS_DIR",
  "RESTORE_DATABASE_URL",
  "RESTORE_UPLOADS_DIR",
  "RESTORE_S3_BUCKET",
  "RESTORE_S3_ACCESS_KEY_ID",
  "RESTORE_S3_SECRET_ACCESS_KEY",
  "RESTORE_S3_ENDPOINT",
  "RESTORE_S3_REGION",
  "RESTORE_S3_FORCE_PATH_STYLE",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_FORCE_PATH_STYLE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
];

const expectedRows = [
  { id: 1, kind: "conversation", payload: "A deterministic restore receipt." },
  { id: 2, kind: "attachment", payload: "The database and object stores recover together." },
  { id: 3, kind: "unicode", payload: "é漢字🙂" },
];

const objectFixtures = new Map([
  ["attachments/receipt.txt", Buffer.from("Juno restore drill receipt\nversion=1\n", "utf8")],
  ["attachments/nested/bytes.bin", Buffer.from("00112233445566778899aabbccddeeff", "hex")],
  ["attachments/empty.bin", Buffer.alloc(0)],
]);

function fail(message) {
  throw new Error(message);
}

function pathCandidates(command) {
  const explicitDirectory = process.env.JUNO_PG_BIN_DIR;
  const directories = [];
  if (explicitDirectory) directories.push(path.resolve(explicitDirectory));
  directories.push(...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean));
  return directories.map((directory) => path.join(directory, command));
}

async function findExecutable(command) {
  for (const candidate of pathCandidates(command)) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching PATH.
    }
  }
  return null;
}

async function resolveCommands() {
  const entries = await Promise.all(requiredCommands.map(async (command) => [command, await findExecutable(command)]));
  const commands = Object.fromEntries(entries);
  const missing = requiredCommands.filter((command) => !commands[command]);
  if (missing.length > 0) {
    fail(`Missing local PostgreSQL binaries: ${missing.join(", ")}. Install PostgreSQL server/client tools or set JUNO_PG_BIN_DIR to their bin directory.`);
  }
  return commands;
}

function localChildEnvironment(overrides = {}) {
  const environment = { ...process.env };
  for (const key of drillEnvironmentKeys) delete environment[key];
  return {
    ...environment,
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    ...overrides,
  };
}

function run(command, args, { env = process.env, cwd = repositoryRoot, label = path.basename(command) } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => reject(new Error(`${label} could not start: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const detail = stderr.trim().split("\n").slice(-8).join(" ").slice(-1200);
      reject(new Error(`${label} failed${signal ? ` with signal ${signal}` : ` with exit code ${code ?? "unknown"}`}${detail ? `: ${detail}` : "."}`));
    });
  });
}

function scriptEnvironment(overrides) {
  return localChildEnvironment({
    DATABASE_URL: "",
    DIRECT_URL: "",
    S3_BUCKET: "",
    S3_ACCESS_KEY_ID: "",
    S3_SECRET_ACCESS_KEY: "",
    RESTORE_S3_BUCKET: "",
    RESTORE_S3_ACCESS_KEY_ID: "",
    RESTORE_S3_SECRET_ACCESS_KEY: "",
    ...overrides,
  });
}

async function runNodeScript(scriptName, environment) {
  return run(process.execPath, [path.join(repositoryRoot, "scripts", scriptName)], {
    env: scriptEnvironment(environment),
    label: scriptName,
  });
}

async function allocatePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else if (!port) reject(new Error("Could not allocate a local PostgreSQL port."));
        else resolve(port);
      });
    });
  });
}

function databaseUrl(port, database) {
  return `postgresql://${postgresUser}@127.0.0.1:${port}/${database}?sslmode=disable`;
}

function postgresArgs(port, database) {
  return ["--host", "127.0.0.1", "--port", String(port), "--username", postgresUser, "--dbname", database];
}

function createdbArgs(port, database) {
  return ["--host", "127.0.0.1", "--port", String(port), "--username", postgresUser, database];
}

async function runSql(commands, port, database, sql) {
  const result = await run(commands.psql, [
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    "--quiet",
    ...postgresArgs(port, database),
    "--command",
    sql,
  ], { env: localChildEnvironment(), label: `psql ${database}` });
  return result.stdout.trim();
}

async function createFixtureObjects(directory) {
  for (const [storageKey, bytes] of objectFixtures) {
    const destination = path.join(directory, storageKey);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
  }
}

async function digestFile(filePath) {
  const bytes = await readFile(filePath);
  return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function listFiles(directory, prefix = "") {
  const files = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    const storageKey = prefix ? `${prefix}/${entry.name}` : entry.name;
    const source = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listFiles(source, storageKey));
    } else if (entry.isFile()) {
      files.push(storageKey);
    } else {
      fail(`Restore target contains a non-file object: ${storageKey}`);
    }
  }
  return files;
}

async function assertRestoredObjects(targetDirectory, manifest) {
  const expectedKeys = manifest.objects.map((object) => object.storageKey).sort();
  const actualKeys = (await listFiles(targetDirectory)).sort();
  assert.deepEqual(actualKeys, expectedKeys, "restored object key set must exactly match the backup manifest");
  for (const object of manifest.objects) {
    const actual = await digestFile(path.join(targetDirectory, object.storageKey));
    assert.deepEqual(actual, { bytes: object.bytes, sha256: object.sha256 }, `restored object digest: ${object.storageKey}`);
  }
}

async function main() {
  const commands = await resolveCommands();
  const keepWorkspace = process.env.JUNO_RESTORE_DRILL_KEEP === "1";
  const port = await allocatePort();
  const workspace = await mkdtemp(path.join(tmpdir(), "juno-restore-drill-"));
  const clusterDirectory = path.join(workspace, "postgres");
  const socketDirectory = path.join(workspace, "socket");
  const sourceUploads = path.join(workspace, "source-uploads");
  const targetUploads = path.join(workspace, "restored-uploads");
  const backupDirectory = path.join(workspace, "backup");
  const logFile = path.join(workspace, "postgres.log");
  const sourceUrl = databaseUrl(port, sourceDatabase);
  const targetUrl = databaseUrl(port, targetDatabase);
  let serverStarted = false;

  try {
    await mkdir(socketDirectory, { recursive: true });
    await mkdir(sourceUploads, { recursive: true });
    await mkdir(targetUploads, { recursive: true });
    await createFixtureObjects(sourceUploads);

    await run(commands.initdb, ["--no-locale", "--encoding=UTF8", "--auth=trust", "--username", postgresUser, "--pgdata", clusterDirectory], {
      env: localChildEnvironment(),
      label: "initdb",
    });
    await run(commands.pg_ctl, [
      "--pgdata", clusterDirectory,
      "--options", `-p ${port} -h 127.0.0.1 -k ${socketDirectory}`,
      "--log", logFile,
      "--wait",
      "start",
    ], { env: localChildEnvironment(), label: "pg_ctl start" });
    serverStarted = true;

    await run(commands.createdb, createdbArgs(port, sourceDatabase), { env: localChildEnvironment(), label: "createdb source" });
    await run(commands.createdb, createdbArgs(port, targetDatabase), { env: localChildEnvironment(), label: "createdb target" });
    await run(commands.pg_isready, ["--host", "127.0.0.1", "--port", String(port), "--username", postgresUser], {
      env: localChildEnvironment(),
      label: "pg_isready",
    });

    await runSql(commands, port, sourceDatabase, `
      CREATE TABLE restore_drill_records (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      INSERT INTO restore_drill_records (id, kind, payload) VALUES
        (1, 'conversation', 'A deterministic restore receipt.'),
        (2, 'attachment', 'The database and object stores recover together.'),
        (3, 'unicode', 'é漢字🙂');
    `);
    await runSql(commands, port, targetDatabase, `
      CREATE TABLE restore_drill_records (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      INSERT INTO restore_drill_records (id, kind, payload) VALUES
        (999, 'stale', 'This row must be replaced by the restore.');
    `);

    const sourceRows = JSON.parse(await runSql(commands, port, sourceDatabase, "SELECT COALESCE(json_agg(json_build_object('id', id, 'kind', kind, 'payload', payload) ORDER BY id)::text, '[]') FROM restore_drill_records;"));
    assert.deepEqual(sourceRows, expectedRows, "seed database must match the deterministic fixture");

    await runNodeScript("backup-production.mjs", {
      DIRECT_URL: sourceUrl,
      DATABASE_URL: "",
      JUNO_BACKUP_CONFIRM: "CREATE_BACKUP",
      JUNO_BACKUP_DIR: backupDirectory,
      JUNO_UPLOADS_DIR: sourceUploads,
    });
    await runNodeScript("verify-backup.mjs", { JUNO_BACKUP_DIR: backupDirectory });

    const manifest = JSON.parse(await readFile(path.join(backupDirectory, "backup-manifest.json"), "utf8"));
    assert.equal(manifest.storage.kind, "local", "the local drill must not select cloud storage");
    assert.deepEqual(manifest.objects.map((object) => object.storageKey).sort(), [...objectFixtures.keys()].sort(), "backup must include every fixture object");

    await runNodeScript("restore-production.mjs", {
      JUNO_RESTORE_CONFIRM: "RESTORE_TO_SCRATCH",
      JUNO_BACKUP_DIR: backupDirectory,
      RESTORE_DATABASE_URL: targetUrl,
      RESTORE_UPLOADS_DIR: targetUploads,
      DIRECT_URL: sourceUrl,
      DATABASE_URL: "",
      JUNO_UPLOADS_DIR: sourceUploads,
    });

    const restoredRows = JSON.parse(await runSql(commands, port, targetDatabase, "SELECT COALESCE(json_agg(json_build_object('id', id, 'kind', kind, 'payload', payload) ORDER BY id)::text, '[]') FROM restore_drill_records;"));
    assert.deepEqual(restoredRows, expectedRows, "restored database rows must exactly match the source");
    await assertRestoredObjects(targetUploads, manifest);
    await runNodeScript("verify-backup.mjs", { JUNO_BACKUP_DIR: backupDirectory });

    console.log(`Restore drill passed: ${expectedRows.length} database rows and ${manifest.objects.length} objects restored with matching integrity.`);
    if (keepWorkspace) console.log(`Restore drill workspace retained: ${workspace}`);
  } finally {
    if (serverStarted) {
      try {
        await run(commands.pg_ctl, ["--pgdata", clusterDirectory, "--mode", "fast", "--wait", "stop"], {
          env: localChildEnvironment(),
          label: "pg_ctl stop",
        });
      } catch (error) {
        console.error(`Restore drill cleanup warning: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (!keepWorkspace) await rm(workspace, { recursive: true, force: true });
  }
}

if (process.argv.includes("--check")) {
  resolveCommands()
    .then((commands) => console.log(`Local PostgreSQL restore-drill prerequisites available: ${requiredCommands.map((command) => commands[command]).join(", ")}`))
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
} else {
  main().catch((error) => {
    console.error(`Restore drill failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
