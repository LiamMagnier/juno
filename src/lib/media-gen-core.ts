import type { ModelInfo } from "@/lib/models";
import { sniffImageMime } from "@/lib/uploads";
import {
  capabilitiesFor,
  defaultParams,
  normalizeParams,
  wireParams,
  type MediaKind,
  type MediaParams,
  type MediaWire,
} from "@/lib/media-params";

/*
 * The pure half of media generation with parameters: what a request's choices
 * mean for the provider body, how many files come back, what each one costs,
 * and how a returned file is named. `image-gen.ts`, `video-gen.ts`,
 * `audio-gen.ts` and /api/generate are the server-only callers; this module
 * holds everything a test can drive with a mocked fetch.
 *
 * The contract with clients that send no `params` (the native apps today):
 * nothing changes. `planGeneration` returns `wire: null` for them, and every
 * builder below sends exactly the body it sent before parameters existed.
 */

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// The plan for one request
// ---------------------------------------------------------------------------

export interface GenerationPlan {
  /** The cleaned choices, or null when the client sent none (today's request, untouched). */
  params: MediaParams | null;
  /** Provider fields and prompt suffix for `params`; null with them. */
  wire: MediaWire | null;
  /** How many outputs this request asks for. */
  count: number;
}

/**
 * Clean whatever the client sent and work out what goes to the provider. An
 * edit always makes one image: the edit endpoints are driven one result at a
 * time, and a count picked for a fresh generation must not multiply an edit.
 */
export function planGeneration(modelId: string, raw: unknown, opts: { edit?: boolean } = {}): GenerationPlan {
  if (raw == null || !capabilitiesFor(modelId)) return { params: null, wire: null, count: 1 };
  const params = normalizeParams(modelId, raw);
  if (opts.edit && params.count !== undefined) params.count = 1;
  const wire = wireParams(modelId, params);
  return { params, wire, count: Math.max(1, params.count ?? 1) };
}

