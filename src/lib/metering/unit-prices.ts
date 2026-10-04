/**
 * Unit prices for the paid calls that are NOT billed per chat token: speech
 * (TTS), transcription (STT), embeddings, OpenAI image tokens, and the
 * operator's own unattributed utility spend.
 *
 * Pure (no Prisma, no `server-only`) so every figure is pinned by a test
 * (tests/usage-metering-unit-prices.test.ts). All money is integer micro-USD.
 *
 * RULE: when a price could not be verified, it is set HIGH, never low — an
 * account that is over-charged by a cent is a support ticket, an account that
 * is under-charged is the operator paying for it. Each figure carries its
 * source and the day it was read.
 */

// ── Speech synthesis (TTS) ─────────────────────────────────────────────────

export type TtsEngine = "google" | "openai" | "elevenlabs";

/**
 * Seconds of speech a text produces, estimated HIGH: 12 characters a second is
 * slower than conversational speech (~15), so the estimate errs towards more
 * audio, i.e. more money.
 */
export const TTS_CHARS_PER_SECOND = 12;

/**
 * Per-engine rates.
 *  - google  gemini-3.8-flash-tts: $1.00/M text in, $18.00/M audio out, at
 *            25 audio tokens a second. The 2027 rate (the 2026 promo is
 *            $0.50/$9.00) so the figure does not silently halve in January.
 *            ai.google.dev/gemini-api/docs/pricing, read 2026-10-04.
 *  - openai  gpt-4o-mini-tts: $0.60/M text in, $12.00/M audio out, ~$0.015 a
 *            minute. developers.openai.com/api/docs/pricing, read 2026-10-04.
 *  - elevenlabs eleven_multilingual_v2: UNVERIFIED (depends on the operator's
 *            plan; overage runs $0.18-$0.30 per 1k characters). Billed at the
 *            top of that range: $0.30 per 1k characters.
 */
export function ttsCostMicroUsd(engine: TtsEngine, input: { chars: number; audioSeconds?: number | null }): number {
  const chars = Math.max(0, Math.floor(input.chars || 0));
  const seconds =
    input.audioSeconds != null && Number.isFinite(input.audioSeconds) && input.audioSeconds > 0
      ? input.audioSeconds
      : chars / TTS_CHARS_PER_SECOND;
  const textTokens = Math.ceil(chars / 4);
  switch (engine) {
    case "google":
      return Math.ceil(textTokens * 1.0 + seconds * 25 * 18.0);
    case "openai":
      // $0.015 a minute = 250 micro-USD a second.
      return Math.ceil(textTokens * 0.6 + seconds * 250);
    case "elevenlabs":
      return Math.ceil(chars * 300);
  }
}

/** Seconds of 24 kHz mono 16-bit PCM in a WAV body (Gemini TTS answers in it). */
export function wavSeconds(byteLength: number, sampleRate = 24_000): number {
  return Math.max(0, byteLength - 44) / (sampleRate * 2);
}

// ── Transcription (STT) ────────────────────────────────────────────────────

export type SttEngine = "openai" | "deepgram" | "gemini";

/**
 * How long an uploaded clip is, estimated HIGH from its size. WAV (what the
 * native dictation records, 16 kHz mono 16-bit) is exactly 32,000 bytes a
 * second. Anything compressed (webm/opus, m4a, mp3) is assumed to be 16 kbps
 * — lower than any browser records at — so its duration, and its price, is
 * over- rather than under-stated.
 */
export function estimateAudioSeconds(byteLength: number, mimeType: string): number {
  const bytes = Math.max(0, byteLength);
  const mime = (mimeType || "").toLowerCase();
  if (mime.includes("wav") || mime.includes("pcm")) return bytes / 32_000;
  return bytes / 2_000;
}

/**
 * One transcription.
 *  - openai  gpt-4o-transcribe ~$0.006/min ($2.50/M audio in, $10/M text
 *            out); whisper-1 $0.006/min. When the response carries token usage
 *            the tokens win, else the duration.
 *  - deepgram nova-3 multilingual pay-as-you-go: $0.0052/min, billed at
 *            $0.006/min (unverified on this account's tier).
 *  - gemini  gemini-3.5-flash-lite: $0.50/M audio in at 32 tokens a second,
 *            $2.50/M text out; the response's usageMetadata wins when present.
 *  Sources: OpenAI + Google pricing pages, read 2026-10-04.
 */
