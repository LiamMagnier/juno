/**
 * Client mirror of the voice-relay wire protocol.
 * KEEP IN SYNC with relay/src/protocol.ts (source of truth) and
 * JunoApp Juno/Features/Voice/Realtime/VoiceRelayProtocol.swift.
 */

export type VoiceProviderId = "openai" | "gemini" | "qwen" | "minimax" | "mock";

/**
 * How hard a provider's delegated model reasons (relay/src/protocol.ts).
 * GPT-Live-1 delegates to GPT-6.1 Sol, which accepts these rungs and not
 * `none` or `minimal`.
 */
export type VoiceReasoningEffort = "low" | "medium" | "high" | "xhigh";
export const VOICE_REASONING_EFFORTS: readonly VoiceReasoningEffort[] = ["low", "medium", "high", "xhigh"];
export const DEFAULT_VOICE_REASONING_EFFORT: VoiceReasoningEffort = "high";

/** The rung names, spelled as the chat composer's thinking slider spells them. */
export const VOICE_REASONING_EFFORT_LABELS: Record<VoiceReasoningEffort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
};

export function parseVoiceReasoningEffort(value: unknown): VoiceReasoningEffort | null {
  return typeof value === "string" && (VOICE_REASONING_EFFORTS as readonly string[]).includes(value)
    ? (value as VoiceReasoningEffort)
    : null;
}

/** The backend model a delegating voice session hands harder turns to. */
export interface VoiceDelegate {
  model: string;
  effort: VoiceReasoningEffort;
  webSearch: boolean;
}

export interface ProviderCapabilities {
  videoInput: boolean;
  screenInput?: boolean;
  trueS2S: boolean;
  needsClientTranscript: boolean;
  /** The caller may choose whether this provider reasons before answering. */
  thinkingChoice: boolean;
  /** Where present, the caller may choose the delegated model's effort. */
  reasoningEfforts?: readonly VoiceReasoningEffort[];
  /** The rung a call gets when none is asked for — the dial's reset. */
  defaultReasoningEffort?: VoiceReasoningEffort;
  maxSessionSec: number;
}

/** Finalized existing-chat context sent once when voice mode starts. */
export interface VoiceHistoryEntry {
  role: "user" | "assistant";
  text: string;
  context?: string;
}

export const VOICE_HISTORY_MAX_TURNS = 20;
export const VOICE_HISTORY_MAX_TURN_CHARS = 2_000;
export const VOICE_HISTORY_MAX_TOTAL_CHARS = 12_000;

export type VoiceClientMessage =
  | {
      type: "session.start";
      provider: VoiceProviderId;
      history?: VoiceHistoryEntry[];
      thinking?: boolean;
      effort?: VoiceReasoningEffort;
    }
  | { type: "session.switch"; provider: VoiceProviderId; thinking?: boolean; effort?: VoiceReasoningEffort }
  | {
      type: "input.text";
      text: string;
      turnId?: string;
      displayText?: string;
      context?: string;
      attachmentIds?: string[];
    }
  | { type: "control.interrupt" }
  | { type: "video.frame"; jpegBase64: string }
  | { type: "ping" };

export type VoiceServerMessage =
  | {
      type: "session.ready";
      provider: VoiceProviderId;
      capabilities: ProviderCapabilities;
      thinking: boolean;
      /**
       * True when the call was given what Juno remembers about the caller
       * (relay-side; the memory itself never reaches the client). Swift's
       * decoder ignores the key, like `thinking`, until the native apps ask
       * for memory themselves.
       */
      memory?: boolean;
      /**
       * Present only for a call in an agent's thread: true when the call is
       * that agent (the relay was given its persona), false when it could not
       * be had and Juno answers. The persona itself never reaches the client.
       */
      persona?: boolean;
      /** The model actually serving the call, as the provider reports it. */
      model?: string;
      /** Present when the call hands harder turns to a backend model. */
      delegate?: VoiceDelegate;
      /** The rung of the provider's thinking dial the call runs at. */
      effort?: VoiceReasoningEffort;
      /** Non-fatal note about how the session came up; does not end the call. */
      notice?: string;
    }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean; turnId?: string }
  | { type: "turn"; speaker: "assistant" | "user"; phase: "start" | "end" }
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

