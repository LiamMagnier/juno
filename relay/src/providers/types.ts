import type { ProviderCapabilities, VoiceDelegate, VoiceProviderId, VoiceReasoningEffort } from "../protocol.js";

export interface TranscriptEntry {
  role: "user" | "assistant";
  text: string;
  final: boolean;
  /** Bounded document context supplied with a composed user turn. */
  context?: string;
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
  /**
   * The caller began speaking, as reported by the provider's voice activity
   * detector. This is the only exact boundary for a spoken turn: input
   * transcription resolves later and often after the model has already begun
   * answering, so a client that waits for text has to guess where the turn
   * belongs. Every provider detects speech onset; forwarding it lets the
   * client anchor the turn at the moment it started.
   */
  onUserSpeechStart(): void;
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

/**
 * What a provider actually gave, once connected — which is not always what was
 * asked for. A provider that answered on a fallback path reports the state the
 * caller really got, plus a note the relay can put on session.ready.
 */
export interface SessionEstablished {
  thinking: boolean;
  /** Non-fatal; shown to the caller without ending the call. */
  notice?: string;
  /**
   * The model actually serving this call. Env pins it, thinking switches it,
   * and a fallback can change it again — so the only honest source is the
   * session that connected, and the UI names what it reports rather than
   * what was asked for.
   */
  model?: string;
  /**
   * The backend model this session hands harder turns to, as configured on
   * the session that actually connected. Absent where nothing is delegated —
   * including an OpenAI call that fell back to the Realtime protocol.
   */
  delegate?: VoiceDelegate;
  /** The rung of the provider's thinking dial this session runs at. */
  effort?: VoiceReasoningEffort;
}

export interface VoiceProviderSession {
  readonly provider: VoiceProviderId;
  connect(seed: VoiceSessionSeed, events: ProviderEvents): Promise<void>;
  /** Omit where what was asked for is always what was given. */
  established?(): SessionEstablished;
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

/** What the caller asked for when opening or switching to this provider. */
export interface VoiceProviderOptions {
  /** Prefer the reasoning variant. Ignored where `thinkingChoice` is false. */
  thinking: boolean;
  /** How hard the delegated model reasons. Already validated against the
   *  provider's `reasoningEfforts`; absent for a provider without them. */
  effort?: VoiceReasoningEffort;
}

export interface VoiceProviderFactory {
  id: VoiceProviderId;
  capabilities: ProviderCapabilities;
  /** Approximate cost estimation shown to the user. `tokens`, where the
   * provider reports measured counts, takes precedence and makes the $/sec
   * rates display-only — pricing both would bill the same audio twice. */
  pricing: { audioInPerSec: number; audioOutPerSec: number; tokens?: TokenRates };
  available(): boolean;
  create(options: VoiceProviderOptions): VoiceProviderSession;
}

export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured on the relay.`);
  return v;
}
