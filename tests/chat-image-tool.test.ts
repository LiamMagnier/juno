import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Plan } from "@prisma/client";
import { GEN_MODELS, MODEL_LIST, type ModelInfo } from "@/lib/models";
import {
  GENERATE_IMAGE_TOOL,
  GENERATE_IMAGE_TOOL_ID,
  chatImageToolEnabled,
  createGenerateImageTool,
  readImageToolArgs,
  routeFailure,
  type ImageToolContext,
  type ImageToolDeps,
} from "@/lib/chat/image-tool";
import { routeImage, NoImageModelError, defaultImageModel, imageModelAvailable, matchImageModel } from "@/lib/router/image-route";
import { detectImageIntent } from "@/lib/router/image-intent";
import {
  MAX_IMAGE_CALLS_PER_TURN,
  imageToolParams,
  nearestAspect,
  readImageGeneration,
  type ClientImageGeneration,
} from "@/lib/media/image-generation";
import { parseRoutingReceipt } from "@/lib/router/receipt";
import { routeAuto } from "@/lib/router/decide";
import type { ClientActivityEvent, ClientAttachment } from "@/types/chat";
import type { MediaAdmission, MediaRefusal } from "@/lib/media/generation-pipeline";

/*
 * G04 — pictures in chat. Everything here runs with fakes: no provider, no
 * storage, no database, no key. The shared pipeline's own gates are pinned at
 * the bottom against its source and exercised end to end, with a real
 * database, by tests/chat-image-pipeline.integration.test.ts.
 */

const IMAGES = GEN_MODELS.filter((m) => m.modality === "image");
const byId = (id: string) => {
  const model = IMAGES.find((m) => m.id === id);
  assert.ok(model, `catalogue has ${id}`);
  return model;
};
const everyone = () => true;
const PAID = new Set(["google", "openai", "xai", "meta", "minimax", "zhipu"]);

// ---------------------------------------------------------------------------
// Choosing the image model
// ---------------------------------------------------------------------------

test("Auto picks a current image model the plan, keys and data boundary allow", () => {
  const decision = routeImage({ plan: "PRO", isConfigured: everyone, paidTier: PAID });
  assert.equal(decision.auto, true);
  assert.equal(decision.model.modality, "image");
  assert.equal(decision.model.status, "current");
  assert.ok(decision.ranked.every((m) => m.status === "current"));
  assert.ok((decision.excluded.unavailable_in_catalogue ?? 0) > 0, "deprecated image models are never picked");
});

test("the plan filter holds: a free account only gets free image models", () => {
  const decision = routeImage({ plan: "FREE", isConfigured: everyone, paidTier: PAID });
  assert.equal(decision.model.minPlan, "FREE");
  assert.ok(decision.ranked.every((m) => m.minPlan === "FREE"));
  assert.ok((decision.excluded.not_in_plan ?? 0) > 0);
});

test("only providers with a key are eligible, and none at all refuses with the counts", () => {
  const onlyGoogle = routeImage({ plan: "PRO", isConfigured: (p) => p === "google", paidTier: PAID });
  assert.equal(onlyGoogle.model.provider, "google");
  assert.throws(
    () => routeImage({ plan: "PRO", isConfigured: () => false }),
    (err: unknown) => err instanceof NoImageModelError && (err.excluded.provider_not_configured ?? 0) > 0,
  );
});

test("Auto's data boundary is respected: unattested tiers and excluded jurisdictions drop out", () => {
  // Google's training terms depend on a paid tier the deployment must attest.
  const unattested = routeImage({ plan: "PRO", isConfigured: everyone, paidTier: new Set(["openai", "xai", "meta"]) });
  assert.ok(unattested.ranked.every((m) => m.provider !== "google"));
  assert.ok((unattested.excluded.data_use_terms ?? 0) > 0);
  // Zhipu (GLM Image) and MiniMax are PRC-based.
  const noPrc = routeImage({ plan: "PRO", isConfigured: everyone, paidTier: PAID, boundary: "exclude_prc" });
  assert.ok(noPrc.ranked.every((m) => m.provider !== "zhipu" && m.provider !== "minimax"));
  const euUs = routeImage({ plan: "PRO", isConfigured: everyone, paidTier: PAID, boundary: "eu_us_only" });
  assert.ok(euUs.ranked.every((m) => m.provider !== "zhipu" && m.provider !== "minimax"));
});

