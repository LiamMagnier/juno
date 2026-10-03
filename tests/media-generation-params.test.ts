import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultParams, wireParams } from "@/lib/media-params";
import {
  generationCost,
  geminiImageBody,
  imageFileType,
  mediaCostFactor,
  minimaxImageBody,
  minimaxImageItems,
  minimaxVideoBody,
  openAIImageEditExtras,
  openAIImageGenerateBody,
  openAIImageItems,
  outputFileName,
  parseXaiVideoPoll,
  planGeneration,
  pollXaiVideo,
  promptWithSuffix,
  requestGeminiImage,
  seedanceStartBody,
  startXaiVideo,
  veoStartBody,
  xaiVideoStartBody,
  zhipuVideoBody,
} from "@/lib/media-gen-core";
import { buildLyriaRequestBody, requestLyriaTrack } from "@/lib/audio-gen-core";
import {
  aspectBox,
  changeConsequence,
  chipText,
  fixedFacts,
  formatFramePixels,
  framePixels,
  orderAspectChoices,
  paramControls,
  paramsForModel,
  paramsForRequest,
  parseStoredParams,
} from "@/lib/media-params-ui";
import { capabilitiesFor } from "@/lib/media-params";

/*
 * Parameters end to end, short of a live provider: what /api/generate makes
 * of a client's choices, the body each provider is sent, how many files come
 * back and what they are called and cost, and the composer helpers that draw
 * the row. Providers are driven with a mocked fetch where the request lives in
 * a testable module (Gemini image, xAI video, Lyria).
 */

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

interface Call {
  url: string;
  init?: RequestInit;
  body?: Record<string, unknown>;
}

