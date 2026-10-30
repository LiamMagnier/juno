import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { afterEach, beforeEach, test } from "node:test";

/*
 * The "Answer with <model>" offer on a failed turn (chat wire 1.1), through
 * the real `providerErrorRecovery` the saved and private turns call.
 *
 * The rule under test: an offer is the platform choosing a model for the
 * reader to click, so it must clear the platform's own data-use record for
 * training — the model row AND the provider's terms
 * (src/lib/router/data-policy.ts) — whether the failed turn was an explicit
 * choice or Auto. On 2026-10-26 the Free default's lab ran out of credit; the
 * cheapest offer on a deployment with DeepSeek configured was a lab whose API
 * terms allow training.
 *
 * Nothing leaves the process: the keys are fakes set for this file only, no
 * provider is called, the capability probes and the settings row are
 * stand-ins, and `@/lib/alerts` is replaced.
 */

const mod = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const origLoad = mod._load;
/** The account's Auto data boundary (Settings.autoDataBoundary); null: never set. */
let boundary: string | null = null;
mod._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  if (request === "@/lib/alerts") return { alertOperator: () => "log_only" };
  if (request === "@/lib/prisma") {
    return { prisma: { settings: { findUnique: async () => (boundary ? { autoDataBoundary: boundary } : null) } } };
  }
  if (request === "@/lib/model-capability") {
    return { loadModelCapabilityMap: async () => new Map(), modelCanRoute: () => true };
  }
  if (request === "@/lib/router/chat-inputs") {
    const { parsePaidTierAttestation } = origLoad.call(this, "@/lib/router/data-policy", parent, false) as typeof import("@/lib/router/data-policy");
    return { autoPaidTierProviders: () => parsePaidTierAttestation(process.env.AUTO_ROUTER_PAID_TIER_PROVIDERS) };
  }
  return origLoad.call(this, request, parent, isMain);
};

const req = createRequire(import.meta.url);
const { providerErrorRecovery } = req("../src/lib/chat/turn/failure-recovery") as typeof import("@/lib/chat/turn/failure-recovery");
const { FREE_DEFAULT_MODEL, getModel } = req("../src/lib/models") as typeof import("@/lib/models");
const { PROVIDERS } = req("../src/lib/providers") as typeof import("@/lib/providers");
const { PROVIDER_DATA_POLICIES } = req("../src/lib/router/data-policy") as typeof import("@/lib/router/data-policy");
const health = req("../src/lib/provider-health") as typeof import("@/lib/provider-health");
const { AUTO_MODEL_ID } = req("../src/lib/auto-model") as typeof import("@/lib/auto-model");

const KEY_NAMES = [...new Set(Object.values(PROVIDERS).flatMap((p) => [p.apiKeyEnv, ...(p.apiKeyEnvAliases ?? [])]))];
const saved: Record<string, string | undefined> = {};

/** Configure exactly these labs (fake keys), and nothing else. */
function configure(...envNames: string[]) {
  for (const name of KEY_NAMES) delete process.env[name];
  for (const name of envNames) process.env[name] = `test-${name.toLowerCase()}`;
}

beforeEach(() => {
  for (const name of [...KEY_NAMES, "AUTO_ROUTER_PAID_TIER_PROVIDERS"]) saved[name] = process.env[name];
  delete process.env.AUTO_ROUTER_PAID_TIER_PROVIDERS;
  boundary = null;
  health.__setProviderHealthForTests([]);
});

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  health.__setProviderHealthForTests([]);
});

const unfunded = () => Object.assign(new Error("You exceeded your current quota | insufficient_quota"), { status: 429 });
const free = FREE_DEFAULT_MODEL;
const trainingOf = (modelId: string | undefined) =>
  modelId ? (PROVIDER_DATA_POLICIES as Record<string, { training: string }>)[getModel(modelId)!.provider]?.training : undefined;

test("an explicit choice's offer never names a lab whose API terms allow training (DeepSeek configured)", async () => {
  configure("DASHSCOPE_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY");
  const recovery = await providerErrorRecovery(unfunded(), {
    modelInfo: getModel(free)!,
    plan: "FREE",
    requestedId: free,
    userId: "user-1",
  });
  assert.equal(recovery.errorClass, "account", "the stream never says the platform ran out of credit");
  assert.ok(recovery.suggestedModelId, "an offer is still made");
  assert.notEqual(getModel(recovery.suggestedModelId!)?.provider, "deepseek", `${recovery.suggestedModelId}: DeepSeek's terms allow training`);
  assert.equal(trainingOf(recovery.suggestedModelId), "no");
  assert.equal(getModel(recovery.suggestedModelId!)?.provider, "qwen", "the cheapest lab whose terms clear");
});

test("a tier-dependent lab is offered only when the owner has attested its paid tier", async () => {
  configure("DASHSCOPE_API_KEY", "GOOGLE_API_KEY", "OPENAI_API_KEY");
  const unattested = await providerErrorRecovery(unfunded(), { modelInfo: getModel(free)!, plan: "FREE", requestedId: free, userId: "user-1" });
  assert.notEqual(getModel(unattested.suggestedModelId ?? "")?.provider, "google", "Google's unpaid tier trains, and no paid tier is attested");
  assert.equal(trainingOf(unattested.suggestedModelId), "no");

  process.env.AUTO_ROUTER_PAID_TIER_PROVIDERS = "google";
  const attested = await providerErrorRecovery(unfunded(), { modelInfo: getModel(free)!, plan: "FREE", requestedId: free, userId: "user-1" });
  assert.equal(getModel(attested.suggestedModelId ?? "")?.provider, "google", "attested: the cheapest lab is fair to offer");
});

test("a lab whose terms are unverified is never offered", async () => {
  configure("OPENAI_API_KEY", "ZHIPU_API_KEY", "MOONSHOT_API_KEY", "DEEPSEEK_API_KEY");
  const recovery = await providerErrorRecovery(unfunded(), { modelInfo: getModel(free)!, plan: "FREE", requestedId: free, userId: "user-1" });
  assert.equal(recovery.suggestedModelId, undefined, "every other configured lab trains or is unverified: no offer rather than a bad one");
  assert.equal(recovery.errorClass, "account");
});

test("an Auto turn's offer also stays inside the account's own boundary", async () => {
  configure("DASHSCOPE_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY");
  boundary = "eu_us_only";
  const onAuto = () =>
    providerErrorRecovery(unfunded(), { modelInfo: getModel(free)!, plan: "FREE", requestedId: AUTO_MODEL_ID, userId: "user-1" });
  const inside = await onAuto();
  assert.equal(getModel(inside.suggestedModelId ?? "")?.provider, "anthropic", "the cheapest clean lab inside the boundary");
  assert.equal(trainingOf(inside.suggestedModelId), "no");

  // With the only other EU/US lab down, Auto offers nothing rather than a
  // PRC lab its reader excluded...
  health.__setProviderHealthForTests([
    { provider: "anthropic", healthy: false, checkedAt: Date.now(), failure: "billing", detail: "402", source: "probe", recheckAt: null },
  ]);
  const outside = await onAuto();
  assert.equal(outside.suggestedModelId, undefined, "Qwen is outside eu_us_only");
  assert.equal(outside.errorClass, "account");

  // ...while the same failure on an explicit choice is held to the training
  // terms only, which Qwen's clear.
  const explicit = await providerErrorRecovery(unfunded(), { modelInfo: getModel(free)!, plan: "FREE", requestedId: free, userId: "user-1" });
  assert.equal(getModel(explicit.suggestedModelId ?? "")?.provider, "qwen");
  assert.equal(trainingOf(explicit.suggestedModelId), "no");
});