test("a model the person named is their choice: it skips the data boundary but never the plan", () => {
  const named = routeImage({
    plan: "PRO",
    requested: "Nano Banana Pro",
    isConfigured: everyone,
    paidTier: new Set(), // Google unattested: Auto could not pick it
  });
  assert.equal(named.model.id, byId("google:gemini-3-pro-image").id);
  assert.equal(named.auto, false);
  assert.throws(
    () => routeImage({ plan: "FREE", requested: "Nano Banana Pro", isConfigured: everyone }),
    (err: unknown) => err instanceof NoImageModelError && err.requested?.reason === "not_in_plan",
  );
  assert.equal(matchImageModel("gpt-image-2.5-flare")?.id, "openai:gpt-image-2.5-flare");
  assert.equal(matchImageModel("Claude Opus"), null, "a chat model is never an image model");
});

test("a reference picture needs a model that edits", () => {
  // A top-quality model on a lab with no edit endpoint wins a fresh picture and
  // drops out the moment a reference is involved.
  const noEdit: ModelInfo = { ...byId("google:gemini-3-pro-image"), id: "mistral:test-no-edit", provider: "mistral", cost: 1 };
  const catalogue = [noEdit, ...IMAGES];
  const fresh = routeImage({ plan: "PRO", catalogue, isConfigured: everyone, paidTier: new Set([...PAID, "mistral"]) });
  assert.equal(fresh.model.id, noEdit.id);
  const edit = routeImage({ plan: "PRO", needsEdit: true, catalogue, isConfigured: everyone, paidTier: new Set([...PAID, "mistral"]) });
  assert.notEqual(edit.model.id, noEdit.id);
  assert.equal(edit.excluded.cannot_edit, 1);
  assert.ok(edit.reasons[0]?.includes("reference"));
});

test("a provider reporting trouble is skipped while another can answer", () => {
  const healthy = routeImage({ plan: "PRO", isConfigured: everyone, paidTier: PAID, isProviderAvailable: (p) => p !== "google" && p !== "openai" });
  assert.ok(healthy.ranked.every((m) => m.provider !== "google" && m.provider !== "openai"));
  assert.ok((healthy.excluded.provider_unavailable ?? 0) > 0);
  const allDown = routeImage({ plan: "PRO", isConfigured: everyone, paidTier: PAID, isProviderAvailable: () => false });
  assert.equal(allDown.degraded, "all_providers_unavailable");
});

test("the remaining budget narrows the pick to what fits, or to the cheapest honest attempt", () => {
  const cost = (id: string) => (byId(id).cost === 1 ? 10_000 : byId(id).cost === 2 ? 40_000 : 130_000);
  const fits = routeImage({ plan: "PRO", isConfigured: everyone, paidTier: PAID, costOf: cost, remainingBudgetMicroUsd: 20_000 });
  assert.ok(fits.ranked.every((m) => m.cost === 1));
  assert.ok((fits.excluded.over_budget ?? 0) > 0);
  const broke = routeImage({ plan: "PRO", isConfigured: everyone, paidTier: PAID, costOf: cost, remainingBudgetMicroUsd: 1 });
  assert.equal(broke.degraded, "over_budget");
  assert.equal(broke.model.cost, 1);
});

test("the preference moves the pick between best picture and cheapest", () => {
  const quality = routeImage({ plan: "PRO", isConfigured: everyone, paidTier: PAID, preference: "quality" });
  const economy = routeImage({ plan: "PRO", isConfigured: everyone, paidTier: PAID, preference: "economy" });
  assert.ok(quality.model.cost >= economy.model.cost);
  assert.equal(economy.model.cost, 1);
});

test("the composer's default: last used when still usable, else the best usable", () => {
  const locked = (m: ModelInfo, plan: Plan) => plan === "FREE" && m.minPlan !== "FREE";
  assert.equal(defaultImageModel(GEN_MODELS, "PRO", "openai:gpt-image-2.5-sunburst", locked)?.id, "openai:gpt-image-2.5-sunburst");
  const free = defaultImageModel(GEN_MODELS, "FREE", "openai:gpt-image-2.5-sunburst", locked);
  assert.equal(free?.minPlan, "FREE", "a locked last-used model is not reopened");
  assert.equal(defaultImageModel(MODEL_LIST.filter((m) => m.modality === "chat"), "PRO"), null);
  assert.equal(imageModelAvailable("PRO", GEN_MODELS, everyone), true);
  assert.equal(imageModelAvailable("PRO", GEN_MODELS, () => false), false);
});

