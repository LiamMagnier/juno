import type { ModelInfo } from "@/lib/models";
import { sniffAudioMime } from "@/lib/uploads";
import type { MediaWire } from "@/lib/media-params";

/*
 * Music generation with Google's Lyria, through the Gemini Interactions API.
 *
 * Per https://ai.google.dev/gemini-api/docs/music-generation (read 2026-10-03):
 *
 *   POST {base}/interactions   x-goog-api-key: <key>
 *   { "model": "lyria-3.5", "input": "A beautiful piano melody." }
 *
 * is synchronous and answers with the whole Interaction. Its `steps` hold
 * `model_output` steps whose `content` blocks are `{ type: "audio", data }`
 * (base64, MP3 by default) and `{ type: "text", text }` ("the generated lyrics
 * or a JSON description of the song structure"). Lyria 3 Clip always makes 30
 * seconds; Lyria 3.5 "a couple of minutes", steered by the prompt itself.
 *
 * This module is the pure half: the request, the response parser, the error
 * wording and the price. `audio-gen.ts` is the server-only wrapper that reads
 * the key. Kept apart so the tests can drive all of it with a mocked fetch.
 */

export interface GeneratedAudio {
  bytes: Buffer;
  /** Sniffed from the bytes, never taken from the provider's label. */
  mimeType: "audio/mpeg" | "audio/wav" | "audio/flac" | "audio/ogg";
  ext: "mp3" | "wav" | "flac" | "ogg";
  /** The lyrics (or the song's structure, rendered as text), when Lyria sent any. */
  lyrics: string | null;
}

/**
 * Long enough for a full Lyria 3.5 song, short enough to finish inside
 * /api/generate's `maxDuration` of 300s with time left to upload and persist.
 */
export const LYRIA_TIMEOUT_MS = 240_000;

/** Flat per-request price in micro-USD, from Google's pricing page (2026-10-03). */
export const LYRIA_SONG_MICRO_USD = 80_000; // Lyria 3.5 and Lyria 3 Pro: $0.08 per song
export const LYRIA_CLIP_MICRO_USD = 40_000; // Lyria 3 Clip: $0.04 per 30s clip

export function audioRequestCostMicroUsd(modelId: string): number {
  return /clip/i.test(modelId) ? LYRIA_CLIP_MICRO_USD : LYRIA_SONG_MICRO_USD;
}

/** True for a model this module can run. */
export function isAudioGenSupported(model: Pick<ModelInfo, "provider" | "modality">): boolean {
  return model.modality === "audio" && model.provider === "google";
}

/**
 * The documented request body: the model and the prompt, plus the person's
 * choices when they made any (media-params.ts: `response_format` for WAV on
 * Lyria 3.5). The instrumental choice travels in the prompt, which the caller
 * has already extended.
 */
