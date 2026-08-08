#!/usr/bin/env node

/**
 * Restore a backup into an explicitly non-production target.
 *
 * The guard is intentionally strict: this command can replace the target
 * database schema and object bytes. A scratch database and scratch bucket are
 * required, and production-looking hostnames are refused.
 */

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { ListObjectsV2Command, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const confirmation = "RESTORE_TO_SCRATCH";
const backupDir = path.resolve(process.env.JUNO_BACKUP_DIR ?? "");
const targetDatabaseUrl = process.env.RESTORE_DATABASE_URL || "";

function fail(message) {
  throw new Error(message);
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertSafeRelativePath(value, label) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty relative path.`);
  if (value.includes("\0")) fail(`${label} contains a NUL byte.`);
  if (value.includes("\\")) fail(`${label} must use forward-slash path separators.`);
  if (path.isAbsolute(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value) || /^[A-Za-z]:/.test(value)) {
    fail(`${label} must be a relative path.`);
  }
  if (value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    fail(`${label} contains traversal or empty path segments.`);
  }
  return value;
}

function resolveInside(root, value, label) {
  const safeValue = assertSafeRelativePath(value, label);
  const candidate = path.resolve(root, safeValue);
  if (!isPathInside(root, candidate)) fail(`${label} escapes its allowed directory.`);
  return candidate;
}

function assertIntegrityMetadata(value, label) {
  if (!Number.isSafeInteger(value?.bytes) || value.bytes < 0) fail(`${label}.bytes is invalid.`);
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256)) fail(`${label}.sha256 is invalid.`);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || manifest.schemaVersion !== 1) {
    fail("Unsupported or malformed backup manifest.");
  }
  if (!manifest.database || typeof manifest.database !== "object" || Array.isArray(manifest.database)) {
    fail("Backup manifest database entry is missing.");
  }
  if (!Array.isArray(manifest.objects)) fail("Backup manifest objects entry is missing.");
  if (!manifest.storage || typeof manifest.storage !== "object" || manifest.storage.objectCount !== manifest.objects.length) {
    fail("Backup manifest object count is invalid.");
  }

  assertSafeRelativePath(manifest.database.file, "manifest.database.file");
  assertIntegrityMetadata(manifest.database, "manifest.database");
  manifest.objects.forEach((object, index) => {
    const label = `manifest.objects[${index}]`;
    if (!object || typeof object !== "object" || Array.isArray(object)) fail(`${label} is invalid.`);
    assertSafeRelativePath(object.storageKey, `${label}.storageKey`);
    assertSafeRelativePath(object.relativePath, `${label}.relativePath`);
    assertIntegrityMetadata(object, label);
  });
  return manifest;
}

async function resolveBackupFile(backupRoot, relativePath, label) {
  const candidate = resolveInside(backupRoot, relativePath, label);
  let resolved;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") fail(`${label} does not exist inside the backup directory.`);
    throw error;
  }
  if (!isPathInside(backupRoot, resolved)) fail(`${label} escapes the backup directory.`);
  return resolved;
}

async function requireEmptyLocalTarget(targetDirectory) {
  let details;
  try {
    details = await lstat(targetDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") fail("RESTORE_UPLOADS_DIR must point to an existing empty directory.");
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    fail("RESTORE_UPLOADS_DIR must point to a real directory, not a file or symlink.");
  }
  if ((await readdir(targetDirectory)).length > 0) {
    fail("RESTORE_UPLOADS_DIR must be empty before restore.");
  }
  return realpath(targetDirectory);
}

async function requireEmptyS3Target(target) {
  const page = await target.client.send(new ListObjectsV2Command({ Bucket: target.bucket, MaxKeys: 1 }));
  if ((page.Contents?.length ?? 0) > 0 || page.IsTruncated === true) {
    fail("RESTORE_S3_BUCKET must be empty before restore.");
  }
}

function targetS3Config() {
  const { RESTORE_S3_BUCKET: bucket, RESTORE_S3_ACCESS_KEY_ID: accessKeyId, RESTORE_S3_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!bucket && !accessKeyId && !secretAccessKey) return null;
  if (!bucket || !accessKeyId || !secretAccessKey) fail("RESTORE_S3_BUCKET, RESTORE_S3_ACCESS_KEY_ID and RESTORE_S3_SECRET_ACCESS_KEY must be configured together.");
  return {
    bucket,
    client: new S3Client({
      region: process.env.RESTORE_S3_REGION || "auto",
      endpoint: process.env.RESTORE_S3_ENDPOINT || undefined,
      forcePathStyle: process.env.RESTORE_S3_FORCE_PATH_STYLE === "true",
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

async function digest(filePath) {
  const bytes = await readFile(filePath);
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", (error) => reject(new Error(`${command} could not start: ${error.message}`)));
    child.once("exit", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`${command} failed with exit code ${code ?? "unknown"}: ${stderr.trim().slice(-500)}`));
    });
  });
}

async function main() {
  if (process.env.JUNO_RESTORE_CONFIRM !== confirmation) fail(`Set JUNO_RESTORE_CONFIRM=${confirmation} after reviewing the restore runbook.`);
  if (!backupDir || backupDir === path.resolve(".")) fail("JUNO_BACKUP_DIR must point to an explicit backup directory.");
  if (!targetDatabaseUrl) fail("RESTORE_DATABASE_URL is required; the value is never printed.");
  let hostname;
  try {
    hostname = new URL(targetDatabaseUrl).hostname.toLowerCase();
  } catch {
    fail("RESTORE_DATABASE_URL must be a valid database URL.");
  }
  if (hostname === "chat.liams.dev" || /(^|[.-])(prod|production)([.-]|$)/.test(hostname)) fail("Refusing a production-looking restore database target.");
  if (targetDatabaseUrl === process.env.DIRECT_URL || targetDatabaseUrl === process.env.DATABASE_URL) {
    fail("Refusing to restore onto the configured application database.");
  }

  let backupRoot;
  try {
    backupRoot = await realpath(backupDir);
  } catch (error) {
    if (error?.code === "ENOENT") fail("JUNO_BACKUP_DIR must point to an existing backup directory.");
    throw error;
  }
  const manifestPath = resolveInside(backupRoot, "backup-manifest.json", "backup manifest");
  const manifest = validateManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  const databaseFile = await resolveBackupFile(backupRoot, manifest.database.file, "manifest.database.file");
  const database = await digest(databaseFile);
  if (database.bytes.byteLength !== manifest.database.bytes || database.sha256 !== manifest.database.sha256) fail("Backup database dump failed integrity verification.");

  const targetS3 = targetS3Config();
  let targetLocalRoot = null;
  if (targetS3) {
    if (targetS3.bucket === process.env.S3_BUCKET) {
      fail("Refusing to restore onto the configured application bucket.");
    }
    await requireEmptyS3Target(targetS3);
  } else {
    const targetLocal = path.resolve(process.env.RESTORE_UPLOADS_DIR ?? "");
    if (!process.env.RESTORE_UPLOADS_DIR || targetLocal === path.resolve(".")) fail("RESTORE_UPLOADS_DIR is required for a local-storage restore.");
    const configuredUploads = path.resolve(process.env.JUNO_UPLOADS_DIR ?? path.join(process.cwd(), ".uploads"));
    if (targetLocal === configuredUploads || isPathInside(targetLocal, configuredUploads) || isPathInside(configuredUploads, targetLocal)) {
      fail("Refusing to restore onto the configured application uploads directory.");
    }
    targetLocalRoot = await requireEmptyLocalTarget(targetLocal);
    let configuredUploadsRoot = configuredUploads;
    try {
      configuredUploadsRoot = await realpath(configuredUploads);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (targetLocalRoot === configuredUploadsRoot || isPathInside(targetLocalRoot, configuredUploadsRoot) || isPathInside(configuredUploadsRoot, targetLocalRoot)) {
      fail("Refusing to restore onto the configured application uploads directory.");
    }
  }

  const objectsToRestore = [];
  for (const [index, object] of manifest.objects.entries()) {
    const filePath = await resolveBackupFile(backupRoot, object.relativePath, `manifest.objects[${index}].relativePath`);
    const destination = targetS3 ? null : resolveInside(targetLocalRoot, object.storageKey, `manifest.objects[${index}].storageKey`);
    const { bytes, sha256 } = await digest(filePath);
    if (bytes.byteLength !== object.bytes || sha256 !== object.sha256) fail(`Backup object failed integrity verification: ${object.storageKey}`);
    objectsToRestore.push({ bytes, destination, object });
  }

  for (const { bytes, destination, object } of objectsToRestore) {
    if (targetS3) {
      await targetS3.client.send(new PutObjectCommand({ Bucket: targetS3.bucket, Key: object.storageKey, Body: bytes }));
    } else {
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
  }

  await run("pg_restore", ["--exit-on-error", "--clean", "--if-exists", "--no-owner", "--no-acl", "--dbname", targetDatabaseUrl, databaseFile]);
  console.log(`Scratch restore completed: ${manifest.objects.length} objects and the database dump were restored.`);
}

main().catch((error) => {
  console.error(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