// ---------------------------------------------------------------------------
// Auto routing: a clear image request
// ---------------------------------------------------------------------------

test("intent: clear picture requests in English and French, never code or reading a picture", () => {
  for (const yes of [
    "Draw me a fox in the snow",
    "Generate an image of a cat astronaut",
    "Create a logo for my bakery called Crumb",
    "Can you make me a poster for a jazz night?",
    "Génère une image d'un chat sur la lune",
    "Dessine-moi un mouton",
    "Crée un logo pour ma boulangerie",
  ]) {
    assert.equal(detectImageIntent(yes), true, yes);
  }
  for (const no of [
    "How do I generate an image in Python?",
    "Describe this image",
    "What is in the attached picture?",
    "Write a function to create an image thumbnail",
    "Explain how diffusion models generate images",
    "Comment générer une image avec Python ?",
    "Make a plan for my week",
    "",
  ]) {
    assert.equal(detectImageIntent(no), false, no);
  }
});

test("Auto sends an image request to a model that can call the image tool, and says why", () => {
  const catalogue = MODEL_LIST.filter((m) => m.modality === "chat");
  const decision = routeAuto({
    message: "Draw me a fox in the snow",
    plan: "PRO",
    wantsImage: true,
    catalogue,
    isConfigured: everyone,
    canUse: () => true,
    paidTier: PAID,
  });
  assert.equal(decision.model.agenticTools, true);
  assert.equal(decision.reasons[0], "an image request");
  assert.equal(decision.profile.needs.toolReliability, true);
  const plain = routeAuto({ message: "Draw me a fox in the snow", plan: "PRO", catalogue, isConfigured: everyone, canUse: () => true, paidTier: PAID });
  assert.notEqual(plain.reasons[0], "an image request");
});

test("Auto's receipt records the image model, and an old receipt still reads", () => {
  const receipt = parseRoutingReceipt({
    v: 1,
    effort: null,
    taskClass: "everyday",
    reasons: ["an image request"],
    image: { model: "google:gemini-nano-banana-2.1", name: "Nano Banana 2.1", auto: true },
  });
  assert.deepEqual(receipt?.image, { model: "google:gemini-nano-banana-2.1", name: "Nano Banana 2.1", auto: true });
  const old = parseRoutingReceipt({ v: 1, effort: null, taskClass: "everyday", reasons: [] });
  assert.equal(old?.image, undefined);
});

// ---------------------------------------------------------------------------
// The request in the pipeline's terms
// ---------------------------------------------------------------------------

test("the tool's aspect maps to the nearest one the model offers, and the count to what it returns", () => {
  assert.equal(nearestAspect("openai:gpt-image-2.5-sunburst", "16:9"), "16:9");
  // Muse offers square, 2:3 and 3:2 only: widescreen is nearest 3:2.
  assert.equal(nearestAspect("meta:muse-image-1.0", "16:9"), "3:2");
  assert.equal(nearestAspect("meta:muse-image-1.0", "9:16"), "2:3");
  const gpt = imageToolParams("openai:gpt-image-2.5-sunburst", { aspect: "9:16", count: 3, transparent: true });
  assert.equal(gpt.params.aspect, "9:16");
  assert.equal(gpt.count, 3);
  assert.equal(gpt.params.background, "transparent");
  const edit = imageToolParams("openai:gpt-image-2.5-sunburst", { count: 4, edit: true });
  assert.equal(edit.count, 1, "an edit returns one picture");
  assert.equal(edit.params.count, undefined);
});

test("arguments are read defensively", () => {
  assert.equal(readImageToolArgs({}), null);
  assert.equal(readImageToolArgs({ prompt: "   " }), null);
  const args = readImageToolArgs({ prompt: " a fox ", count: 99, aspect: "wide", reference: "latest", transparent: "yes" });
  assert.deepEqual(args, { prompt: "a fox", aspect: null, count: 4, transparent: false, reference: "latest", model: null });
  assert.equal(GENERATE_IMAGE_TOOL.function.name, GENERATE_IMAGE_TOOL_ID);
  assert.deepEqual((GENERATE_IMAGE_TOOL.function.parameters as { required: string[] }).required, ["prompt"]);
});

