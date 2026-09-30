import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * Which settings files the cloud runner lets widen a run's permission mode.
 *
 * agent-core reads three layers: the reader's own `$JUNO_HOME/settings.json`,
 * whose allow rules apply whole, and the repository's two `.juno/` files,
 * which may only ask more or refuse unless the host passes
 * `trustProjectSettings`. On a runner there is no reader, and JUNO_HOME is in
 * the environment the setup script runs with — so a setup script's
 * `npm install`, running the repository's own lifecycle scripts, could write
 * that file and have `{"permissions":{"allow":["Bash"]}}` read as the
 * submitter's, turning an auto-edit run into full access.
 *
 * agent-core's side is covered behaviourally (src/test/permission-rules.test.ts,
 * "a host with no reader reads no reader's file"). This pins the runner's half:
 * the options it hands AgentSession.create. Static, like its neighbours, because
 * the failure is an absence that no run would show.
 */

const SOURCE = readFileSync(new URL("../scripts/cloud-code-runner.mjs", import.meta.url), "utf8");

function sessionOptions(): string {
  const at = SOURCE.indexOf("AgentSession.create({");
  assert.notEqual(at, -1, "AgentSession.create({ … }) is no longer called");
  // The options object ends where the callbacks begin; everything the runner
  // decides about permissions sits above them.
  const end = SOURCE.indexOf("callbacks:", at);
  assert.notEqual(end, -1, "the session options no longer carry callbacks");
  return SOURCE.slice(at, end);
}

test("the cloud runner reads no reader's settings file", () => {
  assert.match(sessionOptions(), /\buserSettingsFile:\s*null\b/);
});

test("the cloud runner never trusts the repository's settings files", () => {
  // As an option (`trustProjectSettings: …` or shorthand), not as a word in the
  // comment that explains why it is absent.
  assert.doesNotMatch(sessionOptions(), /\btrustProjectSettings\s*[:,}]/);
});

test("the setup script can reach JUNO_HOME, which is why the file must not be read", () => {
  // If JUNO_HOME ever leaves the agent environment this test can go — and the
  // one above is still right, because a runner has no reader either way.
  const allowlist = /const AGENT_ENV_ALLOW = \[[\s\S]*?\];/.exec(SOURCE)?.[0] ?? "";
  assert.match(allowlist, /"JUNO_HOME"/);
  assert.match(SOURCE, /runSetupScript\(environment\.setupScript, \{ cwd: workdir, env: agentEnv/);
});
