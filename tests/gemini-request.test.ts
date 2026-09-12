import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  geminiEndpoint,
  geminiGenerationConfig,
  geminiRequestBody,
  geminiThinkingConfig,
  geminiToolsPayload,
  isGemini3OrLater,
} from "@/lib/gemini-core";
import { MODELS, type ModelInfo } from "@/lib/models";
import { reasoningCaps } from "@/lib/model-metrics";
import type { ReasoningEffort } from "@/types/chat";

/*
 * The Gemini REQUEST, asserted without a credential.
 *
 * Every defect these cover was invisible locally and a 400 (or a silently
 * missing capability) in production: a thinking level the id rejects, a tool
 * array that never carried the search tool it announced, a hardcoded host that
 * ignored the deployment's own base URL.
 */

const model = (id: string, over: Partial<ModelInfo> = {}): ModelInfo => ({
  id: `google:${id}`,
  provider: "google",
  providerModel: id,
  name: id,
  minPlan: "FREE",
  vision: true,
  reasoning: true,
  agenticTools: true,
  cost: 2,
  modality: "chat",
  webSearch: true,
  ...over,
});

const googleChatModels = Object.values(MODELS).filter(
  (m) => m.provider === "google" && m.modality === "chat" && !m.comingSoon,
);

test("a model with no declared thinking ladder is sent no thinking level at all", () => {
  // `reasoningCaps` deliberately fails closed for a Gemini id it does not know
  // (caps([], false)): provider default only, no invented ladder. The adapter
  // used to override that with MEDIUM — which is also the one level part of the
  // Gemini 3 line rejects outright.
  const discovered = model("gemini-4.0-pro-preview");
  assert.equal(reasoningCaps(discovered).tiers.length, 0);
  assert.deepEqual(geminiThinkingConfig(discovered, null), { includeThoughts: true });
  assert.deepEqual(geminiThinkingConfig(discovered, "medium"), { includeThoughts: true });
  const config = geminiGenerationConfig(discovered, 4096, null);
  assert.deepEqual(config, { maxOutputTokens: 4096, thinkingConfig: { includeThoughts: true } });
  assert.equal("thinkingLevel" in (config.thinkingConfig as Record<string, unknown>), false);
});

test("every curated Gemini model only ever gets a level its catalog declares", () => {
  // The regression that would have caught the MEDIUM default: walk every tier
  // the picker can offer for every Gemini model Juno ships and assert the wire
  // value always corresponds to a declared tier — never to the adapter's own
  // idea of a default.
  for (const m of googleChatModels) {
    const caps = reasoningCaps(m);
    const tiers: Array<ReasoningEffort | null> = [null, ...caps.tiers];
    for (const tier of tiers) {
      const config = geminiThinkingConfig(m, tier);
      if (!config || !("thinkingLevel" in config)) continue;
      assert.ok(
        caps.tiers.includes(config.thinkingLevel.toLowerCase() as "low" | "medium" | "high" | "minimal"),
        `${m.id} @ ${tier ?? "none"} produced ${config.thinkingLevel}, which is not one of ${caps.tiers.join("|")}`,
      );
    }
  }
});

test("declared tiers map onto Google's own level names", () => {
  const flashLite = model("gemini-3.1-flash-lite", { cost: 1 });
  assert.deepEqual(geminiThinkingConfig(flashLite, "minimal"), { includeThoughts: true, thinkingLevel: "MINIMAL" });
  assert.deepEqual(geminiThinkingConfig(flashLite, "low"), { includeThoughts: true, thinkingLevel: "LOW" });
  const flash = model("gemini-3.8-flash");
  assert.deepEqual(geminiThinkingConfig(flash, "high"), { includeThoughts: true, thinkingLevel: "HIGH" });
  // 2.5 keeps the legacy budget transport, never a level.
  const legacy = model("gemini-2.5-pro", { minPlan: "PRO", cost: 3 });
  assert.deepEqual(geminiThinkingConfig(legacy, "low"), { includeThoughts: true, thinkingBudget: 2048 });
});

test("the endpoint is the native GenerateContent surface, not the compat shim", () => {
  const url = geminiEndpoint(model("gemini-3.8-flash"), "streamGenerateContent");
  assert.match(
    url,
    /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/[^/]+:streamGenerateContent\?alt=sse$/,
  );
  assert.equal(url.includes("/openai/"), false);
  assert.equal(
    geminiEndpoint(model("models/gemini-3.8-flash"), "generateContent"),
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
  );
});