export function sttCostMicroUsd(
  engine: SttEngine,
  input: { audioSeconds: number; inputTokens?: number | null; outputTokens?: number | null; outputChars?: number }
): number {
  const seconds = Math.max(1, input.audioSeconds || 0);
  const outTokens = input.outputTokens ?? Math.ceil((input.outputChars ?? 0) / 4);
  switch (engine) {
    case "openai": {
      const byDuration = Math.ceil(seconds * 100); // $0.006/min
      if (input.inputTokens != null) {
        return Math.max(byDuration, Math.ceil(input.inputTokens * 2.5 + outTokens * 10));
      }
      return byDuration;
    }
    case "deepgram":
      return Math.ceil(seconds * 100);
    case "gemini": {
      const inTokens = input.inputTokens ?? Math.ceil(seconds * 32) + 100;
      return Math.ceil(inTokens * 0.5 + outTokens * 2.5);
    }
  }
}

// ── Embeddings ─────────────────────────────────────────────────────────────

/**
 * $/M tokens. text-embedding-3-small $0.02, -3-large $0.13 (OpenAI pricing,
 * 2026-10-04). Google bills gemini-embedding-2 at $0.20 and no longer lists
 * text-embedding-004, so it is billed at $0.20. Mistral, Zhipu and Qwen are
 * UNVERIFIED here and billed at $0.20 — above every listed rate.
 */
const EMBEDDING_USD_PER_MTOK: Record<string, number> = {
  "openai:text-embedding-3-small": 0.02,
  "openai:text-embedding-3-large": 0.13,
  "google:text-embedding-004": 0.2,
};
export const EMBEDDING_FALLBACK_USD_PER_MTOK = 0.2;

export function embeddingCostMicroUsd(modelId: string, input: { tokens?: number | null; chars: number }): number {
  const rate = EMBEDDING_USD_PER_MTOK[modelId] ?? EMBEDDING_FALLBACK_USD_PER_MTOK;
  // chars/3 rather than /4: a floor that errs high when the provider is silent.
  const tokens = input.tokens != null && input.tokens > 0 ? input.tokens : Math.ceil(Math.max(0, input.chars) / 3);
  return Math.ceil(tokens * rate);
}

// ── OpenAI image tokens ────────────────────────────────────────────────────

/**
 * GPT Image models bill tokens, not images, and `quality: "auto"` may pick
 * "high" — four times the flat $0.04 the catalog assumed. The response's own
 * `usage` is the truth; this prices it. $/M (developers.openai.com/api/docs/
 * pricing, 2026-10-04): image in / image out —
 *   gpt-image-1 10/40 · gpt-image-1.5 8/32 · gpt-image-2(.5) 8/30 ·
 *   gpt-image-1-mini 2.5/8. Text input is $5/M ($2 for mini); an unknown GPT
 *   Image id is billed at gpt-image-1, the dearest.
 */
const OPENAI_IMAGE_RATES: Array<{ match: string; textIn: number; imageIn: number; out: number }> = [
  { match: "gpt-image-1-mini", textIn: 2, imageIn: 2.5, out: 8 },
  { match: "gpt-image-1.5", textIn: 5, imageIn: 8, out: 32 },
  { match: "gpt-image-2", textIn: 5, imageIn: 8, out: 30 },
  { match: "gpt-image-1", textIn: 5, imageIn: 10, out: 40 },
];

export interface OpenAIImageUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  input_tokens_details?: { text_tokens?: number | null; image_tokens?: number | null } | null;
}

/** Micro-USD for one OpenAI image response, or null when it carries no usage. */
export function openAIImageUsageCostMicroUsd(modelId: string, usage: OpenAIImageUsage | null | undefined): number | null {
  if (!usage || (usage.input_tokens == null && usage.output_tokens == null)) return null;
  const id = modelId.toLowerCase();
  const rate = OPENAI_IMAGE_RATES.find((r) => id.includes(r.match)) ?? OPENAI_IMAGE_RATES[OPENAI_IMAGE_RATES.length - 1];
  const input = Math.max(0, usage.input_tokens ?? 0);
  const imageIn = Math.max(0, usage.input_tokens_details?.image_tokens ?? 0);
  const textIn = Math.max(0, usage.input_tokens_details?.text_tokens ?? input - imageIn);
  const out = Math.max(0, usage.output_tokens ?? 0);
  return Math.ceil(textIn * rate.textIn + imageIn * rate.imageIn + out * rate.out);
}

// ── Unattributed (platform) utility spend ──────────────────────────────────

