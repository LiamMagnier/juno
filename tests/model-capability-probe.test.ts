import test from "node:test";
import assert from "node:assert/strict";
import {
  isTransportFailureStatus,
  probeRequestFor,
  probeResponseLooksValid,
} from "@/lib/model-capability-probe";
import {
  decideModelCapability,
  MODEL_CAPABILITY_TRANSPORT_FAILURE_TTL_MS,
  MODEL_CAPABILITY_TTL_MS,
} from "@/lib/model-capability-policy";
import { MODELS, type ModelInfo } from "@/lib/models";
import { providerAdapterFor } from "@/lib/provider-routing";

/*
 * THE HEADLINE DEFECT, pinned two ways.
 *
 * 1. The probe must speak the transport that will serve the request. It used to
 *    post /chat/completions with a Bearer token to every non-Anthropic
 *    provider — the OpenAI-compat shim for Google, an endpoint the Responses
 *    line 404s on by design — so both families failed a probe about a surface
 *    they never use.
 * 2. A failure must expire. It used to be permanent, and /api/chat treats the
 *    verdict as a hard eligibility gate, so one bad probe removed a whole lab
 *    from routing until a human re-ran a script.
 */

const fake = (over: Partial<ModelInfo> & Pick<ModelInfo, "id" | "provider" | "providerModel">): ModelInfo => ({
  name: over.providerModel,
  minPlan: "FREE",
  vision: true,
  reasoning: true,
  agenticTools: true,
  cost: 2,
  modality: "chat",
  webSearch: false,
  ...over,
});

test("Google is probed on the native GenerateContent surface with its own header", () => {
  const request = probeRequestFor(
    fake({ id: "google:gemini-3.8-flash", provider: "google", providerModel: "gemini-3.8-flash" }),
    "AIza-test",
  );
  assert.ok(request);
  assert.equal(request.adapter, "gemini-native");
  assert.match(
    request.url,
    /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/gemini-3\.8-flash:generateContent$/,
  );
  assert.equal(request.url.includes("/chat/completions"), false);
  assert.equal(request.headers["x-goog-api-key"], "AIza-test");
  assert.equal("authorization" in request.headers, false);
  assert.deepEqual(Object.keys(request.body).sort(), ["contents", "generationConfig"]);
  // The probe asks whether the id is callable, not whether a thinking ladder is.
  assert.equal("thinkingConfig" in (request.body.generationConfig as Record<string, unknown>), false);
});

test("Responses-only OpenAI models are probed on /responses, never /chat/completions", () => {
  const model = fake({
    id: "openai:gpt-5.5-pro",
    provider: "openai",
    providerModel: "gpt-5.5-pro",
    api: "responses",
  });
  assert.equal(providerAdapterFor(model), "openai-responses");
  const request = probeRequestFor(model, "sk-test");
  assert.ok(request);
  assert.match(request.url, /\/responses$/);
  assert.equal(request.headers.authorization, "Bearer sk-test");
  assert.equal(request.body.store, false);
  assert.equal(request.body.model, "gpt-5.5-pro");
});

test("Anthropic keeps its native messages endpoint, everyone else /chat/completions", () => {
  const claude = probeRequestFor(
    fake({ id: "anthropic:claude-sonnet-5", provider: "anthropic", providerModel: "claude-sonnet-5" }),
    "sk-ant",
  );
  assert.ok(claude);
  assert.equal(claude.url, "https://api.anthropic.com/v1/messages");
  assert.equal(claude.headers["anthropic-version"], "2023-06-01");

  const grok = probeRequestFor(fake({ id: "xai:grok-4.5", provider: "xai", providerModel: "grok-4.5" }), "xai-key");
  assert.ok(grok);
  assert.equal(grok.url, "https://api.x.ai/v1/chat/completions");
  assert.equal(grok.headers.authorization, "Bearer xai-key");
});

