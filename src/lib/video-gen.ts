import "server-only";
import { providerApiKey, providerBaseUrl } from "@/lib/providers";
import type { ModelInfo } from "@/lib/models";
import { isGoogleOmniModel, parseGoogleOmniInteraction } from "@/lib/video-gen-core";
import type { MediaWire } from "@/lib/media-params";
import {
  googleOmniStartBody,
  minimaxVideoBody,
  minimaxH3Body,
  minimaxV2Host,
  parseMinimaxH3Poll,
  pollXaiVideo,
  seedanceStartBody,
  startXaiVideo,
  veoStartBody,
  zhipuVideoBody,
} from "@/lib/media-gen-core";

export { parseGoogleOmniInteraction } from "@/lib/video-gen-core";

/*
 * Video generation is asynchronous on every provider: start a job, poll until
 * it finishes, then download the file. Each provider gets a small adapter
 * (start + poll); generateVideo drives the loop and reports progress so the
 * route can stream it. All HTTP goes through fetch with per-call timeouts.
 */

export interface GeneratedVideo {
  bytes: Buffer;
  mimeType: string;
  ext: string;
}

export interface VideoProgress {
  stage: "queued" | "generating" | "polling" | "downloading";
  pct?: number;
  note?: string;
}

export interface VideoJobHandle {
  model: ModelInfo;
  /** Provider-specific job/operation id (Google: full operation name). */
  id: string;
}

export type VideoJobPoll =
  | { status: "running"; pct?: number; note?: string }
  | { status: "done"; bytes?: Buffer; url?: string; mimeType?: string; downloadHeaders?: Record<string, string> };

interface VideoAdapter {
  /** `wire` is the person's choices (media-params.ts); null sends today's request unchanged. */
  start(model: ModelInfo, prompt: string, wire: MediaWire | null): Promise<string>;
  poll(model: ModelInfo, id: string): Promise<VideoJobPoll>;
}

const POLL_INTERVAL_MS = 4_000;
const OVERALL_CAP_MS = 240_000;
const CALL_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
  timeoutMs = CALL_TIMEOUT_MS
): Promise<{ ok: boolean; status: number; data: T; text: string }> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text().catch(() => "");
  let data = {} as T;
  try {
    data = text ? (JSON.parse(text) as T) : ({} as T);
  } catch {
    data = {} as T;
  }
  return { ok: res.ok, status: res.status, data, text };
}

function extForVideo(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("quicktime")) return "mov";
  return "mp4";
}

async function downloadVideo(url: string, headers?: Record<string, string>): Promise<{ bytes: Buffer; mimeType: string }> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`Could not download the generated video (${res.status}).`);
  const raw = res.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  const mimeType = raw.startsWith("video/") ? raw : "video/mp4";
  return { bytes: Buffer.from(await res.arrayBuffer()), mimeType };
}

// ---- Google (Veo) — models.{id}:predictLongRunning + operations polling ----

const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface GoogleVideoSample {
  video?: { uri?: string; bytesBase64Encoded?: string; mimeType?: string };
}

interface GoogleOperation {
  name?: string;
  done?: boolean;
  error?: { message?: string };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: GoogleVideoSample[];
      raiMediaFilteredCount?: number;
      raiMediaFilteredReasons?: string[];
    };
    generatedVideos?: GoogleVideoSample[];
  };
}

function googleHeaders(): Record<string, string> {
  const key = providerApiKey("google");
  if (!key) throw new Error("Google API key is not configured.");
  return { "Content-Type": "application/json", "x-goog-api-key": key };
}

interface GoogleOmniInteraction {
  id?: string;
  status?: string;
  error?: { message?: string } | string;
  steps?: unknown[];
  outputs?: unknown[];
  output?: unknown;
}

function googleOmniHeaders(): Record<string, string> {
  return { ...googleHeaders(), "Api-Revision": "2026-05-20" };
}

