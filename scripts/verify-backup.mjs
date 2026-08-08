#!/usr/bin/env node

/** Verify every file and digest in a Juno database/object backup. */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const backupDir = path.resolve(process.env.JUNO_BACKUP_DIR ?? "");

function fail(message) {
  throw new Error(message);
}

async function digest(filePath) {
  const bytes = await readFile(filePath);
  return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function main() {
  if (!backupDir || backupDir === path.resolve(".")) fail("JUNO_BACKUP_DIR must point to an explicit backup directory.");
  const manifest = JSON.parse(await readFile(path.join(backupDir, "backup-manifest.json"), "utf8"));
  if (manifest.schemaVersion !== 1 || !manifest.database || !Array.isArray(manifest.objects)) fail("Unsupported or malformed backup manifest.");

  const database = await digest(path.join(backupDir, manifest.database.file));
  if (database.bytes !== manifest.database.bytes || database.sha256 !== manifest.database.sha256) {
    fail("Database dump failed its recorded integrity check.");
  }
  for (const object of manifest.objects) {
    const actual = await digest(path.join(backupDir, object.relativePath));
    if (actual.bytes !== object.bytes || actual.sha256 !== object.sha256) fail(`Object failed its recorded integrity check: ${object.storageKey}`);
  }
  if (manifest.storage.objectCount !== manifest.objects.length) fail("Object count does not match the manifest.");
  console.log(`Backup verified: ${manifest.objects.length} objects and database dump are intact.`);
}

main().catch((error) => {
  console.error(`Backup verification failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
