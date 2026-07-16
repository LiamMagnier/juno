/**
 * Client mirror of the voice-relay wire protocol.
 * KEEP IN SYNC with relay/src/protocol.ts (source of truth) and
 * JunoApp Juno/Features/Voice/Realtime/VoiceRelayProtocol.swift.
 */

export type VoiceProviderId = "openai" | "gemini" | "qwen" | "minimax" | "mock";

export interface ProviderCapabilities {
  videoInput: boolean;
  screenInput?: boolean;
  trueS2S: boolean;
  needsClientTranscript: boolean;
  maxSessionSec: number;
}

/** Finalized existing-chat context sent once when voice mode starts. */
export interface VoiceHistoryEntry {
  role: "user" | "assistant";
  text: string;
}

export const VOICE_HISTORY_MAX_TURNS = 20;
export const VOICE_HISTORY_MAX_TURN_CHARS = 2_000;
export const VOICE_HISTORY_MAX_TOTAL_CHARS = 12_000;

export type VoiceClientMessage =
  | { type: "session.start"; provider: VoiceProviderId; history?: VoiceHistoryEntry[] }
  | { type: "session.switch"; provider: VoiceProviderId }
  | { type: "input.text"; text: string; turnId?: string; displayText?: string }
  | { type: "control.interrupt" }
  | { type: "video.frame"; jpegBase64: string }
  | { type: "ping" };

export type VoiceServerMessage =
  | { type: "session.ready"; provider: VoiceProviderId; capabilities: ProviderCapabilities }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean; turnId?: string }
  | { type: "turn"; speaker: "assistant"; phase: "start" | "end" }
  | { type: "interrupted" }
  /** estCostInUsd/estCostOutUsd split estCostUsd into the user's speech vs the
   *  model's; optional — a provider may report no usable token counts. */
  | {
      type: "usage";
      provider: VoiceProviderId;
      audioInSec: number;
      audioOutSec: number;
      estCostUsd: number;
      estCostInUsd?: number;
      estCostOutUsd?: number;
    }
  | { type: "session.closed"; reason: "session-limit" | "provider" | "client" | "error" }
  | { type: "error"; message: string }
  | { type: "pong" };

export const MIC_SAMPLE_RATE = 16000;
export const PLAYBACK_SAMPLE_RATE = 24000;

export const VOICE_PROVIDER_LABELS: Record<VoiceProviderId, string> = {
  openai: "OpenAI",
  gemini: "Gemini",
  qwen: "Qwen",
  minimax: "MiniMax",
  mock: "Mock (dev)",
};

/** Providers shown in the switcher (mock appears only in dev builds). */
export const VOICE_PROVIDERS: VoiceProviderId[] =
  process.env.NODE_ENV === "development"
    ? ["openai", "gemini", "qwen", "minimax", "mock"]
    : ["openai", "gemini", "qwen", "minimax"];
