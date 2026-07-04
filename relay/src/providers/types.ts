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

/** Events a provider session emits toward the relay session. */
export interface ProviderEvents {
  /** Model speech, PCM16LE mono at `rate` Hz (relay resamples to 24 kHz). */
  onAudio(pcm: Buffer, rate: number): void;
  onTranscript(t: TranscriptEntry): void;
  onTurn(phase: "start" | "end"): void;
  /** Model output cancelled (barge-in). Client playback must flush. */
  onInterrupted(): void;
  onUsage(u: { audioInSec?: number; audioOutSec?: number; extraCostUsd?: number }): void;
  onError(message: string): void;
  onClosed(reason: "session-limit" | "provider" | "error"): void;
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
  /** Approximate $/sec for cost estimation shown to the user. */
  pricing: { audioInPerSec: number; audioOutPerSec: number };
  available(): boolean;
  create(): VoiceProviderSession;
}

export function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured on the relay.`);
  return v;
}
