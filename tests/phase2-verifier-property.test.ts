import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

test("phase2 verification fails when implementationFiles contains a nonexistent file", () => {
  const ledgerPath = path.join(process.cwd(), "docs", "release", "JUNO_PHASE_2_RECOVERY_LEDGER.json");
  const original = fs.readFileSync(ledgerPath, "utf8");
  
  try {
    const data = JSON.parse(original);
    // Deliberately corrupt the first requirement's implementationFiles
    data.requirements[0].implementationFiles.push("THIS_FILE_DOES_NOT_EXIST.ts");
    fs.writeFileSync(ledgerPath, JSON.stringify(data, null, 2), "utf8");

    // 1. check-phase2-recovery must fail
    assert.throws(() => {
      execSync("node scripts/check-phase2-recovery.mjs", { stdio: "pipe" });
    }, /Command failed/);

    // 2. verify-phase2 must fail
    assert.throws(() => {
      execSync("node scripts/verify-phase2.mjs", { stdio: "pipe" });
    }, /Command failed/);

  } finally {
    // Restore original ledger
    fs.writeFileSync(ledgerPath, original, "utf8");
  }
});
