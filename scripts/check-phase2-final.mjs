#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

try {
  process.loadEnvFile();
} catch {
  // Node versions without process.loadEnvFile are supported by the CI env.
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_PATH = path.resolve(
  ROOT,
  process.env.PHASE2_FINAL_LEDGER_PATH ?? "docs/release/JUNO_PHASE_2_FINAL_LEDGER.json",
);
const REQUIRED_FIELDS = [
  "id",
  "area",
  "priority",
  "state",
  "implementationFiles",
  "runtimeEntryPoint",
  "tests",
  "integrationTests",
  "e2e",
  "visualEvidence",
  "performanceEvidence",
  "accessibilityEvidence",
  "deploymentEvidence",
  "blocker",
  "notes",
];
const ALLOWED_STATES = new Set([
  "NOT_STARTED",
  "IN_PROGRESS",
  "IMPLEMENTED_UNVERIFIED",
  "VERIFIED",
  "BLOCKED_EXTERNALLY",
  "FAILED",
]);
const INCOMPLETE_LOCAL_STATES = new Set(["NOT_STARTED", "IN_PROGRESS", "IMPLEMENTED_UNVERIFIED", "FAILED"]);
const PLACEHOLDER_RE = /FINAL_SHA_RECORDED_AFTER_PUSH|TBD|TODO|FIXME|<sha>|not yet implemented|intentionally unfinished/i;

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`${label} is missing: ${path.relative(ROOT, filePath)}`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function git(args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function asEvidence(value) {
  if (typeof value === "string") return value.trim().length > 0;
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function relative(filePath) {
  return path.relative(ROOT, filePath) || ".";
}

function walkProductionSwiftFiles() {
  const roots = [
    path.join(ROOT, "native", "iOS", "JunoMobile", "App"),
    path.join(ROOT, "native", "Packages", "JunoNativeKit", "Sources", "JunoCodeKit"),
    path.join(ROOT, "native", "Packages", "JunoCode", "Sources", "JunoCodeCore"),
  ];
  const files = [];
  const visit = (directory) => {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && fullPath.endsWith(".swift") && !fullPath.includes("/Tests/")) files.push(fullPath);
    }
  };
  for (const root of roots) visit(root);
  return files;
}

function assertWorkflowWiring(errors) {
  const deployPath = path.join(ROOT, ".github", "workflows", "deploy.yml");
  const nativePath = path.join(ROOT, ".github", "workflows", "native.yml");
  const deploy = fs.existsSync(deployPath) ? fs.readFileSync(deployPath, "utf8") : "";
  const native = fs.existsSync(nativePath) ? fs.readFileSync(nativePath, "utf8") : "";
  for (const [needle, label] of [
    ["ref: ${{ github.sha }}", "deploy workflow exact checkout"],
    ["GITHUB_SHA: ${{ github.sha }}", "deploy workflow exact SHA environment"],
    ["npm run phase2:ci:verify", "blocking exact-SHA check aggregation"],
    ["PHASE2_REQUIRED_CHECKS", "required check list"],
  ]) {
    if (!deploy.includes(needle)) errors.push(`deploy workflow is missing ${label}: ${needle}`);
  }
  if (!native.includes("actions/checkout@v4")) errors.push("native workflow has no source checkout");
  if (process.env.PHASE2_FINAL_CI_VERIFIED === "1" && !process.env.PHASE2_FINAL_CI_RUNS?.trim()) {
    errors.push("PHASE2_FINAL_CI_VERIFIED=1 requires PHASE2_FINAL_CI_RUNS with exact-SHA run evidence");
  }
}

function assertDocs(errors) {
  const statusPath = path.join(ROOT, "docs", "product-completion", "status.json");
  const status = readJson(statusPath, "product completion status");
  if (status.auditCommit === "FINAL_SHA_RECORDED_AFTER_PUSH") errors.push("status.json still contains FINAL_SHA_RECORDED_AFTER_PUSH");
  if (status.nextSlice?.state === "in_progress") errors.push("status.json still has an in-progress nextSlice at final closure");
  const slices = Array.isArray(status.slices) ? status.slices : [];
  const byId = new Map(slices.map((slice) => [slice.id, slice]));
  for (const [sliceId, acceptanceIds] of [
    ["research-durable", ["durable", "claim-graph", "revision-loop"]],
    ["artifact-verification", ["revise-loop", "xlsx-depth"]],
    ["product-e2e", ["e2e-layer", "journeys", "states"]],
  ]) {
    const slice = byId.get(sliceId);
    if (!slice) {
      errors.push(`status.json is missing canonical slice ${sliceId}`);
      continue;
    }
    if (["partial", "in_progress", "blocked"].includes(slice.state)) errors.push(`canonical slice ${sliceId} has state ${slice.state}`);
    for (const acceptanceId of acceptanceIds) {
      const acceptance = slice.acceptance?.find((item) => item.id === acceptanceId);
      if (!acceptance) errors.push(`status.json is missing ${sliceId}/${acceptanceId}`);
      else if (acceptance.state === "partial" || acceptance.state === "in_progress") errors.push(`canonical acceptance ${sliceId}/${acceptanceId} has state ${acceptance.state}`);
    }
  }
  const acceptancePath = path.join(ROOT, "docs", "release", "JUNO_PHASE_2_ACCEPTANCE.md");
  const acceptanceText = fs.readFileSync(acceptancePath, "utf8");
  if (PLACEHOLDER_RE.test(acceptanceText)) errors.push("JUNO_PHASE_2_ACCEPTANCE.md contains a release placeholder");
  if (/PHASE 2 IMPLEMENTATION COMPLETE/i.test(acceptanceText)) errors.push("JUNO_PHASE_2_ACCEPTANCE.md makes an unqualified implementation-complete claim");
  const handoffPath = path.join(ROOT, "docs", "release", "JUNO_PHASE_2_HANDOFF_PROMPT.md");
  const handoffText = fs.readFileSync(handoffPath, "utf8");
  if (!/superseded/i.test(handoffText.slice(0, 600))) errors.push("JUNO_PHASE_2_HANDOFF_PROMPT.md is not marked superseded");
  if (/intentionally unfinished|native mobile redesign is NOT accepted/i.test(handoffText)) errors.push("superseded handoff still presents stale unfinished claims");
}

function assertNoKnownFakes(errors) {
  const patterns = [
    [/(?<![A-Za-z])Passed\s*=\s*testEvents\.count\b/, "fabricated test count"],
    [/(?<![A-Za-z])Failed\s*=\s*0\b/, "fabricated zero failures"],
    [/Lead Orchestrator/, "canned agent topology"],
    [/(?<![A-Za-z])exit\s*=\s*0\b/, "fabricated exit code"],
  ];
  for (const filePath of walkProductionSwiftFiles()) {
    const text = fs.readFileSync(filePath, "utf8");
    for (const [pattern, label] of patterns) {
      if (pattern.test(text)) errors.push(`${label} remains in ${relative(filePath)}`);
    }
  }
}

function main() {
  const errors = [];
  const ledger = readJson(LEDGER_PATH, "final Phase 2 ledger");
  const requirements = ledger.requirements;
  if (!Array.isArray(requirements) || requirements.length === 0) errors.push("final ledger has no requirements array");
  const seen = new Set();
  for (const requirement of requirements ?? []) {
    for (const field of REQUIRED_FIELDS) if (!(field in requirement)) errors.push(`${requirement.id ?? "<unknown>"} is missing required field ${field}`);
    if (!requirement.id || seen.has(requirement.id)) errors.push(`requirement id is missing or duplicated: ${requirement.id ?? "<unknown>"}`);
    seen.add(requirement.id);
    if (!ALLOWED_STATES.has(requirement.state)) errors.push(`${requirement.id} has invalid state ${requirement.state}`);
    if (!/^P[0-3]$/.test(requirement.priority)) errors.push(`${requirement.id} has invalid priority ${requirement.priority}`);
    if (!Array.isArray(requirement.implementationFiles)) errors.push(`${requirement.id} implementationFiles must be an array`);
    for (const file of requirement.implementationFiles ?? []) {
      const fullPath = path.resolve(ROOT, file);
      if (fullPath !== ROOT && !fullPath.startsWith(`${ROOT}${path.sep}`)) errors.push(`${requirement.id} references a path outside the repository: ${file}`);
      else if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) errors.push(`${requirement.id} references a missing/non-file implementation path: ${file}`);
    }
    for (const field of ["tests", "integrationTests", "e2e"]) if (!Array.isArray(requirement[field])) errors.push(`${requirement.id}.${field} must be an array`);
    for (const field of ["visualEvidence", "performanceEvidence", "accessibilityEvidence", "deploymentEvidence", "notes"]) {
      if (!asEvidence(requirement[field])) errors.push(`${requirement.id}.${field} must contain concrete evidence`);
    }
    if (typeof requirement.runtimeEntryPoint !== "string" || !requirement.runtimeEntryPoint.trim()) errors.push(`${requirement.id}.runtimeEntryPoint is empty`);
    if (typeof requirement.blocker !== "string") errors.push(`${requirement.id}.blocker must be a string`);
    const serialized = JSON.stringify(requirement);
    if (PLACEHOLDER_RE.test(serialized)) errors.push(`${requirement.id} contains a release placeholder`);
    if (INCOMPLETE_LOCAL_STATES.has(requirement.state) && ["P0", "P1"].includes(requirement.priority)) errors.push(`${requirement.id} [${requirement.priority}] is locally incomplete: ${requirement.state}`);
    if (requirement.state === "VERIFIED") {
      if (!requirement.implementationFiles?.length) errors.push(`${requirement.id} is VERIFIED without implementation files`);
      if (!requirement.tests.length && !requirement.integrationTests.length && !requirement.e2e.length) errors.push(`${requirement.id} is VERIFIED without tests/integration/E2E evidence`);
      if (requirement.blocker.trim()) errors.push(`${requirement.id} is VERIFIED but has a blocker`);
    }
    if (requirement.state === "BLOCKED_EXTERNALLY") {
      if (requirement.blocker.trim().length < 30 || !/BLOCKED_EXTERNALLY|external|hardware|credential|signing|GitHub/i.test(requirement.blocker)) errors.push(`${requirement.id} lacks a concrete external blocker`);
      if (/locally achievable|local implementation gap|TODO/i.test(requirement.blocker)) errors.push(`${requirement.id} uses an external blocker to hide local work`);
    }
  }

  assertDocs(errors);
  assertWorkflowWiring(errors);
  assertNoKnownFakes(errors);

  let head = null;
  try {
    head = git(["rev-parse", "--verify", "HEAD^{commit}"]);
    if (!/^[0-9a-f]{40}$/.test(head)) errors.push(`HEAD is not a full commit SHA: ${head}`);
  } catch (error) {
    errors.push(`could not resolve HEAD: ${error instanceof Error ? error.message : String(error)}`);
  }
  const githubSHA = process.env.GITHUB_SHA?.trim();
  if (githubSHA && githubSHA !== head) errors.push(`GITHUB_SHA ${githubSHA} does not match HEAD ${head}`);
  if (process.env.PHASE2_FINAL_REQUIRE_CLEAN === "1") {
    const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (status) errors.push("PHASE2_FINAL_REQUIRE_CLEAN=1 but the working tree is not clean");
  }
  if (process.env.PHASE2_FINAL_REQUIRE_REMOTE === "1") {
    try {
      const remote = git(["ls-remote", "origin", "refs/heads/main"]).split(/\s+/)[0];
      if (!remote || remote !== head) errors.push(`origin/main ${remote || "<missing>"} does not match HEAD ${head}`);
    } catch (error) {
      errors.push(`could not resolve origin/main: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const counts = Object.fromEntries([...ALLOWED_STATES].map((state) => [state, 0]));
  for (const requirement of requirements ?? []) if (counts[requirement.state] !== undefined) counts[requirement.state] += 1;
  console.log(`[phase2-final] ledger=${relative(LEDGER_PATH)} requirements=${requirements?.length ?? 0} head=${head ?? "<unknown>"}`);
  console.log(`[phase2-final] states=${JSON.stringify(counts)}`);
  if (errors.length) {
    console.error(`[phase2-final] FAILED with ${errors.length} violation(s)`);
    for (const error of errors) console.error(`  ✖ ${error}`);
    process.exitCode = 1;
    return;
  }
  const digest = crypto.createHash("sha256").update(fs.readFileSync(LEDGER_PATH)).digest("hex");
  console.log(`[phase2-final] PASS ledgerSha256=${digest}`);
  console.log("[phase2-final] Local closure evidence is internally consistent; external states remain explicit.");
}

main();
