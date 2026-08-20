#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const LEDGER_PATH = process.env.PHASE2_LEDGER_PATH
  ? path.resolve(process.env.PHASE2_LEDGER_PATH)
  : path.join(process.cwd(), "docs", "release", "JUNO_PHASE_2_RECOVERY_LEDGER.json");

if (!fs.existsSync(LEDGER_PATH)) {
  console.error(`[phase2-recovery] Error: Ledger file not found at ${LEDGER_PATH}`);
  process.exit(1);
}

let ledger;
try {
  ledger = JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8"));
} catch (err) {
  console.error(`[phase2-recovery] Error: Failed to parse ledger JSON:`, err);
  process.exit(1);
}

const requirements = ledger.requirements || [];
if (!Array.isArray(requirements) || requirements.length === 0) {
  console.error(`[phase2-recovery] Error: No requirements found in ledger.`);
  process.exit(1);
}

const ALLOWED_STATES = new Set([
  "NOT_STARTED",
  "IN_PROGRESS",
  "IMPLEMENTED_UNVERIFIED",
  "VERIFIED",
  "BLOCKED_EXTERNALLY",
  "FAILED"
]);

let violations = [];
let counts = {
  NOT_STARTED: 0,
  IN_PROGRESS: 0,
  IMPLEMENTED_UNVERIFIED: 0,
  VERIFIED: 0,
  BLOCKED_EXTERNALLY: 0,
  FAILED: 0
};

for (const req of requirements) {
  if (!req.id || !req.priority || !req.state) {
    violations.push(`Requirement missing id, priority, or state: ${JSON.stringify(req)}`);
    continue;
  }

  if (!ALLOWED_STATES.has(req.state)) {
    violations.push(`Requirement '${req.id}' has invalid state '${req.state}'`);
    continue;
  }

  counts[req.state] = (counts[req.state] || 0) + 1;

  if (req.state === "BLOCKED_EXTERNALLY") {
    if (!req.blocker || typeof req.blocker !== "string" || req.blocker.trim().length < 20) {
      violations.push(`Requirement '${req.id}' is BLOCKED_EXTERNALLY but lacks a concrete external blocker explanation.`);
    }
  } else if (req.state === "VERIFIED") {
    const hasTests = Array.isArray(req.tests) && req.tests.length > 0;
    const hasE2E = Array.isArray(req.e2e) && req.e2e.length > 0;
    if (!hasTests && !hasE2E) {
      violations.push(`Requirement '${req.id}' is marked VERIFIED but has no tests or E2E suites listed.`);
    }
    if (!req.visualEvidence || !req.performanceEvidence || !req.accessibilityEvidence) {
      violations.push(`Requirement '${req.id}' is marked VERIFIED but lacks named visual, performance, or accessibility evidence.`);
    }
    if (!Array.isArray(req.implementationFiles) || req.implementationFiles.length === 0) {
      violations.push(`Requirement '${req.id}' is marked VERIFIED but lacks implementationFiles.`);
    } else {
      for (const file of req.implementationFiles) {
        if (typeof file !== "string" || file.trim().length === 0) {
          violations.push(`Requirement '${req.id}' contains an empty or non-string implementation file path.`);
          continue;
        }
        const fullPath = path.resolve(process.cwd(), file);
        const root = path.resolve(process.cwd());
        if (fullPath !== root && !fullPath.startsWith(`${root}${path.sep}`)) {
          violations.push(`Requirement '${req.id}' references a path outside the repository: ${file}`);
          continue;
        }
        if (!fs.existsSync(fullPath)) {
          violations.push(`Requirement '${req.id}' references missing implementation file: ${file}`);
        } else if (fs.statSync(fullPath).isDirectory()) {
          violations.push(`Requirement '${req.id}' references a directory instead of a file: ${file}`);
        }
      }
    }
  } else {
    // For locally achievable P0 / P1 items, any incomplete state (NOT_STARTED, IN_PROGRESS, IMPLEMENTED_UNVERIFIED, FAILED) is a gate failure
    if (req.priority === "P0" || req.priority === "P1") {
      violations.push(`Requirement '${req.id}' [${req.priority}] is not completed (current state: ${req.state}).`);
    }
  }
}

console.log(`[phase2-recovery] Total requirements: ${requirements.length}`);
console.log(`[phase2-recovery] Status breakdown:`);
for (const [state, count] of Object.entries(counts)) {
  console.log(`  - ${state}: ${count}`);
}

if (violations.length > 0) {
  console.error(`\n[phase2-recovery] FAILED with ${violations.length} incomplete requirement(s) or violation(s):`);
  for (const v of violations) {
    console.error(`  ✖ ${v}`);
  }
  process.exit(1);
}

console.log(`\n[phase2-recovery] All ${requirements.length} requirements VERIFIED or truthfully BLOCKED_EXTERNALLY.`);
process.exit(0);