test("the saved row reads back without live URLs, and a row cut off mid-call reads as failed", () => {
  const saved = readImageGeneration({
    v: 1,
    callId: "image-1",
    status: "done",
    prompt: "a fox",
    modelId: "google:gemini-nano-banana-2.1",
    modelName: "Nano Banana 2.1",
    auto: true,
    aspect: "1:1",
    count: 1,
    referenceAttachmentId: null,
    attachmentIds: ["att_1"],
    images: [{ id: "att_1", url: "https://signed.example/stale" }],
  });
  assert.ok(saved);
  assert.equal(saved.images, undefined);
  assert.deepEqual(saved.attachmentIds, ["att_1"]);
  const cut = readImageGeneration({ v: 1, callId: "image-2", status: "generating", prompt: "a fox", count: 1 });
  assert.equal(cut?.status, "failed");
  assert.equal(cut?.failure?.code, "provider_error");
  assert.equal(readImageGeneration({ v: 2, callId: "x", status: "done" }), undefined);
  assert.equal(readImageGeneration({ v: 1, callId: "x", status: "done", failure: { code: "made_up" } })?.failure, null);
});

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

const OPEN_GATE = {
  privateMode: false,
  voiceMode: false,
  userMessageId: "msg_1",
  researchActive: false,
  artifactEdit: false,
  conversationKind: "chat",
  agenticTools: true,
  functionToolsReachModel: true,
  skillPermits: true,
  lockdown: false,
  imageModelAvailable: true,
};

test("the tool rides only turns that can make and keep a picture", () => {
  assert.equal(chatImageToolEnabled(OPEN_GATE), true);
  for (const [key, value] of [
    ["privateMode", true],
    ["voiceMode", true],
    ["userMessageId", null],
    ["researchActive", true],
    ["artifactEdit", true],
    ["conversationKind", "code"],
    ["agenticTools", false],
    ["functionToolsReachModel", false],
    ["skillPermits", false],
    ["lockdown", true],
    ["imageModelAvailable", false],
  ] as const) {
    assert.equal(chatImageToolEnabled({ ...OPEN_GATE, [key]: value }), false, `${key}=${String(value)} closes the gate`);
  }
});

// ---------------------------------------------------------------------------
// The tool, with fake ports
// ---------------------------------------------------------------------------

function fakeAdmission(modelId: string): MediaAdmission {
  const model = byId(modelId);
  return {
    ok: true,
    user: { id: "user_1" },
    plan: "PRO",
    model,
    media: "image",
    prompt: "a fox",
    providerPrompt: "a fox",
    genPlan: { params: null, wire: null, count: 1 },
    baseCost: 40_000,
    cost: { perOutputMicroUsd: 40_000, estimateMicroUsd: 40_000 } as MediaAdmission["cost"],
    edit: null,
    quota: { plan: "PRO", used: 2, limit: 1000, remaining: 998 },
    spendRef: "generate:test",
    budgetResetsAtMs: null,
  };
}

function harness(overrides: Partial<ImageToolDeps> = {}, ctx: Partial<ImageToolContext> = {}) {
  const log: ClientActivityEvent[] = [];
  const frames: ClientImageGeneration[] = [];
  const calls = { admit: 0, run: 0, save: 0 };
  const generated: string[] = [];
  const models: Array<{ id: string; auto: boolean }> = [];
  let seq = 0;
  const deps: ImageToolDeps = {
    async admit(req) {
      calls.admit += 1;
      return fakeAdmission(req.modelId);
    },
    async run(admission, opts) {
      calls.run += 1;
      const value = await opts.persist(
        [{ bytes: Buffer.from("png"), mimeType: "image/png", ext: "png", key: "uploads/u/k.png", fileName: "a.png" }],
        { kind: "IMAGE", replyText: "", totalBytes: 3 },
      );
      return { ok: true, value, quota: admission.quota };
    },
    async saveAttachments({ files }) {
      calls.save += 1;
      return files.map((file, index): ClientAttachment => ({
        id: `att_${index + 1}`,
        kind: "IMAGE",
        fileName: file.fileName,
        mimeType: file.mimeType,
        size: file.bytes.length,
        url: `/api/files/${file.key}`,
      }));
    },
    async findReference({ reference }) {
      return reference === "latest" ? "att_ref" : null;
    },
    providerHealthy: () => true,
    providerConfigured: () => true,
    imageCost: () => 40_000,
    failureSentence: (_err, model) => `${model.name} could not make this image.`,
    async autoSettings() {
      return { paidTier: PAID };
    },
    ...overrides,
  };
  const tool = createGenerateImageTool({
    user: { id: "user_1", email: "person@example.test" },
    conversation: { id: "conv_123456", projectId: null },
    plan: "PRO",
    userRequest: "Draw me a fox in the snow",
    turnAttachmentIds: [],
    untrustedContent: false,
    sendActivity: (event) => {
      const entry = { ...event, id: `activity-${seq++}`, createdAt: new Date(0).toISOString() } as ClientActivityEvent;
      log.push(entry);
      if (entry.imageGeneration) frames.push(structuredClone(entry.imageGeneration));
      return entry;
    },
    resendActivity: (entry) => {
      if (entry.imageGeneration) frames.push(structuredClone(entry.imageGeneration));
    },
    generatedAttachmentIds: generated,
    onImageModel: (model) => models.push({ id: model.id, auto: model.auto }),
    deps,
    ...ctx,
  });
  return { tool, log, frames, calls, generated, models };
}

