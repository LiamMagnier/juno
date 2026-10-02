/*
 * Every gallery state is a URL (?state=), every clip a script (?play=). A
 * scene says, at any scene time, what the call is doing (the fields the
 * realtime hook would report) and how loud each voice is. The product reads
 * the same two things from the microphone and the reply's audio.
 */

import { phrased, room, spoken } from "./signal";

export const STATES = [
  "lab",
  "idle",
  "connecting",
  "listening",
  "thinking",
  "answering",
  "muted",
  "interrupted",
  "approval",
  "reconnecting",
  "error",
  "ended",
  "dictation",
] as const;
export type GlowState = (typeof STATES)[number];

export const PLAYS = ["flow", "interrupt", "mute", "dictation"] as const;
export type GlowPlay = (typeof PLAYS)[number];

export type Transport = "idle" | "connecting" | "reconnecting" | "live" | "ended" | "error";

/** What the realtime hook reports at a moment. `null`: no call (the composer at rest). */
export interface CallSnapshot {
  status: Transport;
  muted: boolean;
  userSpeaking: boolean;
  awaitingResponse: boolean;
  assistantSpeaking: boolean;
  error: string | null;
}

/** Dictation's two states: listening, then transcribing; `closing` as it leaves. */
export interface DictationSnapshot {
  transcribing: boolean;
  closing: boolean;
}

export interface Scene {
  call: (ms: number) => CallSnapshot | null;
  dictation?: (ms: number) => DictationSnapshot;
  you: (ms: number) => number;
  alevr: (ms: number) => number;
  /** The still: a moment that shows the state carrying a voice, not a pause. */
  stillAt: number;
  /** For clips: when the script ends (the clip loops after). */
  endsAt?: number;
  approval?: boolean;
}

const LIVE: CallSnapshot = {
  status: "live",
  muted: false,
  userSpeaking: false,
  awaitingResponse: false,
  assistantSpeaking: false,
  error: null,
};

const at = (over: Partial<CallSnapshot>): CallSnapshot => ({ ...LIVE, ...over });
const silent = () => 0;

/** The hook's own speech floor (lib/voice-phase.ts SPEECH_FLOOR) decides "you're speaking". */
const speaking = (level: number) => level > 0.08;

export const SCENES: Record<Exclude<GlowState, "lab">, Scene> = {
  idle: { call: () => null, you: silent, alevr: silent, stillAt: 600 },
  connecting: { call: () => at({ status: "connecting" }), you: room, alevr: silent, stillAt: 1200 },
  listening: {
    call: (ms) => at({ userSpeaking: speaking(phrased(ms, "you", 300)) }),
    you: (ms) => phrased(ms, "you", 300) || room(ms),
    alevr: silent,
    stillAt: 1930,
  },
  thinking: {
    call: () => at({ awaitingResponse: true }),
    you: room,
    alevr: silent,
    // Second pass, mid-travel, with the first one fading at Alevr's end.
    stillAt: 1600 + 360,
  },
  answering: {
    call: () => at({ assistantSpeaking: true }),
    you: room,
    alevr: (ms) => phrased(ms, "alevr", 200, 2600, 500),
    stillAt: 2070,
  },
  muted: { call: () => at({ muted: true }), you: (ms) => phrased(ms, "you", 300), alevr: silent, stillAt: 1500 },
  interrupted: {
    // Alevr is answering; you start talking at 1.5 s; the hook hears a barge-in
    // and flushes the reply 150 ms later; the floor is yours from 1.7 s.
    call: (ms) => (ms < 1700 ? at({ assistantSpeaking: true, userSpeaking: ms >= 1500 }) : at({ userSpeaking: speaking(spoken(ms, "you", 1500, 3600)) })),
    you: (ms) => spoken(ms, "you", 1500, 3600) || room(ms),
    alevr: (ms) => spoken(ms, "alevr", 0, 1650),
    stillAt: 1690,
  },
  approval: { call: () => at({}), you: room, alevr: silent, stillAt: 1200, approval: true },
  reconnecting: { call: () => at({ status: "reconnecting" }), you: room, alevr: silent, stillAt: 1200 },
  error: {
    call: () => at({ status: "error", error: "Connection to the voice relay failed." }),
    you: silent,
    alevr: silent,
    stillAt: 1200,
  },
  ended: { call: () => at({ status: "ended" }), you: silent, alevr: silent, stillAt: 1200 },
  dictation: {
    call: () => null,
    dictation: () => ({ transcribing: false, closing: false }),
    you: (ms) => phrased(ms, "you", 300) || room(ms),
    alevr: silent,
    stillAt: 1930,
  },
};

/* ——————————————————————————————— clips ——————————————————————————————— */

export const PLAY_SCENES: Record<GlowPlay, Scene> = {
  // Listening → you speak → thinking (two handoff passes) → Alevr answers → listening.
  flow: {
    call: (ms) => {
      if (ms < 2900) return at({ userSpeaking: speaking(spoken(ms, "you", 400, 2800)) });
      if (ms < 4900) return at({ awaitingResponse: true });
      if (ms < 8300) return at({ assistantSpeaking: true });
      return at({});
    },
    you: (ms) => spoken(ms, "you", 400, 2800) || room(ms),
    alevr: (ms) => spoken(ms, "alevr", 4900, 6500) || spoken(ms, "alevr", 6900, 8250),
    stillAt: 1800,
    endsAt: 9400,
  },
  // Alevr answering; you talk over it; the floor passes to you.
  interrupt: {
    call: (ms) => {
      if (ms < 2100) return at({ assistantSpeaking: true, userSpeaking: ms >= 1900 });
      if (ms < 4300) return at({ userSpeaking: speaking(spoken(ms, "you", 1900, 4100)) });
      if (ms < 5600) return at({ awaitingResponse: true });
      return at({});
    },
    you: (ms) => spoken(ms, "you", 1900, 4100) || room(ms),
    alevr: (ms) => spoken(ms, "alevr", 200, 2050),
    stillAt: 2150,
    endsAt: 6400,
  },
  // You speak, mute (and keep talking: the light does not hear you), unmute, speak.
  mute: {
    call: (ms) => {
      if (ms >= 1900 && ms < 4000) return at({ muted: true });
      return at({ userSpeaking: speaking(spoken(ms, "you", 300, 1700) || spoken(ms, "you", 4300, 5900)) });
    },
    you: (ms) => spoken(ms, "you", 300, 1700) || spoken(ms, "you", 2400, 3500) || spoken(ms, "you", 4300, 5900) || room(ms),
    alevr: silent,
    stillAt: 2600,
    endsAt: 6600,
  },
  // Dictation: listening, transcribing, gone.
  dictation: {
    call: () => null,
    dictation: (ms) => ({ transcribing: ms >= 2900 && ms < 4700, closing: ms >= 4700 }),
    you: (ms) => spoken(ms, "you", 300, 2700) || room(ms),
    alevr: silent,
    stillAt: 1500,
    endsAt: 5400,
  },
};

/** The lab's four moments, drawn for every direction. */
export const LAB_CELLS = [
  { id: "you", label: "You speaking", scene: SCENES.listening },
  { id: "thinking", label: "Alevr thinking", scene: SCENES.thinking },
  { id: "alevr", label: "Alevr speaking", scene: SCENES.answering },
  { id: "muted", label: "Muted", scene: SCENES.muted },
] as const;
