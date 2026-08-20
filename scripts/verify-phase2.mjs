#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

const ROOT = process.cwd();
const LEDGER_PATH = process.env.PHASE2_LEDGER_PATH
  ? path.resolve(process.env.PHASE2_LEDGER_PATH)
  : path.join(ROOT, "docs", "release", "JUNO_PHASE_2_RECOVERY_LEDGER.json");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts", "phase2-verification");

function getHeadSHA() {
  try {
    const sha = execSync("git rev-parse --verify HEAD^{commit}", { cwd: ROOT, encoding: "utf8" }).trim();
    if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
  } catch {
    /* The checked-out commit is mandatory evidence; report the failure below. */
  }
  return null;
}

function getWorktreeState() {
  try {
    const status = execSync("git status --porcelain=v1 --untracked-files=all", {
      cwd: ROOT,
      encoding: "utf8",
    });
    return {
      clean: status.trim().length === 0,
      digest: sha256(status),
    };
  } catch {
    return { clean: false, digest: null };
  }
}

function getCommitSHA() {
  const headSHA = getHeadSHA();
  const githubSHA = process.env.GITHUB_SHA?.trim() || null;
  if (!headSHA) throw new Error("could not resolve the checked-out HEAD commit");
  if (githubSHA && (!/^[0-9a-f]{40}$/i.test(githubSHA) || githubSHA !== headSHA)) {
    throw new Error(`GITHUB_SHA ${githubSHA || "<empty>"} does not exactly match checked-out HEAD ${headSHA}`);
  }
  const worktree = getWorktreeState();
  if (githubSHA && !worktree.clean) {
    throw new Error("exact-SHA verification requires a clean working tree");
  }
  return { commitSHA: githubSHA || headSHA, headSHA, githubSHA, worktree };
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

let commitEvidence;
try {
  commitEvidence = getCommitSHA();
} catch (error) {
  console.error(`[phase2-verifier] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
const { commitSHA, headSHA, githubSHA, worktree } = commitEvidence;
console.log(`[phase2-verifier] Target Commit SHA: ${commitSHA}`);
console.log(`[phase2-verifier] Checked-out HEAD SHA: ${headSHA}`);
console.log(`[phase2-verifier] Working Tree: ${worktree.clean ? "clean" : "modified (local evidence only)"}`);
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

// 1. Mechanically check file existence and types of all referenced implementationFiles
console.log("[phase2-verifier] Step 1: Validating implementation files for all requirements...");
let fileErrors = [];
const repositoryRoot = path.resolve(ROOT);
for (const req of requirements) {
  if (req.state === "VERIFIED") {
    if (!Array.isArray(req.implementationFiles) || req.implementationFiles.length === 0) {
      fileErrors.push({ reqId: req.id, error: "Missing or empty implementationFiles for VERIFIED requirement" });
      continue;
    }
  }
  if (Array.isArray(req.implementationFiles)) {
    for (const f of req.implementationFiles) {
      if (typeof f !== "string" || f.trim().length === 0) {
        fileErrors.push({ reqId: req.id, error: "implementationFiles contains an empty or non-string path" });
        continue;
      }
      const fullPath = path.resolve(ROOT, f);
      if (fullPath !== repositoryRoot && !fullPath.startsWith(`${repositoryRoot}${path.sep}`)) {
        fileErrors.push({ reqId: req.id, error: `Referenced implementation file is outside the repository: ${f}` });
        continue;
      }
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

// Artifacts are created only after the exact checked-out SHA and every file
// reference have passed. A failed verification therefore cannot leave a
// misleading report under a later commit's directory.
const outDir = path.join(ARTIFACTS_DIR, commitSHA);
ensureDir(outDir);

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
    id: "GATE_PRISMA_VALIDATE",
    name: "Prisma Schema Validation",
    command: "npx prisma validate",
    environmentClass: "backend",
    env: {
      DATABASE_URL: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/juno_phase2",
      DIRECT_URL: process.env.DIRECT_URL || "postgresql://postgres:postgres@127.0.0.1:5432/juno_phase2",
    },
  },
  {
    id: "GATE_LINT",
    name: "ESLint",
    command: "npm run lint",
    environmentClass: "backend",
  },
  {
    id: "GATE_TYPECHECK",
    name: "TypeScript Typecheck",
    command: "npx tsc --noEmit",
    environmentClass: "backend",
  },
  {
    id: "GATE_RUNNER_BUILD",
    name: "Cloud Runner Build",
    command: "npm run build --prefix runner/agent-core",
    environmentClass: "runner",
  },
  {
    id: "GATE_NEXT_BUILD",
    name: "Next.js Production Build",
    command: "npm run build",
    environmentClass: "backend",
    env: {
      DATABASE_URL: process.env.DATABASE_URL || "postgresql://postgres:postgres@127.0.0.1:5432/juno_phase2",
      DIRECT_URL: process.env.DIRECT_URL || "postgresql://postgres:postgres@127.0.0.1:5432/juno_phase2",
    },
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
    id: "GATE_NPM_TEST",
    name: "Full Node Test, Auth, Crypto, and Moderation Suite",
    command: "npm test",
    environmentClass: "backend",
  },
  {
    id: "GATE_RESEARCH_TARGETED",
    name: "Targeted Durable Research Regression Suite",
    command: "npx tsx --test tests/research-*.test.ts",
    environmentClass: "backend",
  },
  {
    id: "GATE_SECURITY",
    name: "Security and Boundary Regression Suite",
    command: "npx tsx --test tests/*security*.test.ts tests/dlp-policy.test.ts tests/ownership-guard.test.ts",
    environmentClass: "security",
  },
  {
    id: "GATE_PLAYWRIGHT_CHAT",
    name: "Authenticated Browser Chat and Auto-refresh E2E",
    command: "npx playwright test e2e/chat.spec.ts --project=chromium",
    environmentClass: "browser",
  },
  {
    id: "GATE_NATIVE_TESTS",
    name: "Native Swift Packages Unit Test Suite",
    command: "bash scripts/native-test.sh",
    environmentClass: "native_macos",
    platform: "darwin",
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

  if (suite.platform && process.platform !== suite.platform) {
    status = "DEFERRED_TO_BLOCKING_CI";
    output = `This platform gate was deferred because the verifier is running on ${process.platform}; required runner platform: ${suite.platform}.\n`;
    console.log(`↷ DEFERRED TO BLOCKING CI (${suite.platform})`);
  } else {
    try {
      output = execSync(suite.command, {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, CI: "true", ...(suite.env || {}) }
      });
      console.log("✔ PASSED");
    } catch (err) {
      status = "FAILED";
      anyFailed = true;
      exitCode = err.status || 1;
      output = (err.stdout || "") + "\n" + (err.stderr || "") + "\n" + (err.message || "");
      console.log(`✖ FAILED (exit code ${exitCode})`);
    }
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
  checkedOutHeadSHA: headSHA,
  githubSHA,
  workingTreeClean: worktree.clean,
  workingTreeStatusDigest: worktree.digest,
  artifactScope: `artifacts/phase2-verification/${commitSHA}/`,
  statusScope: worktree.clean ? "local-gates-only" : "local-gates-only-worktree-dirty",
  blockingCiJobs: [
    { workflow: ".github/workflows/deploy.yml", job: "test" },
    { workflow: ".github/workflows/deploy.yml", job: "migrations" },
    { workflow: ".github/workflows/deploy.yml", job: "runner" },
    { workflow: ".github/workflows/native.yml", job: "contract" },
    { workflow: ".github/workflows/native.yml", job: "design" },
    { workflow: ".github/workflows/native.yml", job: "packages (JunoNativeKit)" },
    { workflow: ".github/workflows/native.yml", job: "packages (JunoCode)" },
    { workflow: ".github/workflows/native.yml", job: "packages (JunoWork)" },
    { workflow: ".github/workflows/native.yml", job: "macos-app" },
    { workflow: ".github/workflows/native.yml", job: "ios-app" },
  ],
  verifiedAt: new Date().toISOString(),
  totalSuites: testSuites.length,
  passedSuites: results.filter((r) => r.status === "PASSED").length,
  deferredSuites: results.filter((r) => r.status === "DEFERRED_TO_BLOCKING_CI").length,
  failedSuites: results.filter((r) => r.status === "FAILED").length,
  overallStatus: anyFailed
    ? "FAILED"
    : !worktree.clean
      ? "LOCAL_GATES_PASSED_WORKTREE_DIRTY_CI_GATES_REQUIRED"
    : results.some((r) => r.status === "DEFERRED_TO_BLOCKING_CI")
      ? "LOCAL_GATES_PASSED_CI_GATES_REQUIRED"
      : "LOCAL_GATES_PASSED",
  requirements: results,
};

const manifestPath = path.join(outDir, "manifest.json");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
console.log(`\n[phase2-verifier] Manifest written to ${manifestPath}`);

// 4. Write summary markdown report
const reportContent = `# JUNO PHASE 2 VERIFICATION REPORT
**Commit SHA**: \`${commitSHA}\`  
**Verified At**: \`${manifest.verifiedAt}\`  
**Local Gate Status**: **${manifest.overallStatus}**<br>
**Checked-out HEAD**: \`${headSHA}\`<br>
**Working Tree**: **${manifest.workingTreeClean ? "CLEAN" : "MODIFIED — LOCAL EVIDENCE ONLY"}**<br>
**Artifact Scope**: \`${manifest.artifactScope}\`

This report does not claim Phase 2 release closure. The blocking GitHub check
jobs listed in the manifest and the authenticated production browser smoke are
separate release conditions and must be aggregated before a release verdict.
${manifest.workingTreeClean ? "" : "The local working tree was modified when these gates ran; this artifact is not evidence that the checked-out commit alone passed. Exact-SHA CI requires a clean checkout."}

---

## Suite Summary
- Total Suites: **${manifest.totalSuites}**
- Passed: **${manifest.passedSuites}**
- Deferred to blocking CI: **${manifest.deferredSuites}**
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
  console.log(" ✔ LOCAL PHASE 2 GATES PASSED; RELEASE CLOSURE STILL REQUIRES BLOCKING CI AND PRODUCTION EVIDENCE.");
  console.log("================================================================================");
  process.exit(0);
}