function mockFetch(responses: Array<{ status?: number; json: unknown }>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const r = responses[Math.min(i++, responses.length - 1)];
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------
// The route's plan
// ---------------------------------------------------------------------------

test("no params is today's request: no wire, one output, flat cost", () => {
  const plan = planGeneration("openai:gpt-image-2", undefined);
  assert.deepEqual(plan, { params: null, wire: null, count: 1 });
  assert.deepEqual(generationCost(40_000, "openai:gpt-image-2", "image", plan), { perOutputMicroUsd: 40_000, estimateMicroUsd: 40_000 });
  // And the body is exactly what image-gen sent before parameters existed.
  assert.deepEqual(openAIImageGenerateBody({ provider: "openai", providerModel: "gpt-image-2" }, "a fox", null), {
    model: "gpt-image-2",
    prompt: "a fox",
    n: 1,
    size: "1024x1024",
  });
  assert.deepEqual(openAIImageGenerateBody({ provider: "xai", providerModel: "grok-imagine-image" }, "a fox", null), {
    model: "grok-imagine-image",
    prompt: "a fox",
    n: 1,
  });
  assert.deepEqual(veoStartBody("a fox", null), { instances: [{ prompt: "a fox" }] });
  assert.deepEqual(buildLyriaRequestBody("lyria-3.5", "a song"), { model: "lyria-3.5", input: "a song" });
});

test("the route cleans hand-made params against the model before anything is sent", () => {
  const plan = planGeneration("google:veo-3.1-generate-preview", { aspect: "4:3", resolution: "4K", durationSec: 4, count: 9, evil: "x" });
  // 4:3 isn't Veo's: default. 4K forces 8s. count and evil dropped.
  assert.deepEqual(plan.params, { aspect: "16:9", resolution: "4K", durationSec: 8 });
  assert.deepEqual(plan.wire?.body, { parameters: { aspectRatio: "16:9", resolution: "4k", durationSeconds: "8" } });
  assert.equal(plan.count, 1);
  // A model without capabilities (chat, Omni) ignores params entirely.
  assert.deepEqual(planGeneration("anthropic:claude-opus-4-8", { aspect: "1:1" }), { params: null, wire: null, count: 1 });
});

test("an edit always makes one image, whatever count was picked", () => {
  const plan = planGeneration("openai:gpt-image-2.5-flare", { count: 4, outputFormat: "jpg" }, { edit: true });
  assert.equal(plan.count, 1);
  assert.equal(plan.wire?.body.n, 1);
  // Edits keep the source's framing: format/quality/background only, OpenAI only.
  assert.deepEqual(openAIImageEditExtras({ provider: "openai" }, plan.wire), { quality: "auto", output_format: "jpeg", background: "auto" });
  assert.deepEqual(openAIImageEditExtras({ provider: "xai" }, plan.wire), {});
});

test("count scales the request: several outputs, billed per output", () => {
  const plan = planGeneration("openai:gpt-image-2", { count: 4 });
  assert.equal(plan.count, 4);
  assert.equal(plan.wire?.body.n, 4);
  assert.deepEqual(generationCost(40_000, "openai:gpt-image-2", "image", plan), { perOutputMicroUsd: 40_000, estimateMicroUsd: 160_000 });
  // The provider's list is capped at what was asked for (and billed per item kept).
  const items = openAIImageItems({ data: Array.from({ length: 6 }, () => ({ b64_json: PNG.toString("base64") })) }, 4);
  assert.equal(items.length, 4);
});

test("cost follows resolution, quality and length, relative to the model's default", () => {
  assert.equal(mediaCostFactor("openai:gpt-image-2", "image", defaultParams("openai:gpt-image-2")), 1);
  assert.equal(mediaCostFactor("openai:gpt-image-2.5-sunburst", "image", { quality: "high" }), 4);
  assert.equal(mediaCostFactor("openai:gpt-image-2.5-sunburst", "image", { quality: "low" }), 0.3);
  assert.equal(mediaCostFactor("google:gemini-3-pro-image", "image", { resolution: "4K" }), 2.5);
  // Veo: default 720p/8s → 1; 4K/8s → 3x; 720p/4s → half.
  assert.equal(mediaCostFactor("google:veo-3.1-generate-preview", "video", defaultParams("google:veo-3.1-generate-preview")), 1);
  assert.equal(mediaCostFactor("google:veo-3.1-generate-preview", "video", { resolution: "4K", durationSec: 8 }), 3);
  assert.equal(mediaCostFactor("google:veo-3.1-generate-preview", "video", { resolution: "720p", durationSec: 4 }), 0.5);
  // Grok 1.5: 15s at 1080p against 8s at 480p.
  assert.equal(mediaCostFactor("xai:grok-imagine-video-1.5", "video", { resolution: "1080p", durationSec: 15 }), 4.688);
  // Seedance 2.5's "auto" length bills as the 8s reference.
  assert.equal(mediaCostFactor("seedance:dreamina-seedance-2-5-260628", "video", { resolution: "720p", durationSec: "auto" }), 1);
  // Never below a quarter.
  assert.equal(mediaCostFactor("xai:grok-imagine-video", "video", { resolution: "480p", durationSec: 1 }), 0.25);
});

test("prompt-steered options ride in the prompt, not the stored message", () => {
  const plan = planGeneration("google:lyria-3.5", { instrumental: true, outputFormat: "wav" });
  assert.equal(promptWithSuffix("Lo-fi beat", plan.wire), "Lo-fi beat\n\nInstrumental only, no vocals.");
  assert.equal(promptWithSuffix("Lo-fi beat", null), "Lo-fi beat");
});

// ---------------------------------------------------------------------------
// Provider wiring
// ---------------------------------------------------------------------------

test("OpenAI image: size, quality, format, background and n reach the body", () => {
  const plan = planGeneration("openai:gpt-image-2.5-sunburst", { aspect: "9:16", resolution: "2K", quality: "high", outputFormat: "webp", background: "transparent", count: 2 });
  assert.deepEqual(openAIImageGenerateBody({ provider: "openai", providerModel: "gpt-image-2.5-sunburst" }, "p", plan.wire), {
    model: "gpt-image-2.5-sunburst",
    prompt: "p",
    n: 2,
    size: "1152x2048",
    quality: "high",
    output_format: "webp",
    background: "transparent",
  });
});

test("xAI and Muse images: their extra fields pass through the OpenAI-compatible body", () => {
  const grok = planGeneration("xai:grok-imagine-image-2.0", { aspect: "21:9", resolution: "2K", quality: "medium", count: 3 });
  assert.deepEqual(openAIImageGenerateBody({ provider: "xai", providerModel: "grok-imagine-image-2.0" }, "p", grok.wire), {
    model: "grok-imagine-image-2.0",
    prompt: "p",
    n: 3,
    aspect_ratio: "21:9",
    resolution: "2k",
    quality: "medium",
  });
  const muse = planGeneration("meta:muse-image-1.0", { aspect: "3:2", outputFormat: "png" });
  assert.deepEqual(openAIImageGenerateBody({ provider: "meta", providerModel: "muse-image-1.0" }, "p", muse.wire), {
    model: "muse-image-1.0",
    prompt: "p",
    n: 1,
    reasoning_strength: "high",
    output_format: "png",
    size: "1536x1024",
  });
});

test("Gemini image: imageConfig goes on the wire, the bytes decide the type", async () => {
  const plan = planGeneration("google:gemini-3.1-flash-image", { aspect: "21:9", resolution: "2K" });
  const { fetchImpl, calls } = mockFetch([
    { json: { candidates: [{ content: { parts: [{ inlineData: { data: JPEG.toString("base64"), mimeType: "image/png" } }] } }] } },
  ]);
  const image = await requestGeminiImage({ providerModel: "gemini-3.1-flash-image" }, [{ text: "a fox" }], plan.wire, { apiKey: "k", fetchImpl });
  assert.match(calls[0].url, /models\/gemini-3\.1-flash-image:generateContent$/);
  assert.deepEqual(calls[0].body, {
    contents: [{ parts: [{ text: "a fox" }] }],
    generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: "21:9", imageSize: "2K" } },
  });
  // Labelled PNG by the provider, but the bytes are a JPEG.
  assert.equal(image.mimeType, "image/jpeg");
  assert.equal(image.ext, "jpg");

  // No choices: today's body exactly. An edit keeps the source's aspect.
  assert.deepEqual(geminiImageBody([{ text: "x" }], null), { contents: [{ parts: [{ text: "x" }] }], generationConfig: { responseModalities: ["IMAGE"] } });
  assert.deepEqual(geminiImageBody([{ text: "x" }], plan.wire, { edit: true }).generationConfig, { responseModalities: ["IMAGE"], imageConfig: { imageSize: "2K" } });
});

