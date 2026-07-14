import type { VoiceProviderId } from "../protocol.js";
import { GeminiLiveSession } from "./gemini-live.js";
import { MinimaxComposedSession } from "./minimax-composed.js";
import { MockVoiceSession } from "./mock.js";
import { OpenAiShapedRealtimeSession, type RealtimeDialect } from "./openai-realtime.js";
import type { VoiceProviderFactory, VoiceSessionSeed } from "./types.js";
import { requiredEnv } from "./types.js";

const openaiDialect: RealtimeDialect = {
  provider: "openai",
  url: () => {
    // gpt-realtime-2.1 (2026-07-06): better recognition/noise handling and
    // optional reasoning in speech-to-speech; same audio pricing as 2.
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

export const PROVIDERS: Record<VoiceProviderId, VoiceProviderFactory> = {
  openai: {
    id: "openai",
    capabilities: { videoInput: true, screenInput: false, trueS2S: true, needsClientTranscript: false, maxSessionSec: 60 * 60 },
    // gpt-realtime-2.1: audio in $32/M @600 tok/min, out $64/M @1200 tok/min.
    pricing: { audioInPerSec: 0.0192 / 60, audioOutPerSec: 0.0768 / 60 },
    available: () => !!process.env.OPENAI_API_KEY,
    create: () => new OpenAiShapedRealtimeSession(openaiDialect),
  },
  gemini: {
    id: "gemini",
    // 15-min audio cap is per provider session; resumption stretches the
    // connection, so surface the documented ceiling to the client.
    capabilities: { videoInput: true, screenInput: true, trueS2S: true, needsClientTranscript: false, maxSessionSec: 15 * 60 },
    pricing: { audioInPerSec: 0.005 / 60, audioOutPerSec: 0.018 / 60 },
    available: () => !!(process.env.GEMINI_LIVE_API_KEY || process.env.GOOGLE_API_KEY),
    create: () => new GeminiLiveSession(),
  },
  qwen: {
    id: "qwen",
    capabilities: { videoInput: true, screenInput: true, trueS2S: true, needsClientTranscript: false, maxSessionSec: 120 * 60 },
    pricing: { audioInPerSec: 0.00189 / 60, audioOutPerSec: 0.0133 / 60 },
    available: () => !!process.env.DASHSCOPE_API_KEY,
    create: () => new OpenAiShapedRealtimeSession(qwenDialect),
  },
  minimax: {
    id: "minimax",
    capabilities: { videoInput: false, screenInput: false, trueS2S: false, needsClientTranscript: true, maxSessionSec: 120 * 60 },
    // Cost is dominated by TTS characters; reported via extraCostUsd instead.
    pricing: { audioInPerSec: 0, audioOutPerSec: 0 },
    available: () => !!process.env.MINIMAX_API_KEY,
    create: () => new MinimaxComposedSession(),
  },
  mock: {
    id: "mock",
    capabilities: { videoInput: true, screenInput: true, trueS2S: true, needsClientTranscript: false, maxSessionSec: 60 * 60 },
    pricing: { audioInPerSec: 0, audioOutPerSec: 0 },
    available: () => process.env.RELAY_ENABLE_MOCK === "1",
    create: () => new MockVoiceSession(),
  },
};