/** The prompt the provider sees: the person's words plus any prompt-steered option. */
export function promptWithSuffix(prompt: string, wire: MediaWire | null): string {
  return wire?.promptSuffix ? `${prompt}\n\n${wire.promptSuffix}` : prompt;
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

// Relative price of a tier against the model's own default, which is what the
// flat per-request figures in spend.ts were set against. Approximations of the
// providers' list prices: Nano Banana Pro charges ~1.8x for 4K, Veo and
// Seedance charge more per second at 1080p and 4K, every video provider bills
// by the second, and GPT Image bills low/high quality at roughly a quarter and
// four times medium.
const IMAGE_RES_WEIGHT: Record<string, number> = { "0.5K": 0.75, "1K": 1, "2K": 1.5, "4K": 2.5 };
const VIDEO_RES_WEIGHT: Record<string, number> = {
  // Google: Omni's 360p drafts cost "a third" of 720p.
  "360p": 0.34,
  "480p": 0.6,
  "512p": 0.65,
  "720p": 1,
  "768p": 1,
  "1080p": 1.5,
  "4K": 3,
};
/**
 * xAI's per-second price at each resolution over its 480p rate, from each
 * model page's "pricing per second based on resolution" table (docs.x.ai,
 * 2026-10-04). The generic table above understates the 1080p jump on these
 * models (1.5: $0.08 → $0.25; 1.5 Lite: $0.02 → $0.14).
 */
const XAI_VIDEO_RES_WEIGHT: Record<string, Record<string, number>> = {
  "xai:grok-imagine-video": { "480p": 1, "720p": 1.4 },
  "xai:grok-imagine-video-1.5": { "480p": 1, "720p": 1.75, "1080p": 3.125 },
  "xai:grok-imagine-video-1.5-lite": { "480p": 1, "720p": 1.5, "1080p": 7 },
};
const OPENAI_QUALITY_WEIGHT: Record<string, number> = { auto: 1, low: 0.3, medium: 1, high: 4, xhigh: 5, max: 6 };
/** What "auto" length is billed as when the provider picks it. */
const AUTO_SECONDS = 8;

function ratio(table: Record<string, number>, chosen: unknown, base: unknown): number {
  const a = typeof chosen === "string" ? table[chosen] : undefined;
  const b = typeof base === "string" ? table[base] : undefined;
  return a && b ? a / b : 1;
}

function seconds(value: unknown, fallback: number): number {
  return typeof value === "number" && value > 0 ? value : fallback;
}

/**
 * How much one output with these choices costs relative to the model's flat
 * per-request price. 1 for no choices (or the defaults); never below 0.25.
 */
export function mediaCostFactor(modelId: string, kind: MediaKind, params: MediaParams | null): number {
  if (!params) return 1;
  const defaults = defaultParams(modelId);
  let factor = 1;
  if (kind === "image") {
    factor *= ratio(IMAGE_RES_WEIGHT, params.resolution, defaults.resolution);
    if (modelId.startsWith("openai:")) factor *= ratio(OPENAI_QUALITY_WEIGHT, params.quality, defaults.quality);
  } else if (kind === "video") {
    factor *= ratio(XAI_VIDEO_RES_WEIGHT[modelId] ?? VIDEO_RES_WEIGHT, params.resolution, defaults.resolution);
    if (params.durationSec !== undefined) {
      const reference = seconds(defaults.durationSec, AUTO_SECONDS);
      factor *= seconds(params.durationSec, reference) / reference;
    }
  }
  return Math.max(0.25, Math.round(factor * 1000) / 1000);
}

export interface GenerationCost {
  /** Micro-USD for one output. */
  perOutputMicroUsd: number;
  /** Micro-USD for the whole request: what the budget check must admit. */
  estimateMicroUsd: number;
}

export function generationCost(baseMicroUsd: number, modelId: string, kind: MediaKind, plan: GenerationPlan): GenerationCost {
  const perOutputMicroUsd = Math.max(0, Math.round(baseMicroUsd * mediaCostFactor(modelId, kind, plan.params)));
  return { perOutputMicroUsd, estimateMicroUsd: perOutputMicroUsd * plan.count };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export interface GeneratedImage {
  bytes: Buffer;
  mimeType: string;
  ext: string;
}

const FORMAT_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };
const MIME_EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/**
 * The type of a returned image, read off its own bytes first: a provider's
 * label (or the format that was asked for) is only the fallback. A JPG asked
 * of GPT Image is stored as image/jpeg, a Muse WebP as image/webp.
 */
export function imageFileType(bytes: Uint8Array, hint?: string | null): { mimeType: string; ext: string } {
  const sniffed = sniffImageMime(bytes.subarray(0, 16));
  const mimeType =
    sniffed ?? (hint ? (FORMAT_MIME[hint.toLowerCase()] ?? (hint.startsWith("image/") ? hint.toLowerCase() : null)) : null) ?? "image/png";
  return { mimeType, ext: MIME_EXT[mimeType] ?? "png" };
}

export function imageFrom(bytes: Buffer, hint?: string | null): GeneratedImage {
  return { bytes, ...imageFileType(bytes, hint) };
}

/** "Name — title.png", or "Name — title 2.png" for the second of several. */
export function outputFileName(base: string, ext: string, index: number, total: number): string {
  const stem = total > 1 ? `${base} ${index + 1}` : base;
  return `${stem.slice(0, 110)}.${ext}`;
}

// ---------------------------------------------------------------------------
// Image request bodies
// ---------------------------------------------------------------------------

/**
 * OpenAI-compatible /images/generations (OpenAI, xAI, Z.ai, Meta). Without
 * choices this is exactly the body sent before parameters: one image, and the
 * fixed 1024x1024 for OpenAI. With them, the mapped fields ride along; xAI's
 * aspect_ratio / resolution / quality and Muse's reasoning_strength are extra
 * body fields the SDK passes through untouched.
 */
export function openAIImageGenerateBody(
  model: Pick<ModelInfo, "provider" | "providerModel">,
  prompt: string,
  wire: MediaWire | null,
): UnknownRecord {
  const body: UnknownRecord = { model: model.providerModel, prompt, n: 1 };
  if (model.provider === "openai") body.size = "1024x1024";
  if (wire) Object.assign(body, wire.body);
  return body;
}

// Fields an edit may take. The edit endpoints keep the source's framing, so
// size, aspect and count stay out; format, quality and background apply.
const OPENAI_EDIT_FIELDS = ["quality", "output_format", "background"];

/** The extra /images/edits fields for an edit with choices (OpenAI only; others take none). */
export function openAIImageEditExtras(model: Pick<ModelInfo, "provider">, wire: MediaWire | null): UnknownRecord {
  if (!wire || model.provider !== "openai") return {};
  const out: UnknownRecord = {};
  for (const key of OPENAI_EDIT_FIELDS) if (wire.body[key] !== undefined) out[key] = wire.body[key];
  return out;
}

/** The items of an /images response, as base64 or URLs, capped at what was asked for. */
export function openAIImageItems(result: unknown, max: number): Array<{ b64?: string; url?: string }> {
  const data = isRecord(result) && Array.isArray(result.data) ? result.data : [];
  const out: Array<{ b64?: string; url?: string }> = [];
  for (const item of data) {
    if (!isRecord(item)) continue;
    if (typeof item.b64_json === "string" && item.b64_json) out.push({ b64: item.b64_json });
    else if (typeof item.url === "string" && item.url) out.push({ url: item.url });
    if (out.length >= max) break;
  }
  return out;
}

export type GoogleContentPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/**
 * Gemini generateContent for an image. `imageConfig` comes from the choices;
 * an edit keeps the source's aspect, so only the size tier travels with it.
 */
export function geminiImageBody(parts: GoogleContentPart[], wire: MediaWire | null, opts: { edit?: boolean } = {}): UnknownRecord {
  const generationConfig: UnknownRecord = { responseModalities: ["IMAGE"] };
  const config = isRecord(wire?.body.generationConfig) ? wire.body.generationConfig : null;
  const imageConfig = config && isRecord(config.imageConfig) ? { ...config.imageConfig } : null;
  if (imageConfig && opts.edit) delete imageConfig.aspectRatio;
  if (imageConfig && Object.keys(imageConfig).length) generationConfig.imageConfig = imageConfig;
  return { contents: [{ parts }], generationConfig };
}

export const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface ProviderCall {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** One Gemini image request, end to end; the image's type is read off its bytes. */
export async function requestGeminiImage(
  model: Pick<ModelInfo, "providerModel">,
  parts: GoogleContentPart[],
  wire: MediaWire | null,
  call: ProviderCall,
  opts: { edit?: boolean } = {},
): Promise<GeneratedImage> {
  const doFetch = call.fetchImpl ?? fetch;
  const base = (call.baseUrl ?? GOOGLE_API_BASE).replace(/\/+$/, "");
  const res = await doFetch(`${base}/models/${model.providerModel}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": call.apiKey },
    body: JSON.stringify(geminiImageBody(parts, wire, opts)),
    signal: AbortSignal.timeout(call.timeoutMs ?? 110_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gemini image generation failed (${res.status}). ${text.slice(0, 160)}`);
  }
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string; mimeType?: string } }> } }> };
  const outParts = data?.candidates?.[0]?.content?.parts ?? [];
  const inline = outParts.find((p) => p.inlineData?.data)?.inlineData;
  if (!inline?.data) throw new Error("Gemini returned no image — try rephrasing your prompt.");
  return imageFrom(Buffer.from(inline.data, "base64"), inline.mimeType);
}

