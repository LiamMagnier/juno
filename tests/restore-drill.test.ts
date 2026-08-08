import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const drillScript = path.join(repositoryRoot, "scripts", "restore-drill.mjs");
const drillSource = readFileSync(drillScript, "utf8");

test("restore-drill harness is local-only and disposable", () => {
  assert.match(drillSource, /127\.0\.0\.1/);
  assert.match(drillSource, /JUNO_RESTORE_DRILL_KEEP/);
  assert.match(drillSource, /JUNO_PG_BIN_DIR/);
  assert.match(drillSource, /S3_BUCKET/);
  assert.match(drillSource, /RESTORE_S3_BUCKET/);
  assert.match(drillSource, /rm\(workspace, \{ recursive: true, force: true \}\)/);
  assert.match(drillSource, /backup-production\.mjs/);
  assert.match(drillSource, /verify-backup\.mjs/);
  assert.match(drillSource, /restore-production\.mjs/);
});

test("disposable restore drill round-trips database rows and object digests", (t) => {
  const check = spawnSync(process.execPath, [drillScript, "--check"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const checkOutput = `${check.stdout ?? ""}\n${check.stderr ?? ""}`;
  if (check.status !== 0 && /Missing local PostgreSQL binaries/.test(checkOutput)) {
    t.skip(checkOutput.trim());
    return;
  }
  assert.equal(check.status, 0, checkOutput);

  const result = spawnSync(process.execPath, [drillScript], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  assert.equal(result.status, 0, output);
  assert.match(output, /Restore drill passed: 3 database rows and 3 objects restored with matching integrity\./);
});
