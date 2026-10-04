import { DEFAULT_VOICE_REASONING_EFFORT, VOICE_REASONING_EFFORTS, type VoiceProviderId } from "../protocol.js";
import { GeminiLiveSession } from "./gemini-live.js";
import { GEMINI_DEFAULT_REASONING_EFFORT, GEMINI_REASONING_EFFORTS } from "./gemini-delegate.js";
import { OpenAiVoiceSession } from "./openai-voice.js";
import { MinimaxComposedSession } from "./minimax-composed.js";
import { MockVoiceSession } from "./mock.js";
import { OpenAiShapedRealtimeSession, type RealtimeDialect } from "./openai-realtime.js";
import type { VoiceProviderFactory, VoiceSessionSeed } from "./types.js";
import { requiredEnv } from "./types.js";

/**
 * The previous generation, kept reachable rather than deleted: pin
 * RELAY_OPENAI_MODEL to a `gpt-realtime*` id and the openai provider speaks
 * this dialect again. GPT-Live-1 is a different protocol on a different URL,
 * so the model id is what chooses between them.
 */
const openaiDialect: RealtimeDialect = {
  provider: "openai",
  url: () => {
    const model = process.env.RELAY_OPENAI_MODEL || "gpt-realtime-2.1";
    return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
  },
  headers: () => ({ Authorization: `Bearer ${requiredEnv("OPENAI_API_KEY")}` }),
  inputRate: 24000,
  assistantHistoryContentType: "output_text",
  supportsVideo: true,
  sessionUpdate: (seed: VoiceSessionSeed) => ({
    // GA session shape: audio config nested under session.audio.
    type: "realtime",
    instructions: seed.instructions,
    audio: {
      input: {
        format: { type: "audio/pcm", rate: 24000 },
        turn_detection: { type: "server_vad", create_response: true, interrupt_response: true },
        transcription: { model: "gpt-realtime-whisper" },
      },
      output: { format: { type: "audio/pcm", rate: 24000 }, voice: seed.voice || "marin" },
    },
  }),
};

const qwenDialect: RealtimeDialect = {
  provider: "qwen",
  url: () => {
    const model = process.env.RELAY_QWEN_MODEL || "qwen3.5-omni-flash-realtime";
    const base = process.env.RELAY_QWEN_REALTIME_URL || "wss://dashscope-intl.aliyuncs.com/api-ws/v1/realtime";
    return `${base}?model=${encodeURIComponent(model)}`;
  },
  headers: () => ({
    Authorization: `Bearer ${requiredEnv("DASHSCOPE_API_KEY")}`,
    "OpenAI-Beta": "realtime=v1",
  }),
  inputRate: 16000,
  assistantHistoryContentType: "text",
  supportsVideo: true,
  sessionUpdate: (seed: VoiceSessionSeed) => ({
    // Beta dialect: flat session fields.
    modalities: ["text", "audio"],
    instructions: seed.instructions,
    voice: seed.voice || "Ethan",
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
    input_audio_transcription: { model: "gummy-realtime-v1" },
    turn_detection: { type: "semantic_vad" },
  }),
};

/**
 * The voices an agent may speak in, per provider.
 *
 * Only names the provider is known to accept: Gemini Live fails setup on a
 * voice it does not know (tests/gemini-setup-failure.test.ts), and a call that
 * does not start is a worse persona than the default voice. The OpenAI list is
 * the Realtime API's; GPT-Live keeps its own default (gpt-live.ts), since
 * its session config refuses what it does not recognise and its names are not
 * vetted here. Qwen and MiniMax are left out until theirs are — an agent there
 * speaks in the provider's default, as every call did before.
 */
export const AGENT_VOICES: Partial<Record<VoiceProviderId, readonly string[]>> = {
  openai: ["alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar"],
  gemini: ["Puck", "Charon", "Kore", "Fenrir", "Aoede", "Leda", "Orus", "Zephyr"],
};

/**
 * The voice an agent speaks in on this provider, from its slot. The same agent
 * always lands on the same voice, and a provider with no vetted list, or a call
 * with no agent, gets `undefined` — the provider's default.
 */
export function agentVoice(provider: VoiceProviderId, slot: number | null): string | undefined {
  const voices = AGENT_VOICES[provider];
  if (!voices?.length || slot === null || !Number.isSafeInteger(slot) || slot < 0) return undefined;
  return voices[slot % voices.length];
}

