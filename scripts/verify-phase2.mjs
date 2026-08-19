#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const LEDGER_PATH = path.join(ROOT, "docs", "release", "JUNO_PHASE_2_RECOVERY_LEDGER.json");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts", "phase2-verification");

function getCommitSHA() {
  if (process.env.GITHUB_SHA && process.env.GITHUB_SHA.trim().length > 0) {
    return process.env.GITHUB_SHA.trim();
  }
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "UNKNOWN_COMMIT";
  }
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

console.log("================================================================================");
console.log("             JUNO PHASE 2 — EXECUTABLE VERIFICATION ENGINE");
console.log("================================================================================");

const commitSHA = getCommitSHA();
console.log(`[phase2-verifier] Target Commit SHA: ${commitSHA}`);
console.log(`[phase2-verifier] Working Directory: ${ROOT}`);
console.log(`[phase2-verifier] Started At: ${new Date().toISOString()}\n`);

if (!fs.existsSync(LEDGER_PATH)) {
  console.error(`[phase2-verifier] ERROR: Ledger file not found at ${LEDGER_PATH}`);
  process.exit(1);
}

let ledger;
try {
  ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
} catch (err) {
  console.error(`[phase2-verifier] ERROR: Failed to parse ledger JSON:`, err);
  process.exit(1);
}

const requirements = ledger.requirements || [];
if (!Array.isArray(requirements) || requirements.length === 0) {
  console.error(`[phase2-verifier] ERROR: No requirements found in ledger.`);
  process.exit(1);
}

const outDir = path.join(ARTIFACTS_DIR, commitSHA);
ensureDir(outDir);

// 1. Mechanically check file existence and types of all referenced implementationFiles
console.log("[phase2-verifier] Step 1: Validating implementation files for all requirements...");
let fileErrors = [];
for (const req of requirements) {
  if (req.state === "VERIFIED") {
    if (!Array.isArray(req.implementationFiles) || req.implementationFiles.length === 0) {
      fileErrors.push({ reqId: req.id, error: "Missing or empty implementationFiles for VERIFIED requirement" });
      continue;
    }
  }
  if (Array.isArray(req.implementationFiles)) {
    for (const f of req.implementationFiles) {
      const fullPath = path.isAbsolute(f) ? f : path.join(ROOT, f);
      if (!fs.existsSync(fullPath)) {
        fileErrors.push({ reqId: req.id, error: `Referenced implementation file does not exist: ${f}` });
      } else {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
          fileErrors.push({ reqId: req.id, error: `Referenced path is a directory, expected file: ${f}` });
        }
      }
    }
  }
}

if (fileErrors.length > 0) {
  console.error(`[phase2-verifier] ERROR: Found ${fileErrors.length} implementation file violation(s):`);
  for (const e of fileErrors) {
    console.error(`  ✖ [${e.reqId}] ${e.error}`);
  }
  process.exit(1);
}
console.log(`  ✔ Validated all implementation files across ${requirements.length} requirements.\n`);

// 2. Run verification test suites
console.log("[phase2-verifier] Step 2: Executing mechanical verification suites...");

const testSuites = [
  {
    id: "GATE_LEDGER",
    name: "Phase 2 Recovery Ledger Integrity",
    command: "node scripts/check-phase2-recovery.mjs",
    environmentClass: "backend",
  },
  {
    id: "GATE_MODELS",
    name: "Model Catalog and Reasoning Tiers Validation",
    command: "npx tsx scripts/validate-models.ts",
    environmentClass: "backend",
  },
  {
    id: "GATE_SWIFT_CONTRACT",
    name: "Native Swift / TypeScript Contract Alignment",
    command: "node scripts/check-native-swift-contract.mjs",
    environmentClass: "native_ios",
  },
  {
    id: "GATE_NATIVE_DESIGN",
    name: "Apple Native Design System Tokens & Restraint",
    command: "node scripts/check-native-design.mjs",
    environmentClass: "native_ios",
  },
  {
    id: "GATE_CODE_PREVIEW",
    name: "Code Preview Wiring & Visual Evidence Verification",
    command: "node scripts/check-code-preview-wiring.mjs",
    environmentClass: "backend",
  },
  {
    id: "GATE_CODE_REMOTE",
    name: "Code Remote Protocol and Host Device Verification",
    command: "node scripts/check-code-remote-wiring.mjs",
    environmentClass: "backend",
  },
  {
    id: "GATE_CODE_RUNTIME",
    name: "Code Runtime Orchestrator Verification",
    command: "node scripts/check-code-runtime-wiring.mjs",
    environmentClass: "backend",
  },
  {
    id: "GATE_WORK_SANDBOX",
    name: "Work Sandbox and Multi-Agent Orchestration",
    command: "node scripts/check-work-sandbox.mjs",
    environmentClass: "backend",
  },
  {
    id: "GATE_CAPABILITIES",
    name: "Juno Capability Contract Synchronization",
    command: "node scripts/check-capability-contract.mjs",
    environmentClass: "backend",
  },
  {
    id: "GATE_WORK_CONTRACT",
    name: "Juno Work Contract Synchronization",
    command: "node scripts/check-work-contract.mjs",
    environmentClass: "backend",
  },
  {
    id: "GATE_UNIT_TESTS",
    name: "Backend and Chat Integration Test Suite",
    command: "npx tsx --test tests/*.test.ts",
    environmentClass: "backend",
  },
  {
    id: "GATE_NATIVE_TESTS",
    name: "Native Swift Packages Unit Test Suite",
    command: "bash scripts/native-test.sh",
    environmentClass: "native_macos",
  }
];

