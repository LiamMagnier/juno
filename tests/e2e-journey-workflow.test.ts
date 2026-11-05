import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/*
 * The PR job that runs the deterministic browser journey (ledger P1-5,
 * acceptance 1): chat streaming, Stop, regenerate, artifacts and MCP add, with
 * JUNO_E2E_SMOKE_PROVIDER=1 on a disposable database. This holds the workflow
 * to that: it exists, it runs on pull requests and on main, every spec it
 * names exists and is one the Playwright project actually picks up, and it
 * goes through the QA runner with no secrets and no database of its own.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const yaml = createRequire(import.meta.url)("js-yaml") as { load(text: string): unknown };
const TEXT = readFileSync(path.join(ROOT, ".github/workflows/e2e.yml"), "utf8");

type Step = { name?: string; run?: string; uses?: string; if?: string; env?: Record<string, string> };
type Workflow = {
  on: { pull_request?: { paths?: string[] }; push?: { branches?: string[] } };
  jobs: Record<string, { "runs-on": string; "timeout-minutes": number; services?: { postgres?: { image: string; env: Record<string, string>; ports: string[] } }; steps: Step[] }>;
};
const workflow = yaml.load(TEXT) as Workflow;
const job = workflow.jobs.journey;
const step = (pattern: RegExp) => job.steps.find((s) => pattern.test(s.run ?? ""));

test("the journey runs on pull requests and on main", () => {
  assert.ok(workflow.on.pull_request, "pull_request trigger");
  assert.deepEqual(workflow.on.push?.branches, ["main"]);
  for (const changes of ["src/**", "e2e/**", "prisma/**", "scripts/qa/**", "playwright.config.ts", "package-lock.json"]) {
    assert.ok(workflow.on.pull_request!.paths?.includes(changes), `a change to ${changes} runs it`);
  }
  assert.ok(job, "a journey job");
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.ok(job["timeout-minutes"] > 0 && job["timeout-minutes"] <= 60, "bounded");
});

test("it uses the runner's disposable database and nothing else", () => {
  const pg = job.services?.postgres;
  assert.ok(pg, "a service Postgres");
  assert.deepEqual(pg.ports, ["55439:5432"], "the one port the runner accepts");
  assert.equal(pg.env.POSTGRES_HOST_AUTH_METHOD, "trust");
  assert.doesNotMatch(TEXT, /secrets\./, "no secrets");
  const run = step(/run-prod-e2e\.sh/);
  assert.ok(run, "the browser journey goes through scripts/qa/run-prod-e2e.sh");
  assert.equal(run.env, undefined, "the runner picks its own *_test database; the step passes none");
  assert.doesNotMatch(run.run!, /playwright test/, "never Playwright directly");
});

test("it prepares, checks the server half, installs Chromium, runs the journey, and keeps the report", () => {
  const names = job.steps.map((s) => s.run ?? s.uses ?? "");
  const order = [/^npm ci$/, /npm run test:prepare/, /chat-smoke-journey\.integration\.test\.ts/, /playwright install --with-deps chromium/, /run-prod-e2e\.sh/];
  let last = -1;
  for (const pattern of order) {
    const index = names.findIndex((name) => pattern.test(name));
    assert.ok(index > last, `${pattern} runs after the step before it`);
    last = index;
  }
  const upload = job.steps.find((s) => s.uses?.startsWith("actions/upload-artifact"));
  assert.equal(upload?.if, "always()", "the report is published for a red run too");
  const server = step(/chat-smoke-journey\.integration\.test\.ts/);
  assert.match(server!.env!.SMOKE_JOURNEY_TEST_DATABASE_URL, /^postgresql:\/\/postgres@127\.0\.0\.1:55439\/[a-z0-9_]+_test$/);
});

test("every spec the journey names exists, and together they cover the five lifecycles", () => {
  const run = step(/run-prod-e2e\.sh/)!.run!;
  const targets = run.split(/\s+/).filter((token) => token.startsWith("e2e/"));
  assert.ok(targets.length > 0);
  const files: string[] = [];
  for (const target of targets) {
    const full = path.join(ROOT, target);
    assert.ok(existsSync(full), `${target} exists`);
    if (target.endsWith(".ts")) files.push(target);
    else for (const name of readdirSync(full)) if (name.endsWith(".spec.ts")) files.push(path.join(target, name));
  }
  const sources = files.map((file) => readFileSync(path.join(ROOT, file), "utf8")).join("\n");
  for (const [lifecycle, evidence] of [
    ["chat streaming", /text\\\/event-stream|text\/event-stream/],
    ["Stop", /\/api\/chat\/cancel/],
    ["regenerate", /regenerate/],
    ["artifacts", /\/api\/artifacts/],
    ["MCP add", /\/api\/mcp\/servers/],
  ] as const) {
    assert.match(sources, evidence, `the journey covers ${lifecycle}`);
  }
  // `--project=chromium`: the legacy project, which ignores auth.spec.ts and
  // e2e/wave2, so none of the named specs may live there.
  assert.match(run, /--project=chromium(\s|$)/);
  for (const file of files) assert.doesNotMatch(file, /auth\.spec\.ts$|wave2\//, `${file} would be ignored by the chromium project`);
});

test("the specs use the smoke provider's own directives, not copies of them", () => {
  const stop = readFileSync(path.join(ROOT, "e2e/journey/stop.spec.ts"), "utf8");
  const artifact = readFileSync(path.join(ROOT, "e2e/journey/artifact.spec.ts"), "utf8");
  for (const source of [stop, artifact]) assert.match(source, /from "\.\.\/\.\.\/src\/lib\/chat\/turn\/model-streams"/);
});
