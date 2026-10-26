import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("../scripts/production-smoke.mjs", import.meta.url));

function runSmoke(overrides: Record<string, string>) {
  return spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      JUNO_SMOKE_BASE_URL: "http://127.0.0.1:9",
      JUNO_SMOKE_REQUIRE_AUTH: "1",
      JUNO_SMOKE_TOKEN: "",
      JUNO_SMOKE_COOKIE: "",
      JUNO_SMOKE_RUN_CHAT: "",
      ...overrides,
    },
  });
}

test("authenticated smoke refuses to reach the network without a credential", () => {
  const result = runSmoke({ JUNO_SMOKE_RUN_CHAT: "1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires JUNO_SMOKE_TOKEN or JUNO_SMOKE_COOKIE/);
  assert.doesNotMatch(result.stderr, /fetch failed|ECONNREFUSED/i);
});

test("authenticated smoke refuses to run without the provider-backed chat path", () => {
  const result = runSmoke({ JUNO_SMOKE_TOKEN: "test-token" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /requires JUNO_SMOKE_RUN_CHAT=1/);
  assert.doesNotMatch(result.stderr, /fetch failed|ECONNREFUSED/i);
});

test("smoke requires a base URL before any health request", () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    encoding: "utf8",
    env: { ...process.env, JUNO_SMOKE_BASE_URL: "" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /JUNO_SMOKE_BASE_URL is required/);
});

test("the smoke skips a provider only for a dead key or exhausted credit, in provider-error's own words", async () => {
  // The gate matches the copy of the error frame (production-smoke.mjs,
  // PROVIDER_ACCOUNT_FAILURE): hold it to the sentences the app really sends.
  const { normalizeProviderError } = await import("../src/lib/provider-error");
  const literal = readFileSync(SCRIPT, "utf8").match(/const PROVIDER_ACCOUNT_FAILURE = \/(.+)\/i;/);
  assert.ok(literal, "the discriminator is a regex literal");
  const skip = new RegExp(literal[1], "i");
  const said = (err: unknown) => normalizeProviderError(err, { model: "Qwen3.6 Flash", provider: "Alibaba · Qwen" }).userMessage;
  assert.match(said({ status: 401, message: "Incorrect API key provided" }), skip, "a dead key is the account's");
  assert.match(said({ status: 402, message: "Payment required" }), skip, "exhausted credit is the account's");
  for (const status of [400, 429, 500, 503]) {
    assert.doesNotMatch(said({ status, message: "upstream error" }), skip, `${status} is the release's to answer for`);
  }
});