test("MiniMax image: aspect and n, and every returned image is kept", () => {
  const plan = planGeneration("minimax:image-01", { aspect: "16:9", count: 3 });
  assert.deepEqual(minimaxImageBody("image-01", "p", plan.wire), {
    model: "image-01",
    prompt: "p",
    aspect_ratio: "16:9",
    response_format: "url",
    n: 3,
    prompt_optimizer: true,
  });
  assert.deepEqual(minimaxImageBody("image-01", "p", null).aspect_ratio, "1:1");
  assert.deepEqual(minimaxImageItems({ data: { image_urls: ["a", "b", "c", "d"] } }, 3), [{ url: "a" }, { url: "b" }, { url: "c" }]);
});

test("Veo: aspectRatio, resolution, durationSeconds under parameters", () => {
  const plan = planGeneration("google:veo-3.1-fast-generate-preview", { aspect: "9:16", resolution: "720p", durationSec: 4 });
  assert.deepEqual(veoStartBody("p", plan.wire), {
    instances: [{ prompt: "p" }],
    parameters: { aspectRatio: "9:16", resolution: "720p", durationSeconds: "4" },
  });
});

test("Seedance, Hailuo and CogVideoX: choices as top-level body fields", () => {
  const seed = planGeneration("seedance:dreamina-seedance-2-0-260128", { aspect: "21:9", resolution: "1080p", durationSec: 12, audio: false });
  assert.deepEqual(seedanceStartBody("m", "p", seed.wire), {
    model: "m",
    content: [{ type: "text", text: "p" }],
    ratio: "21:9",
    resolution: "1080p",
    duration: 12,
    generate_audio: false,
  });
  assert.deepEqual(seedanceStartBody("m", "p", null), { model: "m", content: [{ type: "text", text: "p" }] });
  const hailuo = planGeneration("minimax:MiniMax-Hailuo-2.3", { resolution: "768p", durationSec: 10 });
  assert.deepEqual(minimaxVideoBody("MiniMax-Hailuo-2.3", "p", hailuo.wire), { model: "MiniMax-Hailuo-2.3", prompt: "p", resolution: "768P", duration: 10 });
  const cog = planGeneration("zhipu:cogvideox-3", { aspect: "16:9", resolution: "4K", fps: 60 });
  assert.deepEqual(zhipuVideoBody("cogvideox-3", "p", cog.wire), {
    model: "cogvideox-3",
    prompt: "p",
    quality: "speed",
    duration: 5,
    with_audio: false,
    fps: 60,
    size: "3840x2160",
  });
});

