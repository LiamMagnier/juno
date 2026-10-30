/**
 * The agents journey's pieces that need no browser (e2e/agents-journey.spec.ts):
 * it is opt-in and local-only, its seed refuses any database that is not on
 * this machine, and its two scripts are ones the scripted Work model accepts
 * and that only call tools a cloud Work run is actually offered.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseScriptedWorkScript } from "../runner/agent-core/src/work/scripted-model";
import { AGENTS_JOURNEY_EMAIL, localDatabaseProblem } from "../e2e/support/agents-journey-account";
import { agentsJourneySkipReason } from "../e2e/support/agents-journey";
import { ANSWER, ASK_SCRIPT, DELIVER_SCRIPT, QUESTION } from "../e2e/support/agents-journey-scripts";

const ROOT = path.resolve(__dirname, "..");

test("the journey is opt-in and only ever uses a database on this machine", () => {
  assert.match(String(agentsJourneySkipReason({})), /AGENTS_JOURNEY=1/);
  assert.match(
    String(agentsJourneySkipReason({ AGENTS_JOURNEY: "1", DATABASE_URL: "postgresql://u:p@db.example.com:5432/juno" })),
    /Refusing db\.example\.com/
  );
  assert.equal(agentsJourneySkipReason({ AGENTS_JOURNEY: "1", DATABASE_URL: "postgresql://u:p@127.0.0.1:5432/juno" }), null);
  for (const local of ["postgresql://u@localhost/juno", "postgres://u@127.0.0.1:55439/x_test", "postgresql://u@[::1]:5432/juno"]) {
    assert.equal(localDatabaseProblem(local), null, local);
  }
  for (const [raw, why] of [
    [undefined, /not set/],
    ["not a url", /not a URL/],
    ["mysql://u@127.0.0.1/juno", /not a Postgres URL/],
    ["postgresql://u@10.0.0.5/juno", /Refusing 10\.0\.0\.5/],
  ] as const) {
    assert.match(String(localDatabaseProblem(raw)), why, String(raw));
  }
  assert.match(AGENTS_JOURNEY_EMAIL, /\.test$/, "a .test address, never a real one");
});

test("the seed refuses a database that is not on this machine before it connects", () => {
  const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/seed-agents-journey.ts"], {
    cwd: ROOT,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "/tmp",
      NODE_OPTIONS: "--conditions=react-server",
      DATABASE_URL: "postgresql://u:p@db.example.com:5432/juno",
    } as unknown as NodeJS.ProcessEnv,
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /Refusing db\.example\.com: the agents journey only uses a database on this machine\./);
});

test("the seed only ever deletes the account it made", () => {
  const seed = readFileSync(path.join(ROOT, "scripts/seed-agents-journey.ts"), "utf8");
  assert.match(seed, /if \(existing\.name !== AGENTS_JOURNEY_NAME\)/);
  assert.match(seed, /prisma\.user\.delete\(\{ where: \{ id: existing\.id \} \}\)/);
  assert.equal((seed.match(/\.delete(Many)?\(/g) ?? []).length, 2, "the user, and its own sign-in limiter buckets");
  assert.match(seed, /rateLimit\.deleteMany\(\{ where: \{ key: \{ startsWith: "signin:pair:", endsWith: `:\$\{AGENTS_JOURNEY_EMAIL\}` \} \} \}\)/);
});

/** The tool names a cloud Work run is offered, read from where they are defined. */
function offeredToolNames(): Set<string> {
  const session = readFileSync(path.join(ROOT, "runner/agent-core/src/work/session.ts"), "utf8");
  const tools = readFileSync(path.join(ROOT, "runner/agent-core/src/work/tools.ts"), "utf8");
  const names = new Set<string>();
  for (const [, name] of session.matchAll(/export const WORK_[A-Z_]+_TOOL_NAME = '([a-z_]+)'/g)) names.add(name!);
  for (const [, name] of tools.matchAll(/^\s+name: '([a-z_]+)',$/gm)) names.add(name!);
  return names;
}

test("both scripts are valid scripted-model scripts that only call offered tools", () => {
  const offered = offeredToolNames();
  for (const name of ["ask_user", "update_plan", "write_plan", "create_deliverable"]) assert.ok(offered.has(name), `${name} is offered`);
  for (const [label, script] of [["deliver", DELIVER_SCRIPT], ["ask", ASK_SCRIPT]] as const) {
    const parsed = parseScriptedWorkScript(JSON.parse(JSON.stringify(script)));
    assert.equal(parsed.steps.length, script.steps.length, label);
    assert.equal(parsed.vision, false, `${label}: no pixel tools`);
    for (const step of parsed.steps) {
      if (step.call) assert.ok(offered.has(step.call.name), `${label}: ${step.call.name} is a tool the run is offered`);
    }
    const last = parsed.steps.at(-1)!;
    assert.equal(last.end, true, `${label} ends on its own`);
    assert.ok(last.say, `${label} ends with a written answer`);
    // Every plan step it writes is closed, or the run could not be reported done.
    const written = parsed.steps.find((step) => step.call?.name === "write_plan")!.call!.input.steps as unknown[];
    const closed = new Set(
      parsed.steps.flatMap((step) => (step.call?.name === "update_plan" && step.call.input.status === "done" ? [String(step.call.input.stepId)] : []))
    );
    assert.deepEqual([...closed].sort(), written.map((_, index) => `s${index + 1}`), `${label}: every planned step is closed`);
    assert.equal(parsed.steps.filter((step) => step.call?.name === "create_deliverable").length, 1, `${label}: one deliverable`);
    // The first step's words are what the end-of-run check is handed (same
    // provider, a fresh transcript): never a YES/NO a judge would read as a verdict.
    assert.doesNotMatch(parsed.steps[0]!.say ?? "", /^\s*(YES|NO)\b/i, `${label}: the first words are not a verdict`);
  }
});

test("the asking script only finishes on the person's exact answer", () => {
  const steps = parseScriptedWorkScript(JSON.parse(JSON.stringify(ASK_SCRIPT))).steps;
  const asked = steps.findIndex((step) => step.call?.name === "ask_user");
  assert.ok(asked >= 0);
  assert.equal(steps.filter((step) => step.call?.name === "ask_user").length, 1, "it asks once");
  assert.equal(steps[asked]!.call!.input.question, QUESTION);
  const after = new RegExp(steps[asked + 1]!.expect!);
  assert.ok(after.test(ANSWER), "the answer passes");
  for (const other of ["Stopped before this finished.", "Cancelled.", `${ANSWER} please`, ""]) {
    assert.ok(!after.test(other), `"${other}" does not`);
  }
});
