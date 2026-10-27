import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifyProviderError as classifyWorkFailure } from "../runner/agent-core/src/providers/errors.js";
import { classForWorkFailure } from "@/lib/provider-health-policy";

/*
 * Every place a real turn meets a provider feeds provider health
 * (src/lib/provider-health.ts, `noteLiveProviderFault`). The recorder's rules
 * are unit-tested in provider-health-policy.test.ts and the chat path end to
 * end in chat-turn-pipeline.integration.test.ts; the Work runner and the
 * background walk are server-only scripts this suite cannot drive, so their
 * wiring is held here by reading it, and the one assumption the Work feed
 * makes about agent-core's errors is checked against agent-core itself.
 */

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("saved and private chat turns feed health and send the 1.1 recovery fields", () => {
  const saved = read("src/lib/chat/turn/run-turn.ts");
  assert.match(saved, /noteLiveProviderFault\(modelInfo\.provider, err, "chat"\)/);
  assert.match(saved, /providerErrorRecovery\(err, \{ modelInfo, plan, history: modelHistory \}\)/);
  assert.match(saved, /type: "error",\s*message,\s*quota,\s*finishReason: reason,\s*\.\.\.recovery,/);

  const privateTurn = read("src/lib/chat/turn/private-turn.ts");
  assert.match(privateTurn, /noteLiveProviderFault\(modelInfo\.provider, err, "private_chat"\)/);
  assert.match(privateTurn, /send\(\{ type: "error", message, quota, finishReason: reason, \.\.\.recovery \}\)/);
});

test("the Work runner feeds every provider failure of a run's model calls", () => {
  const runner = read("scripts/work-runner.ts");
  assert.match(runner, /try \{\s*yield\* provider\.stream\(request\);\s*\} catch \(error\) \{\s*noteWorkProviderFault\(provider\.id, error\);\s*throw error;/);
  assert.match(runner, /classForWorkFailure\(failure\.kind, status\)/);
  assert.match(runner, /noteLiveProviderFault\(provider, \{ class: klass, status, raw: failure\.kind \}, "work"\)/);
});

test("agent-core's errors have the shape the Work feed reads", () => {
  // The runner reads the error by shape (name, kind, status) because the
  // runtime is a separate package: prove the shape on the real classifier.
  const unfunded = classifyWorkFailure(Object.assign(new Error("Insufficient Balance"), { status: 402 }), "DeepSeek");
  assert.equal(unfunded.name, "ProviderCallError");
  assert.equal(unfunded.kind, "insufficient_balance");
  assert.equal(unfunded.status, 402);
  assert.equal(classForWorkFailure(unfunded.kind, unfunded.status), "billing");

  const deadKey = classifyWorkFailure(Object.assign(new Error("Unauthorized"), { status: 401 }), "Qwen");
  assert.equal(classForWorkFailure(deadKey.kind, deadKey.status), "auth");

  const overloaded = classifyWorkFailure(Object.assign(new Error("Overloaded"), { status: 529 }), "Anthropic");
  assert.equal(classForWorkFailure(overloaded.kind, overloaded.status), "capacity");

  const planLimit = classifyWorkFailure(
    Object.assign(new Error("402"), { status: 402, code: "QUOTA_EXCEEDED" }),
    "Juno",
    { viaJunoProxy: true },
  );
  assert.equal(classForWorkFailure(planLimit.kind, planLimit.status), null, "the person's own plan is not the lab's fault");
});

test("background jobs feed health and skip a lab known to be down", () => {
  const memory = read("src/lib/memory.ts");
  assert.match(memory, /if \(!ctrl\.signal\.aborted\) noteLiveProviderFault\(model\.provider, e, "background"\)/);
  assert.match(memory, /isProviderHealthy: \(provider\) => providerHealthy\(/);
});

test("a restart seeds health from recent failed turns before serving", () => {
  const boot = read("src/lib/boot.ts");
  assert.match(boot, /await seedProviderHealth\(\);/);
  assert.match(boot, /seedProviderHealthFromOutcomes\(\)/);
});