/** MiniMax /image_generation: today's body, with aspect_ratio and n from the choices. */
export function minimaxImageBody(providerModel: string, prompt: string, wire: MediaWire | null): UnknownRecord {
  return {
    model: providerModel,
    prompt: prompt.slice(0, 1500),
    aspect_ratio: "1:1",
    response_format: "url",
    n: 1,
    prompt_optimizer: true,
    ...(wire?.body ?? {}),
  };
}

/** Every image a MiniMax response carries, base64 first, capped at `max`. */
export function minimaxImageItems(data: unknown, max: number): Array<{ b64?: string; url?: string }> {
  const d = isRecord(data) && isRecord(data.data) ? data.data : {};
  const out: Array<{ b64?: string; url?: string }> = [];
  const push = (item: { b64?: string; url?: string }) => {
    if (out.length < max) out.push(item);
  };
  if (Array.isArray(d.image_base64)) for (const b of d.image_base64) if (typeof b === "string" && b) push({ b64: b });
  if (Array.isArray(d.images)) {
    for (const i of d.images) {
      if (!isRecord(i)) continue;
      const b64 = typeof i.b64_json === "string" && i.b64_json ? i.b64_json : typeof i.base64 === "string" && i.base64 ? i.base64 : null;
      if (b64) push({ b64 });
      else if (typeof i.url === "string" && i.url) push({ url: i.url });
    }
  }
  if (!out.length && Array.isArray(d.image_urls)) for (const u of d.image_urls) if (typeof u === "string" && u) push({ url: u });
  return out;
}

