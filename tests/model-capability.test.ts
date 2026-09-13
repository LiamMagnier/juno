import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideModelCapability, MODEL_CAPABILITY_TTL_MS } from "../src/lib/model-capability-policy";
import { classifyProviderError } from "../src/lib/provider-error";
import { nativeModelCatalog } from "../src/lib/native-model-manifest";
import type { ModelInfo } from "../src/lib/models";

const model = { id: "openai:gpt-5.6" };
const now = new Date("2026-08-08T12:00:00.000Z");

test("curated models remain routable before the first background probe", () => {
  assert.deepEqual(decideModelCapability(model, false, null, now), {
    allowed: true,
    reason: "curated-unprobed",
  });
});

test("discovered models fail closed until an operator proves them", () => {
  assert.deepEqual(decideModelCapability({ id: "vendor:new" }, true, null, now), {
    allowed: false,
    reason: "discovered-unprobed",
  });
});

test("failed and expired evidence route away, while a current pass routes", () => {
  const current = {
    status: "passed" as const,
    checkedAt: new Date(now.getTime() - 1_000),
    expiresAt: new Date(now.getTime() + MODEL_CAPABILITY_TTL_MS),
    probeVersion: 1,
  };
  assert.equal(decideModelCapability(model, false, current, now).allowed, true);
  assert.equal(
    decideModelCapability(model, false, { ...current, status: "failed" }, now).reason,
    "failed"
  );
  assert.equal(
    decideModelCapability(model, false, { ...current, expiresAt: now }, now).reason,
    "expired"
  );
});

test("native clients receive a visible health state instead of a misleading plan lock", () => {
  const fake: ModelInfo = {
    id: "openai:gpt-5.6",
    provider: "openai",
    providerModel: "gpt-5.6",
    name: "GPT-5.6",
    minPlan: "FREE",
    vision: true,
    reasoning: true,
    agenticTools: true,
    cost: 2,
    modality: "chat",
    webSearch: false,
    status: "current",
  };
  const catalog = nativeModelCatalog([fake], "PRO", new Map([[fake.id, { allowed: false, reason: "expired" }]]));
  const entry = catalog.models.find((candidate) => candidate.id === fake.id);
  assert.ok(entry);
  assert.equal(entry.availability, "health_check_failed");
  assert.equal(entry.availabilityReason, "expired");
});

test("the chat and cloud-code routes both enforce the same capability gate", () => {
  const chat = readFileSync("src/app/api/chat/route.ts", "utf8");
  const runner = readFileSync("src/app/api/code/tasks/[id]/runner-context/route.ts", "utf8");
  assert.match(chat, /modelCanRoute\(m, capabilityProbes\)/);
  assert.match(runner, /backendAgentCatalog\(availableModels, capabilityProbes\)/);
});

/*
 * A live not-found is the one provider verdict that is about the MODEL.
 *
 * `noteModelNotServed` is what closes the loop between "a user's message
 * failed because this id does not exist" and the capability table, which used
 * to be written only by an admin route and a manual script. Rather than reach
 * into Prisma, this pins the classification that gates the write — everything
 * downstream of it is `persistModelCapabilityProbe`, which the probe runner
 * already exercises.
 *
 * The two halves matter equally. Taking a 404 is what benches a dead id;
 * REFUSING everything else is what stops a rate limit, a capacity blip or an
 * expired key from benching a model that is perfectly fine.
 */
test("only a not-found verdict may bench a model from a live request", () => {
  const notFound = [
    { status: 404, message: "models/gemini-3.8-flash is not found for API version v1beta" },
    { status: 404, message: "The model `gpt-5.9` does not exist or you do not have access to it." },
  ];
  for (const err of notFound) {
    assert.equal(classifyProviderError(err).class, "not_found", `should bench: ${err.message}`);
  }

  const keepServing: Array<{ status: number; message: string; expect: string }> = [
    { status: 429, message: "Rate limit reached for requests", expect: "rate_limit" },
    { status: 503, message: "Internal server error", expect: "capacity" },
    { status: 401, message: "Incorrect API key provided", expect: "auth" },
    { status: 403, message: "Forbidden for this key", expect: "auth" },
    { status: 400, message: "Thinking level MEDIUM is not supported for this model", expect: "invalid_request" },
  ];
  for (const err of keepServing) {
    const klass = classifyProviderError(err).class;
    assert.equal(klass, err.expect, `${err.message} → ${klass}`);
    assert.notEqual(klass, "not_found", `must not bench a model over: ${err.message}`);
  }
});
