import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

/*
 * THE CLOUD RUNNER WORKFLOW, PINNED TO THE CODE THAT DISPATCHES IT.
 *
 * For a stretch the workflow file did not exist on any branch while nine
 * source files cited it, so every "Start cloud run" click created a task,
 * dispatched, got a 404 from GitHub, and left a failed run behind. Nothing
 * tested the one fact that mattered — that the file is there and declares the
 * inputs the server sends — because the two halves live in different
 * languages. So this reads both as text, the way tests/code-rollback.test.ts
 * checks its cross-file seams, and fails the moment they drift.
 */

const root = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");

const WORKFLOW = ".github/workflows/code-runner.yml";
const workflow = fs.existsSync(path.join(root, WORKFLOW)) ? read(WORKFLOW) : null;
const dispatcher = read("src/lib/cloud-code.ts");
const token = read("src/lib/cloud-code-token.ts");
const driver = read("scripts/cloud-code-runner.mjs");
const createRoute = read("src/app/api/code/tasks/route.ts");

/**
 * The keys under `on.workflow_dispatch.inputs`, by indentation.
 *
 * A YAML parser would be a new dependency for a four-line shape. Inputs are
 * the children of the `inputs:` line that sit exactly one indent deeper, and
 * every deeper line (description, required, type) is skipped.
 */
function workflowInputs(source: string): string[] {
  const lines = source.split("\n");
  const start = lines.findIndex((line) => /^\s*inputs:\s*$/.test(line));
  assert.notEqual(start, -1, "workflow_dispatch has no `inputs:` block");
  const indent = lines[start].search(/\S/);
  const keys: string[] = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const depth = line.search(/\S/);
    if (depth <= indent) break;
    const match = /^(\s*)([A-Za-z][\w-]*):\s*$/.exec(line);
    if (match && match[1].length === indent + 2) keys.push(match[2]);
  }
  return keys;
}

/** The keys of the `inputs: { … }` object literal inside the dispatch body. */
function dispatchInputs(source: string): string[] {
  const match = /inputs:\s*\{([\s\S]*?)\}/.exec(source);
  assert.ok(match, "dispatchCloudRunner no longer builds an `inputs: { … }` body");
  return [...match[1].matchAll(/^\s*([A-Za-z]\w*):/gm)].map((m) => m[1]);
}

test("the workflow file exists on this tree", () => {
  assert.ok(workflow, `${WORKFLOW} is missing — every cloud dispatch 404s without it`);
});

test("the workflow declares exactly the inputs the server dispatches", () => {
  assert.ok(workflow);
  const declared = workflowInputs(workflow).sort();
  const sent = dispatchInputs(dispatcher).sort();
  // GitHub rejects a dispatch carrying an undeclared input (422) and the runner
  // reads nothing from an input the server does not send, so the two lists
  // have to be identical, not merely overlapping.
  assert.deepEqual(declared, sent);
  assert.deepEqual(sent, ["callbackBase", "taskId"]);
});

test("no repository detail rides the public dispatch inputs", () => {
  // Inputs are printed into the public Actions log. The runner reads the repo
  // from runner-context over an authenticated call instead.
  for (const leaked of ["repoOwner", "repoName", "baseRef"]) {
    assert.ok(!dispatchInputs(dispatcher).includes(leaked), `${leaked} is back in the dispatch inputs`);
  }
  // Real reads only — the driver's own comment names the old inputs to say why
  // they are gone, and a bare name match would fail on the explanation.
  assert.ok(
    !/process\.env\.JUNO_(REPO_OWNER|REPO_NAME|BASE_REF)\b/.test(driver),
    "the driver reads the repo from env again",
  );
  assert.ok(!/log\(`repo \$\{repoOwner\}/.test(driver), "the driver logs the repository name again");
});

test("the workflow grants only id-token and contents, and times out", () => {
  assert.ok(workflow);
  const permissions = /^permissions:\n((?:[ \t]+.*\n)+)/m.exec(workflow)?.[1] ?? "";
  assert.match(permissions, /id-token:\s*write/, "the OIDC handshake needs id-token: write");
  assert.match(permissions, /contents:\s*read/);
  const grants = [...permissions.matchAll(/^\s+([a-z-]+):/gm)].map((m) => m[1]).sort();
  assert.deepEqual(grants, ["contents", "id-token"], "the runner job must hold no other grant");
  assert.match(workflow, /timeout-minutes:\s*30\b/);
});

test("the workflow builds the agent core, wires the sandbox image, and runs the driver", () => {
  assert.ok(workflow);
  assert.match(workflow, /npm ci --prefix runner\/agent-core/);
  assert.match(workflow, /npm run build --prefix runner\/agent-core/);
  assert.match(workflow, /node scripts\/cloud-code-runner\.mjs/);
  // A repository variable, so the image can be pinned without a code change.
  assert.match(workflow, /JUNO_RUNNER_SANDBOX_IMAGE:\s*\$\{\{\s*vars\.JUNO_RUNNER_SANDBOX_IMAGE\s*\}\}/);
  // Every env the driver refuses to start without is set by the workflow.
  for (const name of [...driver.matchAll(/requireEnv\("([A-Z_]+)"\)/g)].map((m) => m[1])) {
    assert.match(workflow, new RegExp(`^\\s+${name}:`, "m"), `${name} is required by the driver and not set by the workflow`);
  }
});

test("the task token outlives the job by a margin", () => {
  assert.ok(workflow);
  const timeout = Number(/timeout-minutes:\s*(\d+)/.exec(workflow)?.[1]);
  const jobMs = Number(/CLOUD_RUNNER_JOB_TIMEOUT_MS = (\d+) \* 60_000/.exec(token)?.[1]);
  assert.equal(jobMs, timeout, "CLOUD_RUNNER_JOB_TIMEOUT_MS must equal the workflow's timeout-minutes");
  // A token that lasts exactly as long as the job expires BEFORE the job does
  // (it is minted after the job starts), and the terminal `done` post — the
  // one carrying the pull request URL — is then dropped as a 401.
  assert.match(token, /CLOUD_CODE_TOKEN_TTL_MS = CLOUD_RUNNER_JOB_TIMEOUT_MS \+ \d+ \* 60_000/);
});

test("task creation is gated on the workflow's existence, before any row is written", () => {
  assert.match(dispatcher, /export async function getCloudRunnerReadiness/);
  assert.match(dispatcher, /actions\/workflows\/\$\{CLOUD_RUNNER_WORKFLOW\}`/, "the probe must ask GitHub for the workflow file");
  const gate = createRoute.indexOf("getCloudRunnerReadiness()");
  const create = createRoute.indexOf("tx.codeTask.create(");
  assert.notEqual(gate, -1, "the create route no longer probes readiness");
  assert.ok(gate < create, "the readiness gate must run before the cloud task is created");
  assert.match(createRoute, /"cloud_runner_not_configured"[\s\S]*?status: 503/);
});