const googleOmniAdapter: VideoAdapter = {
  async start(model, prompt, wire) {
    const { ok, status, data, text } = await fetchJson<GoogleOmniInteraction>(
      `${GOOGLE_API_BASE}/interactions`,
      {
        method: "POST",
        headers: googleOmniHeaders(),
        // URI delivery for larger clips; the poll parser also accepts the
        // inline base64 form.
        body: JSON.stringify(googleOmniStartBody(model.providerModel, prompt, wire)),
      }
    );
    if (!ok || !data.id) {
      throw new Error(`${model.name} rejected the request (${status}). ${text.slice(0, 160)}`);
    }
    return data.id;
  },

  async poll(model, id) {
    const { ok, status, data, text } = await fetchJson<GoogleOmniInteraction>(
      `${GOOGLE_API_BASE}/interactions/${encodeURIComponent(id)}`,
      { headers: googleOmniHeaders() }
    );
    if (!ok) throw new Error(`Polling ${model.name} failed (${status}). ${text.slice(0, 160)}`);
    return parseGoogleOmniInteraction(data, model.name, { "x-goog-api-key": providerApiKey("google")! });
  },
};

const googleVeoAdapter: VideoAdapter = {
  async start(model, prompt, wire) {
    const { ok, status, data, text } = await fetchJson<GoogleOperation>(
      `${GOOGLE_API_BASE}/models/${model.providerModel}:predictLongRunning`,
      { method: "POST", headers: googleHeaders(), body: JSON.stringify(veoStartBody(prompt, wire)) }
    );
    if (!ok || !data.name) {
      throw new Error(`${model.name} rejected the request (${status}). ${text.slice(0, 160)}`);
    }
    return data.name;
  },

  async poll(model, id) {
    const { ok, status, data, text } = await fetchJson<GoogleOperation>(`${GOOGLE_API_BASE}/${id}`, {
      headers: googleHeaders(),
    });
    if (!ok) throw new Error(`Polling ${model.name} failed (${status}). ${text.slice(0, 160)}`);
    if (!data.done) return { status: "running" };
    if (data.error) throw new Error(`${model.name} failed: ${data.error.message ?? "unknown error"}`);

    const gen = data.response?.generateVideoResponse;
    const sample = gen?.generatedSamples?.[0]?.video ?? data.response?.generatedVideos?.[0]?.video;
    if (!sample?.uri && !sample?.bytesBase64Encoded) {
      const reason = gen?.raiMediaFilteredReasons?.[0];
      throw new Error(reason ? `${model.name} filtered the result: ${reason}` : `${model.name} returned no video — try rephrasing your prompt.`);
    }
    const mimeType = sample.mimeType?.startsWith("video/") ? sample.mimeType : "video/mp4";
    if (sample.bytesBase64Encoded) {
      return { status: "done", bytes: Buffer.from(sample.bytesBase64Encoded, "base64"), mimeType };
    }
    // The file URI requires the API key on download too.
    return { status: "done", url: sample.uri, mimeType, downloadHeaders: { "x-goog-api-key": providerApiKey("google")! } };
  },
};

// ---- MiniMax (Hailuo) — /video_generation → /query/video_generation → /files/retrieve ----

interface MiniMaxBaseResp {
  base_resp?: { status_code?: number; status_msg?: string };
}