test("GOOGLE_BASE_URL reaches the adapter, with or without the compat suffix", () => {
  const previous = process.env.GOOGLE_BASE_URL;
  try {
    process.env.GOOGLE_BASE_URL = "https://gemini.proxy.internal/v1beta/openai/";
    assert.equal(
      geminiEndpoint(model("gemini-3.8-flash"), "generateContent"),
      "https://gemini.proxy.internal/v1beta/models/gemini-3.8-flash:generateContent",
    );
    process.env.GOOGLE_BASE_URL = "https://gemini.proxy.internal/v1beta";
    assert.equal(
      geminiEndpoint(model("gemini-3.8-flash"), "generateContent"),
      "https://gemini.proxy.internal/v1beta/models/gemini-3.8-flash:generateContent",
    );
  } finally {
    if (previous === undefined) delete process.env.GOOGLE_BASE_URL;
    else process.env.GOOGLE_BASE_URL = previous;
  }
});

test("a search-only turn still sends google_search — on its one and only round", () => {
  // THE G4 REPRODUCTION. A turn with no function tools runs exactly one round,
  // which is also the final round; the old `!isFinalRound` gate meant `tools`
  // was never attached and the grounding the UI announced never happened.
  const tools = geminiToolsPayload({ model: model("gemini-3.8-flash"), webSearch: true, isFinalRound: true });
  assert.deepEqual(tools, [{ google_search: {} }]);
  const body = geminiRequestBody({
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    generationConfig: { maxOutputTokens: 4096 },
    system: "You are Juno.",
    tools,
  });
  assert.deepEqual(Object.keys(body).sort(), ["contents", "generationConfig", "systemInstruction", "tools"]);
  assert.deepEqual(body.tools, [{ google_search: {} }]);
});

test("Gemini 3 combines built-in and custom tools; 2.5 may not", () => {
  const declarations = [{ name: "browser_agent", description: "", parameters: { type: "object" } }];
  assert.deepEqual(
    geminiToolsPayload({ model: model("gemini-3.8-flash"), functionDeclarations: declarations, webSearch: true }),
    [{ functionDeclarations: declarations }, { google_search: {} }],
  );
  // Gemini 2.5 rejects a request mixing search with function declarations, so
  // the explicitly requested search wins.
  assert.deepEqual(
    geminiToolsPayload({ model: model("gemini-2.5-pro"), functionDeclarations: declarations, webSearch: true }),
    [{ google_search: {} }],
  );
  // Without search there is nothing to conflict with, on either line.
  assert.deepEqual(
    geminiToolsPayload({ model: model("gemini-2.5-pro"), functionDeclarations: declarations }),
    [{ functionDeclarations: declarations }],
  );
  // The forced-answer round withholds function declarations but not grounding.
  assert.deepEqual(
    geminiToolsPayload({
      model: model("gemini-3.8-flash"),
      functionDeclarations: declarations,
      webSearch: true,
      isFinalRound: true,
    }),
    [{ google_search: {} }],
  );
  assert.deepEqual(geminiToolsPayload({ model: model("gemini-3.8-flash") }), []);
});

test("the request body carries no key the native surface does not define", () => {
  const body = geminiRequestBody({
    contents: [{ role: "user", parts: [{ text: "hi" }] }],
    generationConfig: geminiGenerationConfig(model("gemini-3.8-flash"), 4096, "high"),
  });
  assert.deepEqual(Object.keys(body).sort(), ["contents", "generationConfig"]);
  assert.deepEqual(body.generationConfig, {
    maxOutputTokens: 4096,
    thinkingConfig: { includeThoughts: true, thinkingLevel: "HIGH" },
  });
  // An all-whitespace system prompt is not a system instruction.
  assert.equal("systemInstruction" in geminiRequestBody({
    contents: [],
    generationConfig: {},
    system: "   ",
  }), false);
});

test("isGemini3OrLater reads the generation, not the alphabet", () => {
  assert.equal(isGemini3OrLater({ providerModel: "gemini-3.8-flash" }), true);
  assert.equal(isGemini3OrLater({ providerModel: "models/gemini-3-flash-preview" }), true);
  assert.equal(isGemini3OrLater({ providerModel: "gemini-2.5-pro" }), false);
  assert.equal(isGemini3OrLater({ providerModel: "gemini-10-flash" }), true);
});

test("only the Gemini modules know Google's native host", () => {
  // A second module reaching for generativelanguage.googleapis.com is how the
  // probe ended up on a different transport from the chat path.
  const offenders = [
    "src/lib/model-capability.ts",
    "src/lib/model-capability-probe.ts",
    "src/lib/provider-health.ts",
    "src/lib/model-discovery-core.ts",
    "src/lib/openai-compat.ts",
  ].filter((file) => readFileSync(file, "utf8").includes("generativelanguage.googleapis.com"));
  assert.deepEqual(offenders, []);
  // …and the native adapter never reaches for the compat shim.
  assert.equal(readFileSync("src/lib/gemini.ts", "utf8").includes("/v1beta/openai/"), false);
});
