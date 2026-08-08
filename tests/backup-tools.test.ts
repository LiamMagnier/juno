import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const BACKUP_SOURCE = readFileSync(new URL("../scripts/backup-production.mjs", import.meta.url), "utf8");
const VERIFY_SOURCE = readFileSync(new URL("../scripts/verify-backup.mjs", import.meta.url), "utf8");
const RESTORE_SOURCE = readFileSync(new URL("../scripts/restore-production.mjs", import.meta.url), "utf8");
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const restoreScript = path.join(repositoryRoot, "scripts", "restore-production.mjs");

type FixtureOverrides = {
  databaseFile?: string;
  storageKey?: string;
  relativePath?: string;
};

type RestoreFixtureManifest = ReturnType<typeof restoreFixtureManifest>;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function restoreFixtureManifest(overrides: FixtureOverrides = {}) {
  const databaseBytes = Buffer.from("deterministic database dump fixture\n", "utf8");
  const objectBytes = Buffer.from("deterministic object fixture\n", "utf8");
  return {
    schemaVersion: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    database: {
      file: overrides.databaseFile ?? "database.dump",
      bytes: databaseBytes.byteLength,
      sha256: sha256(databaseBytes),
    },
    storage: { kind: "local", objectCount: 1 },
    objects: [{
      storageKey: overrides.storageKey ?? "fixture.txt",
      relativePath: overrides.relativePath ?? "objects/fixture.txt",
      bytes: objectBytes.byteLength,
      sha256: sha256(objectBytes),
    }],
  };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function runRestoreFixture({
  manifest = restoreFixtureManifest(),
  createTarget = true,
  nonEmptyTarget = false,
}: {
  manifest?: RestoreFixtureManifest;
  createTarget?: boolean;
  nonEmptyTarget?: boolean;
} = {}) {
  const workspace = await mkdtemp(path.join(tmpdir(), "juno-restore-security-"));
  const backupDirectory = path.join(workspace, "backup");
  const targetDirectory = path.join(workspace, "restore-target");
  try {
    await mkdir(path.join(backupDirectory, "objects"), { recursive: true });
    if (createTarget) await mkdir(targetDirectory);
    if (nonEmptyTarget) await writeFile(path.join(targetDirectory, "sentinel.txt"), "must remain untouched\n");
    await writeFile(path.join(backupDirectory, "database.dump"), "deterministic database dump fixture\n");
    await writeFile(path.join(backupDirectory, "objects", "fixture.txt"), "deterministic object fixture\n");
    await writeFile(path.join(backupDirectory, "backup-manifest.json"), `${JSON.stringify(manifest)}\n`);

    const result = spawnSync(process.execPath, [restoreScript], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        JUNO_RESTORE_CONFIRM: "RESTORE_TO_SCRATCH",
        JUNO_BACKUP_DIR: backupDirectory,
        RESTORE_DATABASE_URL: "postgresql://127.0.0.1:65432/juno_restore",
        RESTORE_UPLOADS_DIR: targetDirectory,
        DIRECT_URL: "",
        DATABASE_URL: "",
        JUNO_UPLOADS_DIR: path.join(workspace, "application-uploads"),
        S3_BUCKET: "",
        RESTORE_S3_BUCKET: "",
        RESTORE_S3_ACCESS_KEY_ID: "",
        RESTORE_S3_SECRET_ACCESS_KEY: "",
      },
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    let targetEntries = null;
    try {
      targetEntries = (await readdir(targetDirectory)).sort();
    } catch (error: unknown) {
      if (!hasErrorCode(error, "ENOENT")) throw error;
    }
    return { output, status: result.status, targetEntries };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

test("backup tooling records database and object integrity without exposing credentials", () => {
  assert.match(BACKUP_SOURCE, /JUNO_BACKUP_CONFIRM/);
  assert.match(BACKUP_SOURCE, /pg_dump/);
  assert.match(BACKUP_SOURCE, /format=custom/);
  assert.match(BACKUP_SOURCE, /backup-manifest\.json/);
  assert.match(BACKUP_SOURCE, /createHash\("sha256"\)/);
  assert.doesNotMatch(BACKUP_SOURCE, /console\.log\([^)]*(?:databaseUrl|secretAccessKey|accessKeyId)/);
  assert.match(VERIFY_SOURCE, /manifest\.database\.sha256/);
  assert.match(VERIFY_SOURCE, /object\.sha256/);
});

test("restore tooling requires scratch confirmation and rejects production targets", () => {
  assert.match(RESTORE_SOURCE, /JUNO_RESTORE_CONFIRM/);
  assert.match(RESTORE_SOURCE, /RESTORE_TO_SCRATCH/);
  assert.match(RESTORE_SOURCE, /chat\.liams\.dev/);
  assert.match(RESTORE_SOURCE, /production-looking restore database target/);
  assert.match(RESTORE_SOURCE, /configured application database/);
  assert.match(RESTORE_SOURCE, /configured application bucket/);
  assert.match(RESTORE_SOURCE, /RESTORE_UPLOADS_DIR must be empty before restore/);
  assert.match(RESTORE_SOURCE, /RESTORE_UPLOADS_DIR must point to an existing empty directory/);
  assert.match(RESTORE_SOURCE, /ListObjectsV2Command/);
  assert.match(RESTORE_SOURCE, /manifest\.objects\[\$\{index\}\]\.storageKey/);
  assert.match(RESTORE_SOURCE, /escapes the backup directory/);
  assert.match(RESTORE_SOURCE, /pg_restore/);
  assert.match(RESTORE_SOURCE, /--clean/);
});

test("restore rejects traversal and absolute paths in untrusted manifests before writing objects", async () => {
  const cases = [
    {
      name: "database traversal",
      manifest: restoreFixtureManifest({ databaseFile: "../database.dump" }),
      error: /manifest\.database\.file contains traversal or empty path segments/,
    },
    {
      name: "database absolute path",
      manifest: restoreFixtureManifest({ databaseFile: "/tmp/database.dump" }),
      error: /manifest\.database\.file must be a relative path/,
    },
    {
      name: "object source traversal",
      manifest: restoreFixtureManifest({ relativePath: "objects/../outside" }),
      error: /manifest\.objects\[0\]\.relativePath contains traversal or empty path segments/,
    },
    {
      name: "object source absolute path",
      manifest: restoreFixtureManifest({ relativePath: "/tmp/outside" }),
      error: /manifest\.objects\[0\]\.relativePath must be a relative path/,
    },
    {
      name: "object key traversal",
      manifest: restoreFixtureManifest({ storageKey: "nested/../../outside" }),
      error: /manifest\.objects\[0\]\.storageKey contains traversal or empty path segments/,
    },
    {
      name: "object key absolute path",
      manifest: restoreFixtureManifest({ storageKey: "/tmp/outside" }),
      error: /manifest\.objects\[0\]\.storageKey must be a relative path/,
    },
    {
      name: "object key Windows absolute path",
      manifest: restoreFixtureManifest({ storageKey: "C:\\outside" }),
      error: /manifest\.objects\[0\]\.storageKey must use forward-slash path separators/,
    },
  ];

  for (const testCase of cases) {
    const result = await runRestoreFixture({ manifest: testCase.manifest });
    assert.notEqual(result.status, 0, testCase.name);
    assert.match(result.output, testCase.error, testCase.name);
    assert.deepEqual(result.targetEntries, [], `${testCase.name}: target must remain empty`);
  }
});

test("restore requires a pre-created empty local object target", async () => {
  const nonEmpty = await runRestoreFixture({ nonEmptyTarget: true });
  assert.notEqual(nonEmpty.status, 0);
  assert.match(nonEmpty.output, /RESTORE_UPLOADS_DIR must be empty before restore/);
  assert.deepEqual(nonEmpty.targetEntries, ["sentinel.txt"]);

  const missing = await runRestoreFixture({ createTarget: false });
  assert.notEqual(missing.status, 0);
  assert.match(missing.output, /RESTORE_UPLOADS_DIR must point to an existing empty directory/);
  assert.equal(missing.targetEntries, null);
});