// ---------------------------------------------------------------------------
// Video request bodies
// ---------------------------------------------------------------------------

/** Veo predictLongRunning: `parameters` only when there are choices. */
export function veoStartBody(prompt: string, wire: MediaWire | null): UnknownRecord {
  const parameters = isRecord(wire?.body.parameters) ? wire.body.parameters : null;
  return parameters && Object.keys(parameters).length ? { instances: [{ prompt }], parameters } : { instances: [{ prompt }] };
}

/**
 * Gemini Omni Flash on the Interactions API: a background interaction whose
 * video comes back as a Files API URI. The choices (aspect ratio, resolution)
 * live inside `response_format`; without them the body is exactly the one
 * sent before parameters existed (16:9 at the provider's default 720p).
 */
export function googleOmniStartBody(providerModel: string, prompt: string, wire: MediaWire | null): UnknownRecord {
  const chosen = isRecord(wire?.body.response_format) ? wire.body.response_format : {};
  return {
    model: providerModel,
    input: prompt,
    background: true,
    response_format: { type: "video", aspect_ratio: "16:9", ...chosen, delivery: "uri" },
  };
}

/** Seedance (Ark): the choices are top-level body fields beside `content`. */
export function seedanceStartBody(providerModel: string, prompt: string, wire: MediaWire | null): UnknownRecord {
  return { model: providerModel, content: [{ type: "text", text: prompt }], ...(wire?.body ?? {}) };
}

/** MiniMax Hailuo /video_generation: resolution and duration beside the prompt. */
export function minimaxVideoBody(providerModel: string, prompt: string, wire: MediaWire | null): UnknownRecord {
  return { model: providerModel, prompt: prompt.slice(0, 2000), ...(wire?.body ?? {}) };
}

/**
 * MiniMax H3 / H3 Max, V2 video API (platform.minimax.io
 * video-generation-v2-create, read 2026-10-04):
 *
 *   POST {host}/v2/video_generation
 *     { model, content: [{ type: "text", text }], resolution, duration, ratio }
 *     → { task_id }
 *   GET  {host}/v2/query/video_generation/{task_id}
 *     → { task: { status: queued|running|succeeded|failed|cancelled,
 *                 content: { url }, error?: { code, message } } }
 *
 * `resolution` and `duration` are required, and text-to-video needs a concrete
 * `ratio`, so the body always carries all three (the model's defaults when no
 * choices came in). The prompt goes in a `text` content item (≤ 7000 chars).
 */
export function minimaxH3Body(providerModel: string, prompt: string, wire: MediaWire | null): UnknownRecord {
  return {
    model: providerModel,
    content: [{ type: "text", text: prompt.slice(0, 7000) }],
    resolution: "768P",
    duration: 5,
    ratio: "16:9",
    ...(wire?.body ?? {}),
  };
}

/** The V2 host: the configured MiniMax base without its `/v1`. */
export function minimaxV2Host(base: string): string {
  return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}

export function parseMinimaxH3Poll(data: unknown, modelName = "MiniMax H3"): VideoPollResult {
  const task = isRecord(data) && isRecord(data.task) ? data.task : {};
  const status = typeof task.status === "string" ? task.status.toLowerCase() : "";
  if (status === "failed" || status === "cancelled") {
    const err = isRecord(task.error) && typeof task.error.message === "string" ? task.error.message : status;
    throw new Error(`${modelName} failed: ${err.slice(0, 160)}`);
  }
  if (status !== "succeeded") return { status: "running", note: status || undefined };
  const url = isRecord(task.content) && typeof task.content.url === "string" ? task.content.url : "";
  if (!url) throw new Error(`${modelName} returned no video — try rephrasing your prompt.`);
  return { status: "done", url, mimeType: "video/mp4" };
}