test("a picture: generating, then done with the files, linked for the answer and named on the receipt", async () => {
  const h = harness();
  const result = await h.tool.execute({ prompt: "A fox in the snow, watercolour", aspect: "16:9" });
  assert.equal(result.ok, true);
  const told = JSON.parse(result.text);
  assert.equal(told.status, "created");
  assert.deepEqual(told.attachmentIds, ["att_1"]);
  assert.equal(h.log.length, 1, "one activity row, replaced in place");
  assert.deepEqual(h.frames.map((f) => f.status), ["generating", "done"]);
  const done = h.frames.at(-1)!;
  assert.ok(done.modelId && done.modelName);
  assert.equal(done.auto, true);
  assert.deepEqual(done.attachmentIds, ["att_1"]);
  assert.equal(done.images?.[0]?.id, "att_1");
  assert.deepEqual(h.generated, ["att_1"]);
  assert.equal(h.models.length, 1);
  assert.deepEqual(h.calls, { admit: 1, run: 1, save: 1 });
});

test("a refusal from the pipeline's admission names the cause, and nothing runs or is billed", async () => {
  const refusal: MediaRefusal = {
    ok: false,
    status: 402,
    body: { error: "x", code: "QUOTA_EXCEEDED" },
    code: "quota_exhausted",
    message: "You've reached your monthly message limit. Upgrade your plan to keep generating.",
  };
  const h = harness({ admit: async () => refusal });
  const result = await h.tool.execute({ prompt: "a fox" });
  assert.equal(result.ok, false);
  assert.equal(JSON.parse(result.text).reason, "quota_exhausted");
  assert.equal(h.calls.run, 0, "no provider call after a refusal");
  assert.equal(h.frames.at(-1)?.status, "failed");
  assert.equal(h.frames.at(-1)?.failure?.code, "quota_exhausted");
  assert.deepEqual(h.generated, []);
});

for (const code of ["budget_exceeded", "rate_limited", "policy_violation", "plan_required", "workspace_disabled", "provider_unavailable"] as const) {
  test(`admission's ${code} reaches the card with its own code`, async () => {
    const h = harness({
      admit: async () => ({ ok: false, status: 402, body: {}, code, message: `refused: ${code}`, model: "Nano Banana 2.1", plan: "MAX" }),
    });
    await h.tool.execute({ prompt: "a fox" });
    const failure = h.frames.at(-1)?.failure;
    assert.equal(failure?.code, code);
    assert.equal(failure?.message, `refused: ${code}`);
    assert.equal(h.calls.run, 0);
  });
}

test("a provider failure after admission is reported in safe words with its cause", async () => {
  const h = harness({
    run: async (admission) => ({ ok: false, message: "raw 500 body", code: "provider_unavailable", quota: admission.quota, error: new Error("raw 500 body") }),
  });
  const result = await h.tool.execute({ prompt: "a fox" });
  assert.equal(result.ok, false);
  const failure = h.frames.at(-1)!.failure!;
  assert.equal(failure.code, "provider_unavailable");
  assert.match(failure.message, /could not make this image/);
  assert.doesNotMatch(failure.message, /raw 500/);
  assert.deepEqual(h.generated, []);
});

