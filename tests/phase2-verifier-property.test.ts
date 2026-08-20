import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

test("phase2 verification fails when implementationFiles contains a nonexistent file", () => {
  const ledgerPath = path.join(process.cwd(), "docs", "release", "JUNO_PHASE_2_RECOVERY_LEDGER.json");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "juno-phase2-verifier-"));
  const tempLedgerPath = path.join(tempDir, "JUNO_PHASE_2_RECOVERY_LEDGER.json");

  try {
    const data = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    // Deliberately corrupt the first requirement's implementationFiles
    data.requirements[0].implementationFiles.push("THIS_FILE_DOES_NOT_EXIST.ts");
    fs.writeFileSync(tempLedgerPath, JSON.stringify(data, null, 2), "utf8");

    const env = { ...process.env, PHASE2_LEDGER_PATH: tempLedgerPath };

    // 1. check-phase2-recovery must fail
    assert.throws(() => {
      execFileSync("node", ["scripts/check-phase2-recovery.mjs"], { env, stdio: "pipe" });
    }, /Command failed/);

    // 2. The package entry point must exercise the same failing verifier.
    assert.throws(() => {
      execFileSync("npm", ["run", "phase2:verify"], { env, stdio: "pipe" });
    }, /Command failed/);

  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