test("xAI video: start with the choices, poll to a URL, failures in words", async () => {
  const plan = planGeneration("xai:grok-imagine-video-1.5", { aspect: "9:16", resolution: "1080p", durationSec: 12, audio: false });
  const { fetchImpl, calls } = mockFetch([
    { json: { request_id: "req_1" } },
    { json: { status: "pending", progress: 40 } },
    { json: { status: "done", video: { url: "https://vidgen.x.ai/v.mp4", duration: 12 } } },
  ]);
  const model = { providerModel: "grok-imagine-video-1.5", name: "Grok Imagine Video 1.5" };
  const id = await startXaiVideo(model, "a fox", plan.wire, { apiKey: "k", fetchImpl });
  assert.equal(id, "req_1");
  assert.equal(calls[0].url, "https://api.x.ai/v1/videos/generations");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer k");
  assert.deepEqual(calls[0].body, {
    model: "grok-imagine-video-1.5",
    prompt: "a fox",
    aspect_ratio: "9:16",
    resolution: "1080p",
    duration: 12,
    generate_audio: false,
  });
  assert.deepEqual(await pollXaiVideo(model, id, { apiKey: "k", fetchImpl }), { status: "running", pct: 40, note: "pending" });
  assert.equal(calls[1].url, "https://api.x.ai/v1/videos/req_1");
  assert.deepEqual(await pollXaiVideo(model, id, { apiKey: "k", fetchImpl }), { status: "done", url: "https://vidgen.x.ai/v.mp4", mimeType: "video/mp4" });

  // Classic Grok video has no sound field; no choices sends model + prompt only.
  assert.deepEqual(xaiVideoStartBody("grok-imagine-video", "p", null), { model: "grok-imagine-video", prompt: "p" });
  assert.equal("generate_audio" in planGeneration("xai:grok-imagine-video", { audio: true }).wire!.body, false);

  assert.throws(() => parseXaiVideoPoll({ status: "failed", error: { code: "invalid_argument", message: "Prompt cannot be empty." } }), /Prompt cannot be empty/);
  assert.throws(() => parseXaiVideoPoll({ status: "expired" }), /expired/);
  assert.throws(() => parseXaiVideoPoll({ status: "done", video: {} }), /no video/);

  const rejected = mockFetch([{ status: 400, json: { error: { message: "bad ratio" } } }]);
  await assert.rejects(startXaiVideo(model, "p", null, { apiKey: "k", fetchImpl: rejected.fetchImpl }), /rejected the request \(400\)\. bad ratio/);
});

test("Lyria: WAV asks for response_format, MP3 sends nothing extra", async () => {
  const wav = Buffer.alloc(4096, 0);
  wav.write("RIFF", 0, "ascii");
  wav.write("WAVE", 8, "ascii");
  const { fetchImpl, calls } = mockFetch([
    { json: { status: "completed", steps: [{ type: "model_output", content: [{ type: "audio", data: wav.toString("base64") }] }] } },
  ]);
  const plan = planGeneration("google:lyria-3.5", { outputFormat: "wav", instrumental: true });
  const track = await requestLyriaTrack({ providerModel: "lyria-3.5", name: "Lyria 3.5" }, promptWithSuffix("rain on a tin roof", plan.wire), {
    apiKey: "k",
    baseUrl: "https://example.test/v1beta",
    fetchImpl,
    wire: plan.wire,
  });
  assert.deepEqual(calls[0].body, {
    response_format: { type: "audio", mime_type: "audio/wav" },
    model: "lyria-3.5",
    input: "rain on a tin roof\n\nInstrumental only, no vocals.",
  });
  assert.equal(track.mimeType, "audio/wav");
  assert.equal(track.ext, "wav");
  assert.deepEqual(buildLyriaRequestBody("lyria-3.5", "x", planGeneration("google:lyria-3.5", {}).wire), { model: "lyria-3.5", input: "x" });
});

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