test("every curated chat model is probed on the transport that will serve it", () => {
  for (const model of Object.values(MODELS)) {
    if (model.modality !== "chat" || model.comingSoon) continue;
    const request = probeRequestFor(model, "key");
    assert.ok(request, `${model.id} has no probe request`);
    assert.equal(request.adapter, providerAdapterFor(model), `${model.id} probes the wrong adapter`);
  }
});

test("a valid answer is recognised per transport, and not across them", () => {
  assert.equal(probeResponseLooksValid("gemini", { candidates: [{}] }), true);
  assert.equal(probeResponseLooksValid("gemini", { choices: [{}] }), false);
  assert.equal(probeResponseLooksValid("responses", { output: [] }), true);
  assert.equal(probeResponseLooksValid("responses", { object: "response" }), true);
  assert.equal(probeResponseLooksValid("responses", { choices: [{}] }), false);
  assert.equal(probeResponseLooksValid("anthropic", { content: [] }), true);
  assert.equal(probeResponseLooksValid("openai", { choices: [] }), true);
  assert.equal(probeResponseLooksValid("openai", null), false);
});

test("a transport failure is told apart from a model the provider refused", () => {
  for (const status of [null, undefined, 429, 500, 502, 503, 401, 403, 408]) {
    assert.equal(isTransportFailureStatus(status), true, `${status} should be transport-class`);
  }
  for (const status of [400, 404, 422]) {
    assert.equal(isTransportFailureStatus(status), false, `${status} is about the model`);
  }
});

const now = new Date("2026-09-12T12:00:00.000Z");
const model = { id: "google:gemini-3.8-flash" };

test("a failed probe stops blocking once it goes stale", () => {
  const stale = {
    status: "failed" as const,
    checkedAt: new Date(now.getTime() - MODEL_CAPABILITY_TTL_MS - 1),
    expiresAt: new Date(now.getTime() - 1),
    probeVersion: 1,
  };
  assert.deepEqual(decideModelCapability(model, false, stale, now), {
    allowed: true,
    reason: "failed-expired",
  });
  // Fresh evidence still blocks — the fix is an expiry, not an amnesty.
  assert.deepEqual(
    decideModelCapability(model, false, { ...stale, expiresAt: new Date(now.getTime() + 1_000) }, now),
    { allowed: false, reason: "failed" },
  );
  // Discovered models stay fail-closed: they need a PASS, and a stale failure
  // is not one.
  assert.deepEqual(decideModelCapability({ id: "google:discovered" }, true, stale, now), {
    allowed: false,
    reason: "discovered-unprobed",
  });
});

test("a transport failure hides a lab for minutes, a refusal for a day", () => {
  const transport = {
    status: "failed" as const,
    checkedAt: now,
    expiresAt: new Date(now.getTime() + MODEL_CAPABILITY_TRANSPORT_FAILURE_TTL_MS),
    probeVersion: 1,
  };
  assert.equal(decideModelCapability(model, false, transport, now).allowed, false);
  const later = new Date(now.getTime() + MODEL_CAPABILITY_TRANSPORT_FAILURE_TTL_MS + 1);
  assert.equal(decideModelCapability(model, false, transport, later).allowed, true);
  // The model-level verdict is still alive at that same moment.
  const refused = { ...transport, expiresAt: new Date(now.getTime() + MODEL_CAPABILITY_TTL_MS) };
  assert.equal(decideModelCapability(model, false, refused, later).allowed, false);
});

test("no curated model can be excluded forever by a stale failure", () => {
  const wayLater = new Date(now.getTime() + MODEL_CAPABILITY_TTL_MS * 7);
  for (const candidate of Object.values(MODELS)) {
    if (candidate.modality !== "chat" || candidate.comingSoon) continue;
    const verdict = decideModelCapability(
      candidate,
      false,
      { status: "failed", checkedAt: now, expiresAt: new Date(now.getTime() + MODEL_CAPABILITY_TTL_MS), probeVersion: 1 },
      wayLater,
    );
    assert.equal(verdict.allowed, true, `${candidate.id} is permanently excluded`);
  }
});