function minimaxAuth(): { base: string; headers: Record<string, string> } {
  const key = providerApiKey("minimax");
  if (!key) throw new Error("MiniMax API key is not configured.");
  const base = (providerBaseUrl("minimax") ?? "https://api.minimax.io/v1").replace(/\/$/, "");
  return { base, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

function minimaxError(data: MiniMaxBaseResp, fallback: string): string {
  return data.base_resp?.status_msg || fallback;
}

const minimaxAdapter: VideoAdapter = {
  async start(model, prompt, wire) {
    const { base, headers } = minimaxAuth();
    const { ok, status, data, text } = await fetchJson<MiniMaxBaseResp & { task_id?: string }>(`${base}/video_generation`, {
      method: "POST",
      headers,
      body: JSON.stringify(minimaxVideoBody(model.providerModel, prompt, wire)),
    });
    if (!ok || (data.base_resp?.status_code != null && data.base_resp.status_code !== 0) || !data.task_id) {
      throw new Error(`${model.name} rejected the request (${status}). ${minimaxError(data, text).slice(0, 160)}`);
    }
    return data.task_id;
  },

  async poll(model, id) {
    const { base, headers } = minimaxAuth();
    const { ok, status, data, text } = await fetchJson<MiniMaxBaseResp & { status?: string; file_id?: string }>(
      `${base}/query/video_generation?task_id=${encodeURIComponent(id)}`,
      { headers }
    );
    if (!ok) throw new Error(`Polling ${model.name} failed (${status}). ${minimaxError(data, text).slice(0, 160)}`);
    const state = data.status ?? "";
    if (state === "Fail" || (data.base_resp?.status_code != null && data.base_resp.status_code !== 0)) {
      throw new Error(`${model.name} failed: ${minimaxError(data, "generation error").slice(0, 160)}`);
    }
    if (state !== "Success") return { status: "running", note: state || undefined };
    if (!data.file_id) throw new Error(`${model.name} finished but returned no file.`);

    const file = await fetchJson<MiniMaxBaseResp & { file?: { download_url?: string } }>(
      `${base}/files/retrieve?file_id=${encodeURIComponent(data.file_id)}`,
      { headers }
    );
    const url = file.data.file?.download_url;
    if (!file.ok || !url) throw new Error(`Could not retrieve the ${model.name} video file.`);
    return { status: "done", url, mimeType: "video/mp4" };
  },
};

// ---- MiniMax H3 / H3 Max — the V2 API: /v2/video_generation → /v2/query/video_generation/{id} ----
// Request and parsing live in media-gen-core.ts (minimaxH3Body / parseMinimaxH3Poll).

const minimaxH3Adapter: VideoAdapter = {
  async start(model, prompt, wire) {
    const { base, headers } = minimaxAuth();
    const { ok, status, data, text } = await fetchJson<{ task_id?: string; error?: { message?: string } }>(
      `${minimaxV2Host(base)}/v2/video_generation`,
      { method: "POST", headers, body: JSON.stringify(minimaxH3Body(model.providerModel, prompt, wire)) }
    );
    if (!ok || !data.task_id) {
      throw new Error(`${model.name} rejected the request (${status}). ${(data.error?.message ?? text).slice(0, 160)}`);
    }
    return data.task_id;
  },

  async poll(model, id) {
    const { base, headers } = minimaxAuth();
    const { ok, status, data, text } = await fetchJson<{ error?: { message?: string } }>(
      `${minimaxV2Host(base)}/v2/query/video_generation/${encodeURIComponent(id)}`,
      { headers }
    );
    if (!ok) throw new Error(`Polling ${model.name} failed (${status}). ${(data.error?.message ?? text).slice(0, 160)}`);
    return parseMinimaxH3Poll(data, model.name);
  },
};

// ---- Zhipu (CogVideoX) — /videos/generations → /async-result/{id} ----

interface ZhipuVideoTask {
  id?: string;
  task_status?: string;
  video_result?: Array<{ url?: string }>;
  error?: { message?: string };
}

function zhipuAuth(): { base: string; headers: Record<string, string> } {
  const key = providerApiKey("zhipu");
  if (!key) throw new Error("Zhipu API key is not configured.");
  const base = (providerBaseUrl("zhipu") ?? "https://api.z.ai/api/paas/v4").replace(/\/$/, "");
  return { base, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

const zhipuAdapter: VideoAdapter = {
  async start(model, prompt, wire) {
    const { base, headers } = zhipuAuth();
    const { ok, status, data, text } = await fetchJson<ZhipuVideoTask>(`${base}/videos/generations`, {
      method: "POST",
      headers,
      body: JSON.stringify(zhipuVideoBody(model.providerModel, prompt, wire)),
    });
    if (!ok || !data.id) {
      throw new Error(`${model.name} rejected the request (${status}). ${(data.error?.message ?? text).slice(0, 160)}`);
    }
    return data.id;
  },

  async poll(model, id) {
    const { base, headers } = zhipuAuth();
    const { ok, status, data, text } = await fetchJson<ZhipuVideoTask>(`${base}/async-result/${encodeURIComponent(id)}`, {
      headers,
    });
    if (!ok) throw new Error(`Polling ${model.name} failed (${status}). ${(data.error?.message ?? text).slice(0, 160)}`);
    const state = (data.task_status ?? "").toUpperCase();
    if (state === "FAIL") throw new Error(`${model.name} failed: ${data.error?.message ?? "generation error"}`);
    if (state !== "SUCCESS") return { status: "running", note: state ? state.toLowerCase() : undefined };
    const url = data.video_result?.[0]?.url;
    if (!url) throw new Error(`${model.name} returned no video — try rephrasing your prompt.`);
    return { status: "done", url, mimeType: "video/mp4" };
  },
};

// ---- ByteDance Seedance (BytePlus / Volcengine Ark) ----
// Async video: POST /contents/generations/tasks → poll GET /contents/generations/tasks/{id}.
// The task id is `id`; the finished MP4 URL is at `content.video_url` once status is
// "succeeded". Ark URLs expire after ~24h, but generateVideo downloads immediately.

interface ArkVideoTask {
  id?: string;
  status?: string; // queued | running | succeeded | failed | expired | cancelled
  content?: { video_url?: string };
  error?: { message?: string; code?: string };
}

function seedanceAuth(): { base: string; headers: Record<string, string> } {
  const key = providerApiKey("seedance");
  if (!key) throw new Error("Seedance (ByteDance Ark) API key is not configured.");
  const base = (providerBaseUrl("seedance") ?? "https://ark.ap-southeast.bytepluses.com/api/v3").replace(/\/$/, "");
  return { base, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } };
}

const seedanceAdapter: VideoAdapter = {
  async start(model, prompt, wire) {
    const { base, headers } = seedanceAuth();
    const { ok, status, data, text } = await fetchJson<ArkVideoTask>(`${base}/contents/generations/tasks`, {
      method: "POST",
      headers,
      body: JSON.stringify(seedanceStartBody(model.providerModel, prompt, wire)),
    });
    if (!ok || !data.id) {
      throw new Error(`${model.name} rejected the request (${status}). ${(data.error?.message ?? text).slice(0, 160)}`);
    }
    return data.id;
  },

  async poll(model, id) {
    const { base, headers } = seedanceAuth();
    const { ok, status, data, text } = await fetchJson<ArkVideoTask>(
      `${base}/contents/generations/tasks/${encodeURIComponent(id)}`,
      { headers }
    );
    if (!ok) throw new Error(`Polling ${model.name} failed (${status}). ${(data.error?.message ?? text).slice(0, 160)}`);
    const state = (data.status ?? "").toLowerCase();
    if (state === "failed" || state === "expired" || state === "cancelled" || state === "canceled") {
      throw new Error(`${model.name} failed: ${data.error?.message ?? (state || "generation error")}`);
    }
    if (state !== "succeeded") return { status: "running", note: state || undefined };
    const url = data.content?.video_url;
    if (!url) throw new Error(`${model.name} returned no video — try rephrasing your prompt.`);
    return { status: "done", url, mimeType: "video/mp4" };
  },
};

// ---- xAI (Grok Imagine Video) — /videos/generations → /videos/{request_id} ----
// Request and parsing live in media-gen-core.ts (startXaiVideo / pollXaiVideo).

function xaiCall(): { apiKey: string; baseUrl?: string } {
  const apiKey = providerApiKey("xai");
  if (!apiKey) throw new Error("xAI API key is not configured.");
  return { apiKey, baseUrl: providerBaseUrl("xai") };
}

const xaiAdapter: VideoAdapter = {
  async start(model, prompt, wire) {
    return startXaiVideo(model, prompt, wire, xaiCall());
  },
  async poll(model, id) {
    return pollXaiVideo(model, id, xaiCall());
  },
};

function adapterFor(model: ModelInfo): VideoAdapter | null {
  if (isGoogleOmniModel(model)) return googleOmniAdapter;
  if (model.provider === "google" && model.providerModel.startsWith("veo-")) return googleVeoAdapter;
  if (model.provider === "minimax" && model.providerModel.startsWith("MiniMax-H3")) return minimaxH3Adapter;
  if (model.provider === "minimax") return minimaxAdapter;
  if (model.provider === "zhipu") return zhipuAdapter;
  if (model.provider === "seedance") return seedanceAdapter;
  if (model.provider === "xai" && model.providerModel.startsWith("grok-imagine-video")) return xaiAdapter;
  return null;
}

export function isVideoGenSupported(model: ModelInfo): boolean {
  return adapterFor(model) !== null;
}

export function videoGenUnsupportedMessage(model: ModelInfo): string {
  return `Video generation for ${model.name} is not wired yet — try Veo, Gemini Omni, or Hailuo.`;
}

export async function startVideoJob(model: ModelInfo, prompt: string, wire: MediaWire | null = null): Promise<VideoJobHandle> {
  const adapter = adapterFor(model);
  if (!adapter) throw new Error(videoGenUnsupportedMessage(model));
  const id = await adapter.start(model, prompt, wire);
  return { model, id };
}

export async function pollVideoJob(handle: VideoJobHandle): Promise<VideoJobPoll> {
  const adapter = adapterFor(handle.model);
  if (!adapter) throw new Error(videoGenUnsupportedMessage(handle.model));
  return adapter.poll(handle.model, handle.id);
}

/** Start a job, poll it to completion (~4s interval, 240s cap), download the result. */
/**
 * A video job that failed AFTER the provider accepted and (probably) rendered
 * it: our deadline ran out while it was still going, or the finished file
 * could not be downloaded. The provider bills those, so the caller does too.
 * A job the provider itself reported as failed is a plain Error and is not
 * billed.
 */
export class BillableVideoError extends Error {
  readonly billable = true;
  constructor(message: string) {
    super(message);
    this.name = "BillableVideoError";
  }
}

export async function generateVideo(
  model: ModelInfo,
  prompt: string,
  onProgress?: (p: VideoProgress) => void,
  wire: MediaWire | null = null
): Promise<GeneratedVideo> {
  const handle = await startVideoJob(model, prompt, wire);
  onProgress?.({ stage: "queued", note: `${model.name} accepted the job` });

  const deadline = Date.now() + OVERALL_CAP_MS;
  while (true) {
    if (Date.now() > deadline) {
      throw new BillableVideoError(`${model.name} took longer than ${Math.round(OVERALL_CAP_MS / 1000)}s — try again in a bit.`);
    }
    await sleep(POLL_INTERVAL_MS);
    const poll = await pollVideoJob(handle);
    if (poll.status === "running") {
      onProgress?.({ stage: "polling", pct: poll.pct, note: poll.note });
      continue;
    }
    if (poll.bytes) {
      const mimeType = poll.mimeType ?? "video/mp4";
      return { bytes: poll.bytes, mimeType, ext: extForVideo(mimeType) };
    }
    if (!poll.url) throw new Error(`${model.name} returned no video — try again.`);
    onProgress?.({ stage: "downloading" });
    const file = await downloadVideo(poll.url, poll.downloadHeaders).catch((err: unknown) => {
      throw new BillableVideoError(err instanceof Error ? err.message : String(err));
    });
    const mimeType = file.mimeType.startsWith("video/") ? file.mimeType : poll.mimeType ?? "video/mp4";
    return { bytes: file.bytes, mimeType, ext: extForVideo(mimeType) };
  }
}
