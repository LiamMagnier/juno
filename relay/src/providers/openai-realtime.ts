import WebSocket from "ws";
import { resamplePcm16 } from "../audio.js";
import type { VoiceProviderId } from "../protocol.js";
import type { ProviderEvents, TokenUsage, VoiceProviderSession, VoiceSessionSeed } from "./types.js";

/**
 * Adapter for the OpenAI Realtime event vocabulary, used by TWO providers:
 *  - OpenAI (GA API, wss://api.openai.com/v1/realtime, 24 kHz audio)
 *  - Qwen Omni Realtime on DashScope (OpenAI-Realtime-compatible beta dialect,
 *    wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime, 16 kHz in / 24 kHz out)
 *
 * The two differ in the session.update payload shape (GA nests audio config
 * under session.audio; the beta dialect uses flat input_audio_format fields)
 * and in some event names (GA "output_audio", beta "audio") — we send the
 * dialect-appropriate config and accept BOTH event name families.
 */
export interface RealtimeDialect {
  provider: VoiceProviderId;
  url(): string;
  headers(): Record<string, string>;
  /** Sample rate the provider expects for input audio. */
  inputRate: number;
  /** Assistant history uses output_text in OpenAI's GA schema, while Qwen's
   * OpenAI-compatible beta dialect still expects the legacy text item. */
  assistantHistoryContentType: "output_text" | "text";
  sessionUpdate(seed: VoiceSessionSeed): Record<string, unknown>;
  supportsVideo: boolean;
}

interface RealtimeUsagePayload {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: {
    audio_tokens?: number;
    text_tokens?: number;
    cached_tokens?: number;
    cached_tokens_details?: { audio_tokens?: number; text_tokens?: number };
  };
  output_token_details?: { audio_tokens?: number; text_tokens?: number };
}

/**
 * Per-response billed tokens. `cached_tokens` is a SUBSET of `input_tokens`
 * (docs/guides/realtime-costs), so the cached counts are subtracted out to
 * leave the portion billed at the full rate.
 *
 * The detail objects are documented but not always sent
 * (github.com/openai/openai-agents-js/issues/538), and the two sides are
 * omitted INDEPENDENTLY — the response.done reference currently documents
 * input_token_details without an output_token_details counterpart. So each side
 * falls back on its own: gating both on the absence of both would price the
 * present side from details and the missing side at $0, discarding the measured
 * total sitting in the same payload.
 */
function readTokenUsage(response: unknown): TokenUsage | undefined {
  const usage = (response as { usage?: RealtimeUsagePayload } | undefined)?.usage;
  if (!usage) return undefined;
  const input = readInputTokens(usage);
  const output = readOutputTokens(usage);
  return input || output ? { input, output } : undefined;
}

/** Detail object absent, or present but carrying no counts, falls back to the
 *  measured total attributed to audio — the dominant and dearest modality in a
 *  speech session, keeping the estimate an upper bound rather than a silent
 *  undercount. No total either means unmeasured, which must stay distinct. */
function readInputTokens(usage: RealtimeUsagePayload): TokenUsage["input"] {
  const detail = usage.input_token_details;
  const audio = detail?.audio_tokens ?? 0;
  const text = detail?.text_tokens ?? 0;
  if (audio || text) {
    // cached_tokens_details splits the cache by modality; when only the
    // cached_tokens total is present, charge it against audio for the same reason.
    const audioCached = Math.min(audio, detail?.cached_tokens_details?.audio_tokens ?? detail?.cached_tokens ?? 0);
    const textCached = Math.min(text, detail?.cached_tokens_details?.text_tokens ?? 0);
    return { audio: audio - audioCached, audioCached, text: text - textCached, textCached };
  }
  const total = usage.input_tokens ?? 0;
  return total ? { audio: total, audioCached: 0, text: 0, textCached: 0 } : undefined;
}

function readOutputTokens(usage: RealtimeUsagePayload): TokenUsage["output"] {
  const detail = usage.output_token_details;
  const audio = detail?.audio_tokens ?? 0;
  const text = detail?.text_tokens ?? 0;
  if (audio || text) return { audio, text };
  const total = usage.output_tokens ?? 0;
  return total ? { audio: total, text: 0 } : undefined;
}

export class OpenAiShapedRealtimeSession implements VoiceProviderSession {
  readonly provider: VoiceProviderId;
  private ws: WebSocket | null = null;
  private events: ProviderEvents | null = null;
  private closedByUs = false;
  private assistantSpeaking = false;

  constructor(private dialect: RealtimeDialect) {
    this.provider = dialect.provider;
  }

