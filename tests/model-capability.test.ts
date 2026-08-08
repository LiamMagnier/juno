import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decideModelCapability, MODEL_CAPABILITY_TTL_MS } from "../src/lib/model-capability-policy";
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
