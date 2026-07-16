import type { ProviderCapabilities, VoiceProviderId } from "../protocol.js";

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  final: boolean;
}

export interface VoiceSessionSeed {
  /** System prompt. Server-side only — never sent to clients. */
  instructions: string;
  /** Prior finalized turns, oldest first, used when switching providers. */
  transcript: TranscriptEntry[];
  voice?: string;
}

/**
 * Measured token counts from ONE provider usage report, split by modality
 * because audio tokens cost ~8x text. Realtime re-sends the whole conversation
 * on every response, so each report is an additive increment of what was billed
 * for that response, not a running session total — callers accumulate them.
 * Cached counts are reported separately from fresh ones here; a provider that
 * reports caches as a subset of the total must subtract before emitting.
 *
 * `input` and `output` are INDEPENDENTLY optional because a report can carry
 * one side and not the other. An absent side means unmeasured, never zero:
 * pricing it as zero silently drops a whole modality, and output audio is the
 * dearest component of a realtime session.
 */
export interface TokenUsage {
  /** `audio`/`text` are billed at the full rate (cached portion removed). */
  input?: { audio: number; audioCached: number; text: number; textCached: number };
  output?: { audio: number; text: number };
}

/** Events a provider session emits toward the relay session. */
export interface ProviderEvents {
  /** Model speech, PCM16LE mono at `rate` Hz (relay resamples to 24 kHz). */
  onAudio(pcm: Buffer, rate: number): void;
  onTranscript(t: TranscriptEntry): void;
  onTurn(phase: "start" | "end"): void;
  /** Model output cancelled (barge-in). Client playback must flush. */
  onInterrupted(): void;
  /** `audioInSec`/`audioOutSec` are durations. They price the session only for
   * providers with no `pricing.tokens` table; where tokens are reported the
   * seconds are display-only and `tokens` carries the cost. */
  onUsage(u: { audioInSec?: number; audioOutSec?: number; tokens?: TokenUsage; extraCostUsd?: number }): void;
  onError(message: string): void;
  onClosed(reason: "session-limit" | "provider" | "error"): void;
}

/** USD per 1,000,000 tokens, per modality. */
export interface TokenRates {
  audioIn: number;
  audioInCached: number;
  textIn: number;
  textInCached: number;
  audioOut: number;
  textOut: number;
}

export interface VoiceProviderSession {
  readonly provider: VoiceProviderId;
  connect(seed: VoiceSessionSeed, events: ProviderEvents): Promise<void>;
  /** Mic audio, PCM16LE mono 16 kHz. No-op for non-S2S providers. */
  sendAudio(pcm16k: Buffer): void;
  /** Final client-side transcript utterance (needsClientTranscript providers). */
  sendText(text: string): void;
  /** One JPEG frame (videoInput providers). */
  sendVideoFrame(jpeg: Buffer): void;
  /** Barge-in: cancel the current model turn. */
  interrupt(): void;
  close(): Promise<void>;
}

export interface VoiceProviderFactory {
  id: VoiceProviderId;
  capabilities: ProviderCapabilities;
  /** Approximate cost estimation shown to the user. `tokens`, where the
   * provider reports measured counts, takes precedence and makes the $/sec
   * rates display-only — pricing both would bill the same audio twice. */
  pricing: { audioInPerSec: number; audioOutPerSec: number; tokens?: TokenRates };
  available(): boolean;
  create(): VoiceProviderSession;
}

export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured on the relay.`);
  return v;
}