/**
 * The daily ceiling on utility spend with no account behind it — today only
 * the public UI-translation route. It has no session, so no plan budget
 * bounds it; this does. `PLATFORM_UNATTRIBUTED_DAILY_USD`, default $5.
 */
export function unattributedDailyCeilingMicroUsd(raw = process.env.PLATFORM_UNATTRIBUTED_DAILY_USD): number {
  const usd = Number(raw);
  return Math.round((Number.isFinite(usd) && usd >= 0 && raw != null && raw !== "" ? usd : 5) * 1_000_000);
}

/** Per-process day counter of unattributed spend. */
export function createUnattributedSpendMeter(opts: { ceilingMicroUsd: () => number; now?: () => number }) {
  const clock = opts.now ?? Date.now;
  let day = -1;
  let spent = 0;
  const roll = () => {
    const d = Math.floor(clock() / 86_400_000);
    if (d !== day) {
      day = d;
      spent = 0;
    }
  };
  return {
    allows(): boolean {
      roll();
      return spent < opts.ceilingMicroUsd();
    },
    add(microUsd: number): void {
      roll();
      if (Number.isFinite(microUsd) && microUsd > 0) spent += Math.round(microUsd);
    },
    spent(): number {
      roll();
      return spent;
    },
  };
}

// ── Pre-call admission ─────────────────────────────────────────────────────

export interface AdmissionInputs {
  budget: { allowed: boolean; remainingMicroUsd: number | null };
  windows?: { allowed: boolean; bound: string | null; remainingMicroUsd: number | null } | null;
  /** What this call is expected to cost. */
  estimateMicroUsd: number;
}

export type AdmissionVerdict =
  | { allowed: true }
  | { allowed: false; reason: "budget" | "window" | "estimate" };

/**
 * The one admission rule for a metered call: the month must have room, the
 * rolling windows must have room, and this call's estimate must fit in what
 * is left of the tighter of the two. A null remainder is an uncapped account.
 */
export function admissionVerdict(input: AdmissionInputs): AdmissionVerdict {
  if (!input.budget.allowed) return { allowed: false, reason: "budget" };
  if (input.windows && !input.windows.allowed && input.windows.bound !== null) return { allowed: false, reason: "window" };
  const remains = [input.budget.remainingMicroUsd, input.windows?.remainingMicroUsd ?? null].filter(
    (v): v is number => v != null
  );
  if (remains.length > 0 && Math.max(0, input.estimateMicroUsd) > Math.min(...remains)) {
    return { allowed: false, reason: "estimate" };
  }
  return { allowed: true };
}

// ── Output-token cap for proxied requests ──────────────────────────────────

/**
 * How many output tokens one request may ask for so that it cannot spend past
 * what is left: (remaining − the prompt's cost) ÷ the output rate. Never below
 * `floor` (a request that cannot write 1,024 tokens is useless, and the
 * overshoot that floor allows is bounded and small). Null = no cap.
 */
export function affordableOutputTokens(input: {
  remainingMicroUsd: number | null;
  promptChars: number;
  inputMicroUsdPerToken: number;
  outputMicroUsdPerToken: number;
  floor?: number;
}): number | null {
  if (input.remainingMicroUsd == null) return null;
  const floor = input.floor ?? 1_024;
  const promptCost = Math.ceil(Math.max(0, input.promptChars) / 4) * Math.max(0, input.inputMicroUsdPerToken);
  const left = input.remainingMicroUsd - promptCost;
  if (input.outputMicroUsdPerToken <= 0) return null;
  return Math.max(floor, Math.floor(left / input.outputMicroUsdPerToken));
}

// ── Media bill ─────────────────────────────────────────────────────────────

/**
 * What a media response is billed: the catalog's per-output price times the
 * outputs actually returned, or the provider's own usage-priced total when it
 * is higher. Never the lower of the two.
 */
export function mediaBillMicroUsd(input: {
  perOutputMicroUsd: number;
  outputs: number;
  providerCostMicroUsd?: number | null;
}): { perOutputMicroUsd: number; totalMicroUsd: number } {
  const outputs = Math.max(1, Math.floor(input.outputs || 0));
  const flat = Math.max(0, Math.round(input.perOutputMicroUsd)) * outputs;
  const provider = Math.max(0, Math.round(input.providerCostMicroUsd ?? 0));
  const total = Math.max(flat, provider);
  return { perOutputMicroUsd: Math.ceil(total / outputs), totalMicroUsd: Math.ceil(total / outputs) * outputs };
}
