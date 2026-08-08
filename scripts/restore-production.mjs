#!/usr/bin/env node

/**
 * Restore a backup into an explicitly non-production target.
 *
 * The guard is intentionally strict: this command can replace the target
 * database schema and object bytes. A scratch database and scratch bucket are
 * required, and production-looking hostnames are refused.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const confirmation = "RESTORE_TO_SCRATCH";
const backupDir = path.resolve(process.env.JUNO_BACKUP_DIR ?? "");
const targetDatabaseUrl = process.env.RESTORE_DATABASE_URL || "";

function fail(message) {
  throw new Error(message);
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
  const hostname = new URL(targetDatabaseUrl).hostname.toLowerCase();
  if (hostname === "chat.liams.dev" || /(^|[.-])(prod|production)([.-]|$)/.test(hostname)) fail("Refusing a production-looking restore database target.");
  if (targetDatabaseUrl === process.env.DIRECT_URL || targetDatabaseUrl === process.env.DATABASE_URL) {
    fail("Refusing to restore onto the configured application database.");
  }

  const manifest = JSON.parse(await readFile(path.join(backupDir, "backup-manifest.json"), "utf8"));
  const database = await digest(path.join(backupDir, manifest.database.file));
  if (database.bytes.byteLength !== manifest.database.bytes || database.sha256 !== manifest.database.sha256) fail("Backup database dump failed integrity verification.");

  const targetS3 = targetS3Config();
  const targetLocal = targetS3 ? null : path.resolve(process.env.RESTORE_UPLOADS_DIR ?? "");
  if (!targetS3 && (!targetLocal || targetLocal === path.resolve("."))) fail("RESTORE_UPLOADS_DIR is required for a local-storage restore.");
  if (targetLocal && targetLocal === path.resolve(process.env.JUNO_UPLOADS_DIR ?? path.join(process.cwd(), ".uploads"))) {
    fail("Refusing to restore onto the configured application uploads directory.");
  }
  if (targetS3 && targetS3.bucket === process.env.S3_BUCKET) {
    fail("Refusing to restore onto the configured application bucket.");
  }
  for (const object of manifest.objects) {
    const filePath = path.join(backupDir, object.relativePath);
    const { bytes, sha256 } = await digest(filePath);
    if (bytes.byteLength !== object.bytes || sha256 !== object.sha256) fail(`Backup object failed integrity verification: ${object.storageKey}`);
    if (targetS3) {
      await targetS3.client.send(new PutObjectCommand({ Bucket: targetS3.bucket, Key: object.storageKey, Body: bytes }));
    } else {
      const destination = path.join(targetLocal, object.storageKey);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, bytes);
    }
  }

  await run("pg_restore", ["--exit-on-error", "--clean", "--if-exists", "--no-owner", "--no-acl", "--dbname", targetDatabaseUrl, path.join(backupDir, manifest.database.file)]);
  console.log(`Scratch restore completed: ${manifest.objects.length} objects and the database dump were restored.`);
}

main().catch((error) => {
  console.error(`Restore failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