/** True while RELAY_OPENAI_MODEL pins the provider back to the Realtime API. */
function openaiUsesLegacyRealtime(): boolean {
  return (process.env.RELAY_OPENAI_MODEL || "").startsWith("gpt-realtime");
}

export const PROVIDERS: Record<VoiceProviderId, VoiceProviderFactory> = {
  openai: {
    id: "openai",
    capabilities: {
      videoInput: true,
      screenInput: false,
      trueS2S: true,
      needsClientTranscript: false,
      // GPT-Live-1 has no reasoning switch of its own: it always delegates to
      // GPT-6.1 Sol, which has no `none`. The choice the caller gets is how
      // hard that delegate reasons, as in ChatGPT and the API.
      thinkingChoice: false,
      reasoningEfforts: VOICE_REASONING_EFFORTS,
      defaultReasoningEffort: DEFAULT_VOICE_REASONING_EFFORT,
      maxSessionSec: 60 * 60,
    },
    // GPT-Live-1 publishes $0.05 per minute for the VOICE LAYER, with the
    // backend delegation model billed separately — so this estimate covers the
    // voice layer alone and reads low on a session that delegates heavily. It
    // is charged against input seconds because the mic runs for the whole call
    // while output audio is intermittent: input duration is the closest thing
    // the relay measures to wall-clock conversation. The legacy Realtime
    // dialect carries its own token table, which takes precedence when pinned.
    pricing: {
      audioInPerSec: 0.05 / 60,
      audioOutPerSec: 0,
    },
    available: () => !!process.env.OPENAI_API_KEY,
    create: ({ effort }) =>
      openaiUsesLegacyRealtime()
        ? new OpenAiShapedRealtimeSession(openaiDialect)
        : new OpenAiVoiceSession(openaiDialect, { effort }),
  },
  gemini: {
    id: "gemini",
    // 15-min audio cap is per provider session; resumption stretches the
    // connection, so surface the documented ceiling to the client.
    capabilities: {
      videoInput: true,
      screenInput: true,
      trueS2S: true,
      needsClientTranscript: false,
      // The same dial as OpenAI's, since a rung picks both the Live model and
      // its Gemini 3.8 Flash delegate's level (gemini-delegate.ts). An older
      // client's `thinking: true` still lands on Medium.
      thinkingChoice: false,
      reasoningEfforts: GEMINI_REASONING_EFFORTS,
      defaultReasoningEffort: GEMINI_DEFAULT_REASONING_EFFORT,
      maxSessionSec: 15 * 60,
    },
    // Both 3.8 Live and 3.8 Live Extended Thinking publish these per-minute
    // audio rates. Extended Thinking bills its reasoning inside output tokens,
    // so its real cost per minute of conversation runs several times above what
    // a duration estimate can show.
    pricing: { audioInPerSec: 0.005 / 60, audioOutPerSec: 0.018 / 60 },
    available: () => !!(process.env.GEMINI_LIVE_API_KEY || process.env.GOOGLE_API_KEY),
    create: ({ effort, thinking }) => new GeminiLiveSession(effort ? { effort } : { thinking }),
  },
  qwen: {
    id: "qwen",
    capabilities: {
      videoInput: true,
      screenInput: true,
      trueS2S: true,
      needsClientTranscript: false,
      thinkingChoice: false,
      maxSessionSec: 120 * 60,
    },
    pricing: { audioInPerSec: 0.00189 / 60, audioOutPerSec: 0.0133 / 60 },
    available: () => !!process.env.DASHSCOPE_API_KEY,
    create: () => new OpenAiShapedRealtimeSession(qwenDialect),
  },
  minimax: {
    id: "minimax",
    capabilities: {
      videoInput: false,
      screenInput: false,
      trueS2S: false,
      needsClientTranscript: true,
      thinkingChoice: false,
      maxSessionSec: 120 * 60,
    },
    // Cost is dominated by TTS characters; reported via extraCostUsd instead.
    pricing: { audioInPerSec: 0, audioOutPerSec: 0 },
    available: () => !!process.env.MINIMAX_API_KEY,
    create: () => new MinimaxComposedSession(),
  },
  mock: {
    id: "mock",
    capabilities: {
      videoInput: true,
      screenInput: true,
      trueS2S: true,
      needsClientTranscript: false,
      thinkingChoice: false,
      maxSessionSec: 60 * 60,
    },
    pricing: { audioInPerSec: 0, audioOutPerSec: 0 },
    available: () => process.env.RELAY_ENABLE_MOCK === "1",
    create: () => new MockVoiceSession(),
  },
};