test("an image's type follows its bytes, then the format asked for", () => {
  assert.deepEqual(imageFileType(JPEG, "png"), { mimeType: "image/jpeg", ext: "jpg" });
  assert.deepEqual(imageFileType(WEBP, null), { mimeType: "image/webp", ext: "webp" });
  assert.deepEqual(imageFileType(PNG), { mimeType: "image/png", ext: "png" });
  // Unrecognised bytes: the requested format, then PNG.
  assert.deepEqual(imageFileType(Buffer.from("????????"), "jpeg"), { mimeType: "image/jpeg", ext: "jpg" });
  assert.deepEqual(imageFileType(Buffer.from("????????"), "webp"), { mimeType: "image/webp", ext: "webp" });
  assert.deepEqual(imageFileType(Buffer.from("????????"), null), { mimeType: "image/png", ext: "png" });
});

test("several outputs get numbered names", () => {
  assert.equal(outputFileName("GPT Image 2 — a fox", "png", 0, 1), "GPT Image 2 — a fox.png");
  assert.equal(outputFileName("GPT Image 2 — a fox", "jpg", 1, 4), "GPT Image 2 — a fox 2.jpg");
});

test("/api/generate takes params, plans them, bills per output and cleans up every file", () => {
  const route = readFileSync(new URL("../src/app/api/generate/route.ts", import.meta.url), "utf8");
  assert.match(route, /params: z\s*\.record/);
  assert.match(route, /planGeneration\(model\.id, parsed\.data\.params, \{ edit: !!edit \}\)/);
  assert.match(route, /for \(let i = 0; i < outputs\.length; i \+= 1\)/);
  assert.match(route, /for \(const key of outputStorageKeys\) await deleteObject\(key\)/);
  assert.match(route, /cost\.estimateMicroUsd > budget\.remainingMicroUsd/);
});

// ---------------------------------------------------------------------------
// Composer helpers
// ---------------------------------------------------------------------------

test("the row draws each option as the right control, in a stable order", () => {
  const veo = paramControls("google:veo-3.1-generate-preview", {});
  assert.deepEqual(
    veo.map((c) => [c.key, c.kind, c.chip]),
    [
      ["aspect", "aspect", "16:9"],
      ["resolution", "segmented", "720p"],
      ["durationSec", "segmented", "8s"],
    ],
  );
  const grok = paramControls("xai:grok-imagine-video-1.5", {});
  assert.deepEqual(
    grok.map((c) => [c.key, c.kind]),
    [
      ["aspect", "aspect"],
      ["resolution", "segmented"],
      ["durationSec", "slider"],
      ["audio", "toggle"],
    ],
  );
  assert.deepEqual(grok.find((c) => c.key === "durationSec")?.range, { min: 1, max: 15, step: 1, unit: "s" });
  const gpt = paramControls("openai:gpt-image-2.5-sunburst", { count: 3 });
  assert.deepEqual(
    gpt.map((c) => [c.key, c.kind, c.chip]),
    [
      ["aspect", "aspect", "1:1"],
      ["resolution", "segmented", "1K"],
      ["quality", "menu", "Auto quality"],
      ["count", "menu", "3 images"],
      ["background", "menu", "Auto background"],
      ["outputFormat", "menu", "PNG"],
    ],
  );
  const lyria = paramControls("google:lyria-3.5", {});
  assert.deepEqual(lyria.map((c) => [c.key, c.kind]), [["instrumental", "toggle"], ["outputFormat", "menu"]]);
  assert.deepEqual(paramControls("anthropic:claude-opus-4-8", {}), []);
});

