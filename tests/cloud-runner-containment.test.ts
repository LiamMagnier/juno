import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * The cloud runner's container boundary, pinned by ordering.
 *
 * hardenDriverEnv() strips every JUNO_* key that is not in AGENT_ENV_ALLOW,
 * and AGENT_ENV_ALLOW contains only JUNO_HOME. The workflow sets
 * JUNO_RUNNER_SANDBOX_IMAGE (code-runner.yml) to turn the container on. For a
 * period, harden ran first and the read came eighteen lines later, so
 * containerSandboxFromEnv saw an environment with the variable already
 * deleted, returned null, and every cloud run executed agent-authored bash
 * directly on the runner VM — while the comments around the call described the
 * container at length.
 *
 * That failure is invisible from the outside: the run succeeds, the logs are
 * clean, and the only symptom is an absence. So the test is a static one over
 * the source. A behavioural test would need Docker and a real dispatch, which
 * is exactly why nothing tested it.
 */

const SOURCE = readFileSync(
  new URL("../scripts/cloud-code-runner.mjs", import.meta.url),
  "utf8"
);

test("the sandbox configuration is read before the driver environment is stripped", () => {
  const read = SOURCE.indexOf("containerSandboxFromEnv(process.env");
  const harden = SOURCE.indexOf("hardenDriverEnv();");

  assert.notEqual(read, -1, "containerSandboxFromEnv(process.env, …) is no longer called");
  assert.notEqual(harden, -1, "hardenDriverEnv() is no longer called");
  assert.ok(
    read < harden,
    "hardenDriverEnv() deletes JUNO_RUNNER_SANDBOX_IMAGE, so reading the sandbox " +
      "configuration after it always yields null and agent bash escapes the container"
  );
});

test("hardening really does strip the sandbox variables, which is why order matters", () => {
  // Replayed rather than asserted from the allowlist, so this keeps describing
  // reality if someone changes the fix to widen AGENT_ENV_ALLOW instead.
  const allowlist = /const AGENT_ENV_ALLOW = \[[\s\S]*?\];/.exec(SOURCE)?.[0];
  const harden = /function hardenDriverEnv\(\) \{[\s\S]*?\n\}/.exec(SOURCE)?.[0];
  assert.ok(allowlist, "AGENT_ENV_ALLOW is no longer declared as a literal array");
  assert.ok(harden, "hardenDriverEnv is no longer declared as a function statement");

  const build = new Function(
    "process",
    `${allowlist}\n${harden}\nreturn hardenDriverEnv;`
  ) as (p: { env: Record<string, string | undefined> }) => () => void;

  const fake = {
    env: {
      PATH: "/usr/bin",
      HOME: "/root",
      JUNO_HOME: "/tmp/juno-home",
      JUNO_RUNNER_SANDBOX_IMAGE: "ghcr.io/juno/agent-sandbox:1",
      JUNO_RUNNER_SANDBOX_NETWORK: "none",
    } as Record<string, string | undefined>,
  };
  build(fake)();

  assert.equal(
    fake.env.JUNO_RUNNER_SANDBOX_IMAGE,
    undefined,
    "if hardening ever stops stripping this, the ordering assertion above is no longer load-bearing " +
      "and this test should be rewritten rather than deleted"
  );
  assert.equal(fake.env.JUNO_HOME, "/tmp/juno-home", "JUNO_HOME is on the allowlist and must survive");
});

test("a run with no container refuses rather than falling back to the host", () => {
  // The production driver must make the failure explicit and refuse to run.
  // Keeping the reason in the error makes a missing image diagnosable without
  // weakening the fail-closed boundary.
  assert.match(
    SOURCE,
    /refusing to run agent-authored commands on the runner host/,
    "the runner must refuse to execute agent commands when no container sandbox is configured"
  );
  assert.match(
    SOURCE,
    /no container sandbox configured/,
    "the refusal must identify the missing sandbox configuration"
  );
});
