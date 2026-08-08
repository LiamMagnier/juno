import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const BACKUP_SOURCE = readFileSync(new URL("../scripts/backup-production.mjs", import.meta.url), "utf8");
const VERIFY_SOURCE = readFileSync(new URL("../scripts/verify-backup.mjs", import.meta.url), "utf8");
const RESTORE_SOURCE = readFileSync(new URL("../scripts/restore-production.mjs", import.meta.url), "utf8");

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
  assert.match(RESTORE_SOURCE, /pg_restore/);
  assert.match(RESTORE_SOURCE, /--clean/);
});
