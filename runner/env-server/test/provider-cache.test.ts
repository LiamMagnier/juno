import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { ProviderRegistry } from "../src/providers/registry.js";
import { NO_CAPABILITIES, type ProviderAdapter, type ProbeResult } from "../src/providers/types.js";
import { usageRetryAfterMs, DEFAULT_RETRY_AFTER_MS } from "../src/providers/limits.js";
import { silentLogger } from "../src/util.js";
import { tempDir } from "./helpers.js";

test("provider refresh shares in-flight work, caches 30 seconds and respects Retry-After", async () => {
  const dir = tempDir("probe-cache");
  let now = 0, calls = 0;
  let result: ProbeResult = { status: "ready" };
  const adapter: ProviderAdapter = {
    kind: "alevr", setup: () => null, capabilities: () => NO_CAPABILITIES,
    probe: async () => { calls++; await Promise.resolve(); return result; },
    openSession: async () => { throw new Error("A probe must not open a chat"); },
  };
  try {
    const registry = new ProviderRegistry({ dataDir: dir, adapters: new Map([["alevr", adapter]]), logger: silentLogger, searchDirs: [], now: () => now });
    await Promise.all([registry.probe("alevr", { maxAgeMs: 30_000 }), registry.probe("alevr", { maxAgeMs: 30_000 })]);
    assert.equal(calls, 1);
    now = 29_999; await registry.probe("alevr", { maxAgeMs: 30_000 }); assert.equal(calls, 1);
    now = 30_000; await registry.probe("alevr", { maxAgeMs: 30_000 }); assert.equal(calls, 2);
    await registry.probe("alevr"); assert.equal(calls, 3, "explicit checks normally bypass the age cache");
    result = { status: "ready", retryAfterMs: 120_000 };
    const throttled = await registry.probe("alevr"); assert.equal(calls, 4);
    assert.equal("retryAfterMs" in throttled, false, "vendor throttle policy is server-private");
    now += 119_999; await registry.probe("alevr"); assert.equal(calls, 4, "manual checks also respect vendor throttling");
    now += 1; await registry.probe("alevr"); assert.equal(calls, 5);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("usage Retry-After handles structured 429 errors and bounded fallback", () => {
  assert.equal(usageRetryAfterMs({ status: 429, headers: { "retry-after": "120" } }), 120_000);
  assert.equal(usageRetryAfterMs({ status: 429, headers: new Headers({ "retry-after": "120" }) }), 120_000);
  const now = Date.parse("2026-10-11T00:00:00Z");
  assert.equal(usageRetryAfterMs({ status: 429, headers: { "retry-after": "Sun, 11 Oct 2026 00:10:00 GMT" } }, now), 600_000);
  assert.equal(usageRetryAfterMs(new Error("429 Too Many Requests")), DEFAULT_RETRY_AFTER_MS);
  assert.equal(usageRetryAfterMs(new Error("rate limited, retry after 2 minutes")), 120_000);
  assert.equal(usageRetryAfterMs(new Error("network unavailable")), undefined);
});
