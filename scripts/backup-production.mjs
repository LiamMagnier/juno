#!/usr/bin/env node

/**
 * Create a restorable PostgreSQL + object-storage backup.
 *
 * This script is intentionally explicit because a backup contains the whole
 * account corpus. It never prints connection strings or object contents, and
 * it refuses to run without a human-readable confirmation token.
 */

import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

const confirmation = "CREATE_BACKUP";
const backupDir = path.resolve(process.env.JUNO_BACKUP_DIR ?? "");
const uploadsDir = path.resolve(process.env.JUNO_UPLOADS_DIR ?? path.join(process.cwd(), ".uploads"));
const databaseUrl = process.env.DIRECT_URL || process.env.DATABASE_URL || "";

function fail(message) {
  throw new Error(message);
}

function requireEnvironment() {
  if (process.env.JUNO_BACKUP_CONFIRM !== confirmation) {
    fail(`Set JUNO_BACKUP_CONFIRM=${confirmation} after reviewing the backup runbook.`);
  }
  if (!backupDir || backupDir === path.resolve(".")) fail("JUNO_BACKUP_DIR must point to an explicit backup directory.");
  if (!databaseUrl) fail("DIRECT_URL or DATABASE_URL is required; the value is never printed.");
}

async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
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

function s3Config() {
  const { S3_BUCKET: bucket, S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey } = process.env;
  if (!bucket && !accessKeyId && !secretAccessKey) return null;
  if (!bucket || !accessKeyId || !secretAccessKey) fail("S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be configured together.");
  return {
    bucket,
    client: new S3Client({
      region: process.env.S3_REGION || "auto",
      endpoint: process.env.S3_ENDPOINT || undefined,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: { accessKeyId, secretAccessKey },
    }),
  };
}

function safeRelativeObjectPath(storageKey) {
  const normalized = storageKey.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    fail("Storage returned an unsafe object key.");
  }
  return path.join("objects", normalized);
}

async function backupLocalObjects(objectsDir) {
  const objects = [];
  async function visit(directory, prefix = "") {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const source = path.join(directory, entry.name);
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(source, key);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = safeRelativeObjectPath(key);
      const destination = path.join(objectsDir, relativePath.slice("objects/".length));
      await mkdir(path.dirname(destination), { recursive: true });
      const bytes = await readFile(source);
      await writeFile(destination, bytes, { flag: "wx" });
      objects.push({ storageKey: key, relativePath, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
  await visit(uploadsDir);
  return objects;
}

async function backupS3Objects(objectsDir, config) {
  const objects = [];
  let continuationToken;
  do {
    const listed = await config.client.send(new ListObjectsV2Command({ Bucket: config.bucket, ContinuationToken: continuationToken }));
    for (const item of listed.Contents ?? []) {
      if (!item.Key) continue;
      const relativePath = safeRelativeObjectPath(item.Key);
      const destination = path.join(objectsDir, relativePath.slice("objects/".length));
      await mkdir(path.dirname(destination), { recursive: true });
      const object = await config.client.send(new GetObjectCommand({ Bucket: config.bucket, Key: item.Key }));
      const bytes = await object.Body.transformToByteArray();
      await writeFile(destination, bytes, { flag: "wx" });
      objects.push({ storageKey: item.Key, relativePath, bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
    }
    continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (continuationToken);
  return objects;
}

async function main() {
  requireEnvironment();
  await mkdir(backupDir, { recursive: true });
  const databaseDump = path.join(backupDir, "database.dump");
  const objectsDir = path.join(backupDir, "objects");
  await mkdir(objectsDir, { recursive: true });
  await run("pg_dump", ["--format=custom", "--no-owner", "--no-acl", "--file", databaseDump, "--dbname", databaseUrl]);

  const s3 = s3Config();
  const storageKind = s3 ? "s3" : "local";
  const objects = s3 ? await backupS3Objects(objectsDir, s3) : await backupLocalObjects(objectsDir);
  const database = await sha256File(databaseDump);
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    database: { file: "database.dump", ...database },
    storage: { kind: storageKind, objectCount: objects.length },
    objects,
  };
  await writeFile(path.join(backupDir, "backup-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(`Backup created: ${backupDir}`);
  console.log(`Database: ${database.bytes} bytes, SHA-256 ${database.sha256}`);
  console.log(`Objects: ${objects.length} (${storageKind})`);
}

main().catch((error) => {
  console.error(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