const results = [];
let anyFailed = false;

for (const suite of testSuites) {
  const startedAt = new Date().toISOString();
  process.stdout.write(`  ▶ Running [${suite.id}] ${suite.name}... `);
  let output = "";
  let exitCode = 0;
  let status = "PASSED";

  try {
    output = execSync(suite.command, {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, CI: "true" }
    });
    console.log("✔ PASSED");
  } catch (err) {
    status = "FAILED";
    anyFailed = true;
    exitCode = err.status || 1;
    output = (err.stdout || "") + "\n" + (err.stderr || "") + "\n" + (err.message || "");
    console.log(`✖ FAILED (exit code ${exitCode})`);
  }

  const finishedAt = new Date().toISOString();
  const outputDigest = sha256(output);
  const logFilename = `${suite.id}.log`;
  fs.writeFileSync(path.join(outDir, logFilename), output, "utf8");

  results.push({
    requirementId: suite.id,
    name: suite.name,
    status,
    command: suite.command,
    startedAt,
    finishedAt,
    exitCode,
    outputDigest,
    artifactPaths: [`artifacts/phase2-verification/${commitSHA}/${logFilename}`],
    environmentClass: suite.environmentClass,
  });
}

// 3. Write manifest.json
const manifest = {
  commitSHA,
  verifiedAt: new Date().toISOString(),
  totalSuites: testSuites.length,
  passedSuites: results.filter((r) => r.status === "PASSED").length,
  failedSuites: results.filter((r) => r.status === "FAILED").length,
  overallStatus: anyFailed ? "FAILED" : "PASSED",
  requirements: results,
};

const manifestPath = path.join(outDir, "manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
console.log(`\n[phase2-verifier] Manifest written to ${manifestPath}`);

// 4. Write summary markdown report
const reportContent = `# JUNO PHASE 2 VERIFICATION REPORT
**Commit SHA**: \`${commitSHA}\`  
**Verified At**: \`${manifest.verifiedAt}\`  
**Overall Status**: **${manifest.overallStatus}**  

---

## Suite Summary
- Total Suites: **${manifest.totalSuites}**
- Passed: **${manifest.passedSuites}**
- Failed: **${manifest.failedSuites}**

| Suite ID | Name | Environment | Status | Exit Code | Digest | Log |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
${results
  .map(
    (r) =>
      `| \`${r.requirementId}\` | ${r.name} | \`${r.environmentClass}\` | **${r.status}** | \`${r.exitCode}\` | \`${r.outputDigest.slice(0, 8)}\` | [\`${path.basename(r.artifactPaths[0])}\`](./${path.basename(r.artifactPaths[0])}) |`
  )
  .join("\n")}

---
*Generated automatically by \`scripts/verify-phase2.mjs\`.*
`;

const reportPath = path.join(outDir, "report.md");
fs.writeFileSync(reportPath, reportContent, "utf8");
console.log(`[phase2-verifier] Summary report written to ${reportPath}\n`);

if (anyFailed) {
  console.error("================================================================================");
  console.error(" ✖ PHASE 2 VERIFICATION FAILED. See logs above for details.");
  console.error("================================================================================");
  process.exit(1);
} else {
  console.log("================================================================================");
  console.log(" ✔ PHASE 2 VERIFICATION COMPLETE & 100% PASSING.");
  console.log("================================================================================");
  process.exit(0);
}
