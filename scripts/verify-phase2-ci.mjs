#!/usr/bin/env node

/**
 * Aggregate the blocking GitHub Actions checks for the exact commit being
 * verified. A green local verifier is not a release verdict: native jobs live
 * in a separate workflow and the deploy workflow has its own database/runner
 * gates. This script is the final check that turns those real check-run
 * conclusions into one fail-closed result.
 */

const repository = process.env.GITHUB_REPOSITORY;
const sha = process.env.GITHUB_SHA?.trim();
const token = process.env.GITHUB_TOKEN?.trim();
const requiredNames = (process.env.PHASE2_REQUIRED_CHECKS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const waitMs = Number(process.env.PHASE2_CI_WAIT_MS ?? 25 * 60 * 1000);
const pollMs = Number(process.env.PHASE2_CI_POLL_MS ?? 30 * 1000);

function fail(message) {
  console.error(`[phase2-ci] FAIL: ${message}`);
  process.exit(1);
}

if (!repository || !sha || !token) fail("GITHUB_REPOSITORY, GITHUB_SHA, and GITHUB_TOKEN are required.");
if (!/^[0-9a-f]{40}$/i.test(sha)) fail(`GITHUB_SHA is not a full commit SHA: ${sha}`);
if (requiredNames.length === 0) fail("PHASE2_REQUIRED_CHECKS must name every blocking check to aggregate.");

async function loadCheckRuns() {
  const response = await fetch(`https://api.github.com/repos/${repository}/commits/${sha}/check-runs?per_page=100`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const body = await response.json();
  if (!response.ok) fail(`GitHub check-run API returned ${response.status}.`);
  return Array.isArray(body.check_runs) ? body.check_runs : [];
}

function latestByName(checkRuns) {
  const latest = new Map();
  for (const run of checkRuns) {
    if (run.head_sha !== sha || typeof run.name !== "string") continue;
    const previous = latest.get(run.name);
    if (!previous || String(run.started_at ?? run.created_at) > String(previous.started_at ?? previous.created_at)) {
      latest.set(run.name, run);
    }
  }
  return latest;
}

function lookup(required, byName) {
  // GitHub Actions normally exposes the job id as the check name. The suffix
  // fallback handles installations that prefix it with the workflow name.
  return [...byName.entries()].find(([name]) => name === required || name.endsWith(` / ${required}`) || name.endsWith(` (${required})`))?.[1] ?? null;
}

const deadline = Date.now() + waitMs;
let lastSummary = "";
while (true) {
  const byName = latestByName(await loadCheckRuns());
  const rows = requiredNames.map((required) => ({ required, run: lookup(required, byName) }));
  const pending = rows.filter(({ run }) => !run || run.status !== "completed");
  const failed = rows.filter(({ run }) => run?.status === "completed" && run.conclusion !== "success");
  const summary = rows
    .map(({ required, run }) => `${required}=${run ? `${run.status}/${run.conclusion ?? "pending"}` : "missing"}`)
    .join(", ");
  if (summary !== lastSummary) {
    console.log(`[phase2-ci] ${summary}`);
    lastSummary = summary;
  }

  if (failed.length > 0) fail(`blocking checks failed: ${failed.map(({ required }) => required).join(", ")}`);
  if (pending.length === 0) {
    console.log(`[phase2-ci] PASS: ${requiredNames.length} blocking check(s) succeeded for ${sha}.`);
    process.exit(0);
  }
  if (Date.now() >= deadline) {
    fail(`timed out waiting for: ${pending.map(({ required }) => required).join(", ")}`);
  }
  await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, 30 * 1000)));
}