export function buildLyriaRequestBody(
  providerModel: string,
  prompt: string,
  wire: MediaWire | null = null,
): { model: string; input: string } & Record<string, unknown> {
  // No `response_format` by default: MP3 is the documented default, it is what
  // every browser plays, and a full song as WAV is ~30 MB of base64 in one
  // response. Only an explicit WAV choice asks for it.
  return { ...(wire?.body ?? {}), model: providerModel, input: prompt };
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Content blocks of every model-output step, in order. Older previews used `outputs`. */
function contentBlocks(data: UnknownRecord): UnknownRecord[] {
  const blocks: UnknownRecord[] = [];
  if (Array.isArray(data.steps)) {
    for (const step of data.steps) {
      if (!isRecord(step)) continue;
      // `interactions.create` returns only model steps, but a stored
      // interaction also carries the `user_input` step: never read the
      // prompt back as lyrics.
      if (typeof step.type === "string" && step.type !== "model_output") continue;
      if (Array.isArray(step.content)) for (const block of step.content) if (isRecord(block)) blocks.push(block);
    }
  }
  if (Array.isArray(data.outputs)) for (const block of data.outputs) if (isRecord(block)) blocks.push(block);
  return blocks;
}

const SECTION_NAME_KEYS = ["section", "name", "label", "title", "type"];
const SECTION_TEXT_KEYS = ["lyrics", "text", "content", "lines"];

/** One section of a structure JSON as "[Chorus]\nline\nline", when it has words. */
function sectionText(section: unknown): string | null {
  if (typeof section === "string") return section.trim() || null;
  if (!isRecord(section)) return null;
  const name = SECTION_NAME_KEYS.map((k) => section[k]).find((v): v is string => typeof v === "string" && !!v.trim());
  let words: string | undefined;
  for (const key of SECTION_TEXT_KEYS) {
    const v = section[key];
    if (typeof v === "string" && v.trim()) words = v.trim();
    else if (Array.isArray(v)) {
      const lines = v.filter((l): l is string => typeof l === "string" && !!l.trim());
      if (lines.length) words = lines.join("\n");
    }
    if (words) break;
  }
  if (!words) return null;
  return name ? `[${name.trim().replace(/^\[|\]$/g, "")}]\n${words}` : words;
}

/**
 * The text blocks as something a person reads. Plain lyrics pass through. A
 * JSON structure description becomes its lyrics, section by section; one with
 * no words in it (an instrumental's timing map) becomes nothing rather than a
 * wall of braces in the transcript.
 */
export function readableLyrics(texts: string[]): string | null {
  const out: string[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    if (/^[[{]/.test(text)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        out.push(text);
        continue;
      }
      if (isRecord(parsed) && typeof parsed.lyrics === "string") {
        if (parsed.lyrics.trim()) out.push(parsed.lyrics.trim());
        continue;
      }
      const sections = Array.isArray(parsed)
        ? parsed
        : isRecord(parsed)
          ? (["sections", "structure", "song", "parts"].map((k) => parsed[k]).find(Array.isArray) as unknown[] | undefined) ?? []
          : [];
      const rendered = sections.map(sectionText).filter((s): s is string => !!s);
      if (rendered.length) out.push(rendered.join("\n\n"));
      continue;
    }
    out.push(text);
  }
  const joined = out.join("\n\n").trim();
  return joined ? joined.slice(0, 20_000) : null;
}

/**
 * Lyrics as the transcript's Markdown: each line kept as its own line (a hard
 * break, since Markdown would otherwise run a verse into one paragraph), a
 * section tag such as "[Chorus]" set in italics on its own line, and a line that
 * merely LOOKS like Markdown ("- ", "# ", "1. ", "> ", emphasis) escaped so a lyric is
 * never turned into a list or a heading.
 */
export function lyricsMarkdown(lyrics: string): string {
  return lyrics
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((stanza) =>
      stanza
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const tag = line.match(/^\[([^\]]{1,60})\]$/);
          if (tag) return `*${tag[1].trim()}*`;
          return line.replace(/([*_`])/g, "\\$1").replace(/^([#>+-])(\s)/, "\\$1$2").replace(/^(\d+)([.)])(\s)/, "$1\\$2$3");
        })
        .join("  \n"),
    )
    .filter(Boolean)
    .join("\n\n");
}

const EXT: Record<GeneratedAudio["mimeType"], GeneratedAudio["ext"]> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
};

const BLOCKED_HINT =
  "Lyria's safety filters turn down requests for a named artist's voice or for copyrighted lyrics. Describe the style, mood and instruments instead.";

function errorText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value) && typeof value.message === "string") return value.message;
  return undefined;
}

/** A completed Interaction → the track, its type sniffed from its own bytes, and its lyrics. */
export function parseLyriaInteraction(data: unknown, modelName = "Lyria"): GeneratedAudio {
  if (!isRecord(data)) throw new Error(`${modelName} returned a response we couldn't read.`);

  const status = typeof data.status === "string" ? data.status.toLowerCase() : "";
  if (status === "failed" || status === "cancelled") {
    const reason = errorText(data.error);
    throw new Error(`${modelName} couldn't make this track${reason ? `: ${reason}` : "."}`);
  }

  let audioData: string | null = null;
  const texts: string[] = [];
  for (const block of contentBlocks(data)) {
    const type = typeof block.type === "string" ? block.type.toLowerCase() : "";
    if (type === "audio" && typeof block.data === "string" && block.data) audioData = block.data; // the last one wins
    else if (type === "text" && typeof block.text === "string") texts.push(block.text);
  }

  if (!audioData) {
    // A prompt the filters stopped comes back without an audio block.
    throw new Error(`${modelName} returned no audio. ${BLOCKED_HINT}`);
  }
  const match = audioData.match(/^data:[^;,]+;base64,(.+)$/s);
  const bytes = Buffer.from(match ? match[1] : audioData, "base64");
  const sniffed = sniffAudioMime(bytes.subarray(0, 16)) as GeneratedAudio["mimeType"] | null;
  if (!sniffed || bytes.length < 1024) {
    throw new Error(`${modelName} returned audio we couldn't play. Try again.`);
  }
  return { bytes, mimeType: sniffed, ext: EXT[sniffed], lyrics: readableLyrics(texts) };
}

/** A non-2xx answer from the Interactions API, in words a person can act on. */
export function lyriaErrorMessage(status: number, body: string, modelName = "Lyria"): string {
  let detail = "";
  try {
    const parsed = JSON.parse(body) as unknown;
    detail = (isRecord(parsed) ? errorText(parsed.error) : undefined) ?? "";
  } catch {
    detail = body;
  }
  detail = detail.replace(/\s+/g, " ").trim().slice(0, 200);
  if (status === 429) return `${modelName} is at its limit right now. Give it a minute and try again.`;
  if (/safety|blocked|prohibited|copyright|recitation|policy|artist/i.test(detail)) return `${modelName} declined this prompt. ${BLOCKED_HINT}`;
  if (status === 401 || status === 403) return `Google refused the API key for ${modelName}. Check that the key has the Gemini API enabled.`;
  if (status === 404) return `${modelName} isn't available to this Google API key yet.`;
  if (status >= 500) return `Google's music service had a problem (${status}). Try again in a moment.`;
  return `${modelName} rejected the request (${status})${detail ? `: ${detail}` : "."}`;
}

export interface LyriaRequestOptions {
  apiKey: string;
  /** e.g. https://generativelanguage.googleapis.com/v1beta (googleNativeBaseUrl()). */
  baseUrl: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** The person's choices, mapped (media-params.ts wireParams). */
  wire?: MediaWire | null;
}

/** One synchronous Lyria generation, end to end. */
export async function requestLyriaTrack(
  model: Pick<ModelInfo, "providerModel" | "name">,
  prompt: string,
  opts: LyriaRequestOptions,
): Promise<GeneratedAudio> {
  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${opts.baseUrl.replace(/\/+$/, "")}/interactions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": opts.apiKey },
      body: JSON.stringify(buildLyriaRequestBody(model.providerModel, prompt, opts.wire ?? null)),
      signal: AbortSignal.timeout(opts.timeoutMs ?? LYRIA_TIMEOUT_MS),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new Error(`${model.name} took too long to finish this track. Try a shorter song or Lyria 3 Clip.`);
    }
    throw new Error(`Couldn't reach ${model.name}. Check the connection and try again.`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) throw new Error(lyriaErrorMessage(res.status, text, model.name));
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${model.name} returned a response we couldn't read.`);
  }
  return parseLyriaInteraction(data, model.name);
}