  async connect(seed: VoiceSessionSeed, events: ProviderEvents): Promise<void> {
    this.events = events;
    const ws = new WebSocket(this.dialect.url(), { headers: this.dialect.headers() });
    this.ws = ws;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.provider} realtime connect timed out`)), 15_000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    ws.on("message", (data) => this.handleMessage(data));
    ws.on("close", () => {
      if (!this.closedByUs) this.events?.onClosed("provider");
    });
    ws.on("error", (err) => this.events?.onError(`${this.provider}: ${err.message}`));

    this.send({ type: "session.update", session: this.dialect.sessionUpdate(seed) });

    // Seed prior turns so a provider switch keeps the conversation context.
    for (const turn of seed.transcript) {
      if (!turn.text.trim()) continue;
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: turn.role,
          content: [
            {
              type: turn.role === "user" ? "input_text" : this.dialect.assistantHistoryContentType,
              text: turn.text,
            },
          ],
        },
      });
    }
  }

  sendAudio(pcm16k: Buffer): void {
    const pcm = resamplePcm16(pcm16k, 16000, this.dialect.inputRate);
    this.send({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
  }

  sendText(text: string): void {
    // S2S providers normally hear the audio; accept text anyway (mute + type).
    this.send({
      type: "conversation.item.create",
      item: { type: "message", role: "user", content: [{ type: "input_text", text }] },
    });
    this.send({ type: "response.create" });
  }

  sendVideoFrame(jpeg: Buffer): void {
    if (!this.dialect.supportsVideo) return;
    if (this.provider === "openai") {
      // OpenAI Realtime accepts image input as a normal user conversation item.
      // A following text/audio turn asks the model to respond to the image.
      this.send({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "user",
          content: [{ type: "input_image", image_url: `data:image/jpeg;base64,${jpeg.toString("base64")}`, detail: "auto" }],
        },
      });
      return;
    }
    // Qwen's realtime dialect accepts appended video frames alongside audio.
    this.send({ type: "input_image_buffer.append", image: jpeg.toString("base64") });
  }

  interrupt(): void {
    this.send({ type: "response.cancel" });
    if (this.assistantSpeaking) {
      this.assistantSpeaking = false;
      this.events?.onTurn("end");
    }
    this.events?.onInterrupted();
  }

  async close(): Promise<void> {
    this.closedByUs = true;
    this.ws?.close();
    this.ws = null;
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  private handleMessage(data: WebSocket.RawData): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    const type = String(msg.type ?? "");
    const ev = this.events;
    if (!ev) return;

    switch (type) {
      // GA + beta names for model audio deltas.
      case "response.output_audio.delta":
      case "response.audio.delta": {
        const b64 = (msg.delta ?? msg.audio) as string | undefined;
        if (typeof b64 === "string" && b64.length) {
          if (!this.assistantSpeaking) {
            this.assistantSpeaking = true;
            ev.onTurn("start");
          }
          const pcm = Buffer.from(b64, "base64");
          ev.onAudio(pcm, 24000);
          ev.onUsage({ audioOutSec: pcm.length / 2 / 24000 });
        }
        return;
      }
      case "response.output_audio_transcript.delta":
      case "response.audio_transcript.delta":
        if (typeof msg.delta === "string") ev.onTranscript({ role: "assistant", text: msg.delta, final: false });
        return;
      case "response.output_audio_transcript.done":
      case "response.audio_transcript.done":
        if (typeof msg.transcript === "string") ev.onTranscript({ role: "assistant", text: msg.transcript, final: true });
        return;
      case "conversation.item.input_audio_transcription.delta":
        if (typeof msg.delta === "string") ev.onTranscript({ role: "user", text: msg.delta, final: false });
        return;
      case "conversation.item.input_audio_transcription.completed":
        if (typeof msg.transcript === "string") ev.onTranscript({ role: "user", text: msg.transcript, final: true });
        return;
      case "input_audio_buffer.speech_started":
        // Barge-in: the provider auto-cancels; tell the client to flush now.
        if (this.assistantSpeaking) {
          this.assistantSpeaking = false;
          ev.onTurn("end");
          ev.onInterrupted();
        }
        return;
      case "response.done": {
        if (this.assistantSpeaking) {
          this.assistantSpeaking = false;
          ev.onTurn("end");
        }
        if (this.provider !== "openai") return;
        const tokens = readTokenUsage(msg.response);
        if (!tokens) return;
        // OpenAI audio input ≈ 1 token / 100 ms. Seconds are display-only here;
        // the cost comes from the token counts above. Omit them when the input
        // side went unmeasured rather than reporting a confident 0s.
        const audioIn = tokens.input ? tokens.input.audio + tokens.input.audioCached : undefined;
        ev.onUsage({ tokens, audioInSec: audioIn === undefined ? undefined : audioIn / 10 });
        return;
      }
      case "error": {
        const detail = (msg.error as { message?: string } | undefined)?.message ?? JSON.stringify(msg).slice(0, 200);
        ev.onError(`${this.provider}: ${detail}`);
        return;
      }
      default:
        return; // session.created / rate_limits / deltas we don't surface
    }
  }
}
