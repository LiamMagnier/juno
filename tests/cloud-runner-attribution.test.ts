import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/*
 * Every model call a cloud Code run makes goes through /api/agent with the
 * task's own bearer, and agent-core's proxy provider sends `x-juno-run` when
 * it is given a run id (runner/agent-core/src/test/proxy-attribution.test.ts
 * covers the header itself). This pins the other half: that the runner hands
 * over the task id. Without it the header is simply absent, which is exactly
 * the kind of silence no behavioural test short of a real dispatch would see.
 *
 * The proxy does not record the header yet: ApiSpend has no column or JSON
 * field to hold it, and a schema change is its own piece of work.
 */

const SOURCE = readFileSync(new URL("../scripts/cloud-code-runner.mjs", import.meta.url), "utf8");

test("the cloud runner tells the proxy which task its model calls belong to", () => {
  const at = SOURCE.indexOf("createProxyProvider(\n");
  assert.notEqual(at, -1, "createProxyProvider( … ) is no longer called");
  // The config object is the call's first argument, which ends at the line
  // naming the provider id.
  const call = SOURCE.slice(at, SOURCE.indexOf("`backend/", at));
  assert.match(call, /\brunId:\s*TASK_ID\b/);
});
