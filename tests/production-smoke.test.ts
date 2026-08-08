import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
