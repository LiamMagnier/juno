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
  assert.match(saved, /noteLiveProviderFault\(modelInfo\.provider, err, "chat", \{ requester: user\.id, modelId: modelInfo\.id \}\)/);
  assert.match(saved, /providerErrorRecovery\(err, \{ modelInfo, plan, history: modelHistory, requestedId, userId: user\.id \}\)/);
  assert.match(saved, /type: "error",\s*message,\s*quota,\s*finishReason: reason,\s*\.\.\.recovery,/);

  const privateTurn = read("src/lib/chat/turn/private-turn.ts");
  assert.match(privateTurn, /noteLiveProviderFault\(modelInfo\.provider, err, "private_chat", \{ requester: user\.id, modelId: modelInfo\.id \}\)/);
  assert.match(privateTurn, /providerErrorRecovery\(err, \{ modelInfo, plan, history: privateHistory, requestedId, userId: user\.id \}\)/);
  assert.match(privateTurn, /send\(\{ type: "error", message, quota, finishReason: reason, \.\.\.recovery \}\)/);
});

test("every offer clears the platform's training terms; an Auto turn's also clears the account's Auto data boundary", () => {
  const recovery = read("src/lib/chat/turn/failure-recovery.ts");
  assert.match(recovery, /input\.requestedId && isAutoModelId\(input\.requestedId\) \? await autoDataTerms\(input\.userId\) : null/);
  assert.match(recovery, /if \(autoTerms === "unreadable"\) return recovery;/, "no offer when the boundary cannot be read");
  assert.match(recovery, /const dataTerms = autoTerms \?\? \{ paidTier: autoPaidTierProviders\(\), boundary: "verified_no_training" as const \};/);
  assert.match(recovery, /clearsTrainingTerms: \(model\) => autoDataUseVerdict\(model, dataTerms\)\.eligible,/);
  assert.match(recovery, /select: \{ autoDataBoundary: true \}/);
  // And the wire class never says which account fault it was.
  assert.match(recovery, /errorClass: wireErrorClass\(normalized\.class\),/);
});

test("only what a model call threw feeds health from chat and background turns", () => {
  // streamChat marks what its adapters throw; the feed reads only marked errors.
  const llm = read("src/lib/llm.ts");
  assert.match(llm, /\} catch \(err\) \{\s*(?:\/\/[^\n]*\n\s*)*markModelCallError\(err\);\s*bench\(err\);\s*throw err;/);
  const health = read("src/lib/provider-health.ts");
  assert.match(health, /if \(isClassifiedFault\(fault\)\) classified = fault;\s*else if \(isModelCallError\(fault\)\) classified = classifyProviderError\(fault\);\s*else return;/);
});

test("the native model manifests mark a lab unavailable only for an account fault", () => {
  for (const route of ["src/app/api/v1/models/route.ts", "src/app/api/v1/bootstrap/route.ts"]) {
    const source = read(route);
    assert.match(source, /providerHealthy: providerAccountUsable \}\)/, `${route}: a short hold must not strand a lab in the apps`);
    assert.doesNotMatch(source, /import \{ providerHealthy \}/);
  }
});

test("the Work runner feeds every provider failure of a run's model calls, with the run and model as its source", () => {
  const runner = read("scripts/work-runner.ts");
  // agent-core retries one step up to four times: all of them, and the run's
  // later steps, are one source, so one run cannot meet the
  // repeated-capacity rule alone (it counts distinct sources).
  assert.match(
    runner,
    /try \{\s*yield\* provider\.stream\(request\);\s*\} catch \(error\) \{\s*noteWorkProviderFault\(provider\.id, error, \{ requester: runId, modelId: request\.model \}\);\s*throw error;/,
  );
  assert.match(runner, /classForWorkFailure\(failure\.kind, status\)/);
  assert.match(runner, /noteLiveProviderFault\(provider, \{ class: klass, status, raw: failure\.kind \}, "work", origin\)/);
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
  assert.match(memory, /if \(!ctrl\.signal\.aborted\) noteLiveProviderFault\(model\.provider, e, "background", \{ requester: opts\.userId, modelId: model\.id \}\)/);
  assert.match(memory, /isProviderHealthy: \(provider\) => providerHealthy\(/);
});

test("a restart seeds health from recent failed turns before serving, and the web process is the one that mails", () => {
  const boot = read("src/lib/boot.ts");
  assert.match(boot, /await seedProviderHealth\(\);/);
  assert.match(boot, /seedProviderHealthFromOutcomes\(\)/);
  assert.match(boot, /mailProviderOutagesFromThisProcess\(\);/);
  // The workers never designate themselves.
  for (const worker of ["scripts/work-runner.ts", "scripts/sweepers.ts"]) {
    assert.doesNotMatch(read(worker), /mailProviderOutagesFromThisProcess/, `${worker} logs, never mails`);
  }
});

test("media generation is refused only for an account fault, in the neutral sentence", () => {
  const pipeline = read("src/lib/media/generation-pipeline.ts");
  assert.match(pipeline, /if \(!providerAccountUsable\(model\.provider as Provider\)\) \{/);
  assert.match(pipeline, /`\$\{model\.name\} is temporarily unavailable\. Try again later, or choose another model\.`/);
  assert.doesNotMatch(pipeline, /account problem/, "the platform's account state is not the reader's to know");
  assert.doesNotMatch(pipeline, /\bproviderHealthy\(/, "chat's capacity holds do not block the media endpoints");
  const imageTool = read("src/lib/chat/image-tool.ts");
  assert.match(imageTool, /providerHealthy: \(provider\) => health\.providerAccountUsable\(provider as never\)/);
});