test("values the combination rules out are marked, with what picking them moves", () => {
  const veo = paramControls("google:veo-3.1-generate-preview", { resolution: "4K", durationSec: 8 });
  const length = veo.find((c) => c.key === "durationSec")!;
  assert.deepEqual(
    length.choices.map((c) => [c.value, c.conflict]),
    [[4, true], [6, true], [8, false]],
  );
  assert.equal(length.choices[0].consequence, "Resolution becomes 720p");
  assert.equal(changeConsequence("openai:gpt-image-2.5-sunburst", { background: "transparent", outputFormat: "png" }, "outputFormat", "jpg"), "Background becomes Auto");
});

test("chip text, fixed facts and the aspect shape", () => {
  const caps = capabilitiesFor("seedance:dreamina-seedance-2-5-260628")!;
  assert.equal(chipText("durationSec", caps.options.durationSec!, "auto"), "Auto length");
  assert.equal(chipText("aspect", caps.options.aspect!, "auto"), "Auto");
  assert.deepEqual(fixedFacts(capabilitiesFor("google:veo-3.1-generate-preview")), ["With sound"]);
  assert.deepEqual(fixedFacts(capabilitiesFor("google:lyria-3-clip-preview")), ["30s clip"]);
  assert.deepEqual(aspectBox("16:9", 16), { width: 16, height: 9 });
  assert.deepEqual(aspectBox("9:19.5", 39), { width: 18, height: 39 });
  assert.equal(aspectBox("auto", 16), null);
});

test("choices persist per model and carry across a switch", () => {
  const stored = parseStoredParams(
    JSON.stringify({ "google:veo-3.1-generate-preview": { resolution: "4K", durationSec: 4 }, "anthropic:claude-opus-4-8": { x: 1 } }),
  );
  // Cleaned on the way in (4K is 8s only), unknown models dropped.
  assert.deepEqual(stored, { "google:veo-3.1-generate-preview": { aspect: "16:9", resolution: "4K", durationSec: 8 } });
  assert.deepEqual(parseStoredParams("{not json"), {});
  // A saved model returns what was saved; a new one inherits what fits.
  assert.equal(paramsForModel(stored, "google:veo-3.1-generate-preview", null).resolution, "4K");
  const carried = paramsForModel(stored, "google:veo-3.1-lite-generate-preview", { aspect: "9:16", resolution: "4K", durationSec: 8 });
  assert.deepEqual(carried, { aspect: "9:16", resolution: "1080p", durationSec: 8 });
  assert.deepEqual(paramsForModel({}, "google:lyria-3.5", null), defaultParams("google:lyria-3.5"));
  assert.deepEqual(paramsForRequest({ aspect: "1:1", count: 2, audio: true }), { aspect: "1:1", count: 2, audio: true });
  // What the composer sends wires identically on the server.
  assert.deepEqual(wireParams("openai:gpt-image-2", paramsForRequest(defaultParams("openai:gpt-image-2"))).body.size, "1024x1024");
});

test("the frame chooser orders tall to wide and names the output size", () => {
  const banana = paramControls("google:gemini-3.1-flash-image", {}).find((c) => c.key === "aspect")!;
  const order = orderAspectChoices(banana.choices).map((c) => c.value);
  assert.deepEqual(order.slice(0, 3), ["1:8", "1:4", "9:16"]);
  assert.deepEqual(order.slice(-2), ["4:1", "8:1"]);
  // OpenAI's own size table, after the pick moves resolution (3:2 is 1K only).
  assert.deepEqual(framePixels("openai:gpt-image-2.5-sunburst", { aspect: "1:1", resolution: "2K" }, "3:2"), { width: 1536, height: 1024, exact: true });
  assert.equal(formatFramePixels(framePixels("openai:gpt-image-2.5-sunburst", { resolution: "1K" }, "16:9")), "1536 × 864");
  // Worked out from the tier where there is no table: a 1K image keeps about a megapixel; 720p fixes the short edge.
  assert.equal(formatFramePixels(framePixels("google:gemini-3.1-flash-image", { resolution: "1K" }, "1:1")), "1024 × 1024");
  assert.equal(formatFramePixels(framePixels("google:veo-3.1-generate-preview", { resolution: "720p" }, "16:9")), "1280 × 720");
  assert.equal(framePixels("google:gemini-3.1-flash-image", {}, "auto"), null);
});