/**
 * The provider a call opens on when the caller has not picked one: Gemini
 * Live. A pick in the switcher still wins for the rest of that call, and a
 * provider the relay reports as unavailable still falls back down
 * `VOICE_PROVIDERS`. The native apps pin the same default
 * (`JunoVoiceProvider.productionDefault`).
 */
export const DEFAULT_VOICE_PROVIDER: VoiceProviderId = "gemini";

/** Providers shown in the switcher (mock appears only in dev builds). */
export const VOICE_PROVIDERS: VoiceProviderId[] =
  process.env.NODE_ENV === "development"
    ? ["openai", "gemini", "qwen", "minimax", "mock"]
    : ["openai", "gemini", "qwen", "minimax"];

/**
 * The model each provider runs by default, by name. Shown on the provider
 * rows before a call is up; once it is, the relay's own report (`model` on
 * session.ready) is what the active row names, through `voiceModelLabel`.
 */
export const VOICE_PROVIDER_MODELS: Record<VoiceProviderId, string> = {
  openai: "gpt-live-1",
  gemini: "gemini-3.8-live",
  qwen: "qwen3.5-omni-flash-realtime",
  minimax: "MiniMax-M2.7-highspeed",
  mock: "mock",
};

/** The delegate GPT-Live-1 hands harder turns to (relay `GPT_LIVE_DELEGATE_MODEL`). */
export const VOICE_OPENAI_DELEGATE_MODEL = "gpt-6.1-sol";
/** The delegate both Gemini Live models hand harder turns to (relay `GEMINI_DELEGATE_MODEL`):
 *  thinkingLevel low under 3.8 Live, high under Extended Thinking. */
export const VOICE_GEMINI_DELEGATE_MODEL = "gemini-3.8-flash";

const VOICE_MODEL_LABELS: Record<string, string> = {
  "gpt-live-1": "GPT-Live 1",
  "gpt-6.1-sol": "GPT-6.1 Sol",
  "gpt-6-sol": "GPT-6 Sol",
  "gpt-6-luna": "GPT-6 Luna",
  "gpt-5.6-luna": "GPT-5.6 Luna",
  "gpt-realtime-2.1": "GPT-Realtime 2.1",
  "gemini-3.8-live": "Gemini 3.8 Live",
  "gemini-3.8-flash": "Gemini 3.8 Flash",
  // Google's long name, shortened as the owner says it.
  "gemini-3.8-live-extended-thinking": "Gemini 3.8 Live Thinking",
  "qwen3.5-omni-flash-realtime": "Qwen3.5 Omni Flash",
  "MiniMax-M2.7-highspeed": "MiniMax M2.7",
  mock: "Mock",
};

/**
 * A model id as a person reads it. Known ids get their published names; an
 * unknown one (an env pin, a future id) is shown as itself rather than
 * guessed at.
 */
export function voiceModelLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  return VOICE_MODEL_LABELS[id] ?? id;
}

/**
 * What one rung of a provider's thinking dial runs: the voice model, and the
 * model it hands harder questions to at what level. Mirrors the relay
 * (gpt-live.ts; gemini-delegate.ts `geminiVoicePlan`), so the dial can say
 * what a rung means before the call has come up on it.
 */
export function voiceEffortPlan(
  provider: VoiceProviderId,
  effort: VoiceReasoningEffort
): { voiceModel: string; delegateModel: string; delegateEffort: VoiceReasoningEffort } | null {
  if (provider === "openai") {
    return { voiceModel: VOICE_PROVIDER_MODELS.openai, delegateModel: VOICE_OPENAI_DELEGATE_MODEL, delegateEffort: effort };
  }
  if (provider === "gemini") {
    return effort === "low"
      ? { voiceModel: "gemini-3.8-live", delegateModel: VOICE_GEMINI_DELEGATE_MODEL, delegateEffort: "low" }
      : {
          voiceModel: "gemini-3.8-live-extended-thinking",
          delegateModel: VOICE_GEMINI_DELEGATE_MODEL,
          delegateEffort: effort === "medium" ? "medium" : "high",
        };
  }
  return null;
}