test("a reference that is not the person's, or not there, fails before any spend", async () => {
  const h = harness();
  await h.tool.execute({ prompt: "make it night", reference: "att_someone_else" });
  assert.equal(h.frames.at(-1)?.failure?.code, "reference_missing");
  assert.equal(h.calls.admit, 0);
  const ok = harness();
  await ok.tool.execute({ prompt: "make it night", reference: "latest" });
  assert.equal(ok.frames.at(-1)?.referenceAttachmentId, "att_ref");
  assert.equal(ok.frames.at(-1)?.count, 1);
});

test("a named model the plan does not include is refused by name", async () => {
  const h = harness({}, { plan: "FREE" });
  await h.tool.execute({ prompt: "a fox", model: "Nano Banana Pro" });
  const failure = h.frames.at(-1)?.failure;
  assert.equal(failure?.code, "plan_required");
  assert.equal(failure?.model, "Nano Banana Pro");
  assert.equal(h.calls.admit, 0);
});

test("a page or document cannot spend the budget: untrusted turns need the person's own picture request", async () => {
  const injected = harness({}, { untrustedContent: true, userRequest: "Summarise this page" });
  await injected.tool.execute({ prompt: "a fox" });
  assert.equal(injected.frames.at(-1)?.failure?.code, "not_requested");
  assert.equal(injected.calls.admit, 0);
  const asked = harness({}, { untrustedContent: true, userRequest: "Draw me the logo described in this document" });
  const result = await asked.tool.execute({ prompt: "a logo" });
  assert.equal(result.ok, true);
});

test("one reply can make pictures a bounded number of times", async () => {
  const h = harness();
  for (let i = 0; i < MAX_IMAGE_CALLS_PER_TURN; i += 1) {
    assert.equal((await h.tool.execute({ prompt: `fox ${i}` })).ok, true);
  }
  const extra = await h.tool.execute({ prompt: "one more fox" });
  assert.equal(extra.ok, false);
  assert.equal(JSON.parse(extra.text).reason, "too_many_calls");
  assert.equal(h.calls.admit, MAX_IMAGE_CALLS_PER_TURN);
});

test("no image model at all is a named failure, not a crash", async () => {
  const failure = routeFailure(new NoImageModelError({ provider_not_configured: 9 }));
  assert.equal(failure.code, "no_image_model");
  const edit = routeFailure(new NoImageModelError({ cannot_edit: 3 }));
  assert.equal(edit.code, "edit_unsupported");
});

// ---------------------------------------------------------------------------
// The shared pipeline: one door, the same gates
// ---------------------------------------------------------------------------

const PIPELINE = readFileSync(new URL("../src/lib/media/generation-pipeline.ts", import.meta.url), "utf8");
const ROUTE = readFileSync(new URL("../src/app/api/generate/route.ts", import.meta.url), "utf8");
const TOOL = readFileSync(new URL("../src/lib/chat/image-tool.ts", import.meta.url), "utf8");

test("the chat tool and /api/generate share one pipeline, and the tool never calls a provider itself", () => {
  assert.match(ROUTE, /admitMediaGeneration\(/);
  assert.match(ROUTE, /runMediaGeneration\(/);
  assert.match(TOOL, /pipeline\.admitMediaGeneration/);
  assert.match(TOOL, /pipeline\.runMediaGeneration/);
  assert.doesNotMatch(TOOL, /generateImage\(|editImage\(|recordSpend\(|consumeMessage\(/);
});

test("the pipeline checks health, plan, budget, windows, moderation, rate and quota before holding spend", () => {
  const order = [
    "workspacePermits(",
    "isProviderConfigured(",
    "providerHealthy(",
    "planRank(plan) < planRank(model.minPlan)",
    "checkBudget(",
    "admitMeteredCall(",
    "quickScreen(prompt)",
    "rateLimit(",
    "consumeMessage(",
    "reserveSpend(",
    "generateImage(",
    "recordSpend(",
    "settleSpend(",
  ].map((needle) => {
    const at = PIPELINE.indexOf(needle);
    assert.ok(at >= 0, `the pipeline has ${needle}`);
    return at;
  });
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in this order");
  assert.match(PIPELINE, /releaseSpend\(/);
  assert.match(PIPELINE, /refundMessage\(user\.id, plan\)/);
  // Saving is the caller's, inside the Library's locked quota check, on both doors.
  for (const source of [ROUTE, TOOL]) {
    assert.match(source, /lockedLibraryCapacity\(/);
    assert.match(source, /assertLibraryCapacity\(/);
  }
});