/** Z.ai CogVideoX /videos/generations: size, quality, duration, with_audio, fps. */
export function zhipuVideoBody(providerModel: string, prompt: string, wire: MediaWire | null): UnknownRecord {
  return { model: providerModel, prompt, ...(wire?.body ?? {}) };
}

/*
 * xAI Grok Imagine Video, per docs.x.ai (read 2026-10-03):
 *
 *   POST {base}/videos/generations  { model, prompt, duration?, aspect_ratio?, resolution?, generate_audio? }
 *     → { request_id }
 *   GET  {base}/videos/{request_id}
 *     → { status: "pending" | "done" | "failed" | "expired", progress?, video?: { url, duration }, error?: { code, message } }
 *
 * Without choices the body is the model and the prompt: xAI's own defaults
 * (8s, 480p) apply.
 */
export function xaiVideoStartBody(providerModel: string, prompt: string, wire: MediaWire | null): UnknownRecord {
  return { model: providerModel, prompt, ...(wire?.body ?? {}) };
}

export type VideoPollResult =
  | { status: "running"; pct?: number; note?: string }
  | { status: "done"; url: string; mimeType: string };

export function parseXaiVideoPoll(data: unknown, modelName = "Grok Imagine Video"): VideoPollResult {
  const d = isRecord(data) ? data : {};
  const status = typeof d.status === "string" ? d.status.toLowerCase() : "";
  if (status === "failed" || status === "expired") {
    const err = isRecord(d.error) && typeof d.error.message === "string" ? d.error.message : status === "expired" ? "the request expired" : "generation error";
    throw new Error(`${modelName} failed: ${err.slice(0, 160)}`);
  }
  if (status !== "done") {
    const pct = typeof d.progress === "number" && Number.isFinite(d.progress) ? Math.max(0, Math.min(100, Math.round(d.progress))) : undefined;
    return pct === undefined ? { status: "running", note: status || undefined } : { status: "running", pct, note: status || undefined };
  }
  const url = isRecord(d.video) && typeof d.video.url === "string" ? d.video.url : "";
  if (!url) throw new Error(`${modelName} returned no video — try rephrasing your prompt.`);
  return { status: "done", url, mimeType: "video/mp4" };
}

function xaiBase(call: ProviderCall): string {
  return (call.baseUrl ?? "https://api.x.ai/v1").replace(/\/+$/, "");
}

async function readJson(res: Response): Promise<{ text: string; data: unknown }> {
  const text = await res.text().catch(() => "");
  try {
    return { text, data: text ? JSON.parse(text) : {} };
  } catch {
    return { text, data: {} };
  }
}

export async function startXaiVideo(
  model: Pick<ModelInfo, "providerModel" | "name">,
  prompt: string,
  wire: MediaWire | null,
  call: ProviderCall,
): Promise<string> {
  const doFetch = call.fetchImpl ?? fetch;
  const res = await doFetch(`${xaiBase(call)}/videos/generations`, {
    method: "POST",
    headers: { Authorization: `Bearer ${call.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(xaiVideoStartBody(model.providerModel, prompt, wire)),
    signal: AbortSignal.timeout(call.timeoutMs ?? 30_000),
  });
  const { text, data } = await readJson(res);
  const id = isRecord(data) && typeof data.request_id === "string" ? data.request_id : "";
  if (!res.ok || !id) {
    const detail = isRecord(data) && isRecord(data.error) && typeof data.error.message === "string" ? data.error.message : text;
    throw new Error(`${model.name} rejected the request (${res.status}). ${detail.slice(0, 160)}`);
  }
  return id;
}

export async function pollXaiVideo(model: Pick<ModelInfo, "name">, id: string, call: ProviderCall): Promise<VideoPollResult> {
  const doFetch = call.fetchImpl ?? fetch;
  const res = await doFetch(`${xaiBase(call)}/videos/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${call.apiKey}` },
    signal: AbortSignal.timeout(call.timeoutMs ?? 30_000),
  });
  const { text, data } = await readJson(res);
  if (!res.ok) throw new Error(`Polling ${model.name} failed (${res.status}). ${text.slice(0, 160)}`);
  return parseXaiVideoPoll(data, model.name);
}
