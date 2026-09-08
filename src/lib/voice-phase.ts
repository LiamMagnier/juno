/**
 * What is happening in a voice call, as distinct from whether the socket is up.
 *
 * WHY THIS EXISTS. The realtime hook had exactly one state union —
 * `idle | connecting | reconnecting | live | ended | error` — and it describes
 * the TRANSPORT. Every question a person actually has during a call was
 * missing from it: is my microphone hearing me, did it notice I stopped, is it
 * working on an answer, is it talking now. The interface answered all of them
 * with the single word "Listening", from the moment the socket opened until
 * the call ended.
 *
 * The gap that costs the most is the one after you stop speaking and before
 * the first audio arrives. It is the single worst moment in a voice product —
 * the user cannot tell whether they were heard, whether to repeat themselves,
 * or whether the thing is broken — and it rendered nothing at all.
 *
 * So phase is a second axis, derived rather than stored. Transport says
 * whether a call exists; phase says what is happening inside it. Neither can
 * be inferred from the other: a live socket can be listening or thinking, and
 * a reconnecting one is neither.
 */

export type VoiceTransport = "idle" | "connecting" | "reconnecting" | "live" | "ended" | "error";

export type VoicePhase =
  /** No call, or a call that has ended. */
  | "idle"
  /** The call is being established. */
  | "connecting"
  /** Microphone open, nobody talking. */
  | "listening"
  /** The caller is speaking right now. */
  | "user-speaking"
  /** The caller stopped; no audio has arrived yet. */
  | "thinking"
  /** The model is speaking. */
  | "speaking"
  /** The microphone is closed by the caller. */
  | "muted"
  /** Something went wrong and the call cannot continue as it is. */
  | "error";

export interface PhaseInput {
  transport: VoiceTransport;
  muted: boolean;
  /** The microphone level is above the speech floor right now. */
  userSpeaking: boolean;
  /** A turn has been committed and no output audio has started. */
  awaitingResponse: boolean;
  /** Output audio is playing. */
  assistantSpeaking: boolean;
}

/**
 * Total, and deliberately ordered: the first condition that holds wins.
 *
 * Muted outranks everything inside a live call because it is the one state a
 * caller can be actively wrong about — believing they are being heard when
 * they are not is worse than any other confusion a call can produce.
 */
export function derivePhase(input: PhaseInput): VoicePhase {
  const { transport, muted, userSpeaking, awaitingResponse, assistantSpeaking } = input;
  if (transport === "error") return "error";
  if (transport === "idle" || transport === "ended") return "idle";
  if (transport === "connecting" || transport === "reconnecting") return "connecting";
  if (assistantSpeaking) return "speaking";
  if (muted) return "muted";
  if (userSpeaking) return "user-speaking";
  if (awaitingResponse) return "thinking";
  return "listening";
}

/**
 * The label on screen. Short, because it sits in a 40px bar beside a meter,
 * and in sentence case because nothing in this product shouts.
 */
export const PHASE_LABEL: Record<VoicePhase, string> = {
  idle: "Call ended",
  connecting: "Connecting",
  listening: "Listening",
  "user-speaking": "Listening",
  thinking: "Thinking",
  speaking: "Speaking",
  muted: "Muted",
  error: "Connection problem",
};

/**
 * What assistive technology hears, which is not the same string.
 *
 * A voice mode is by definition used without looking at the screen, and the
 * old dock announced nothing at all — the whole indicator was `aria-hidden`
 * and the status text sat in a plain span. These are full sentences because
 * they are read aloud in isolation, and they name the action available: a
 * caller who cannot see the Stop button still needs to know they may simply
 * talk over the answer.
 */
export const PHASE_ANNOUNCEMENT: Record<VoicePhase, string> = {
  idle: "The call has ended.",
  connecting: "Connecting the call.",
  listening: "Connected. Listening.",
  "user-speaking": "Listening.",
  thinking: "Thinking about your answer.",
  speaking: "Juno is speaking. Talk any time to interrupt.",
  muted: "Your microphone is muted.",
  error: "There is a problem with the call.",
};

/**
 * Whether the phase should be announced at all.
 *
 * "Listening" and "user speaking" are the same announcement, and a caller who
 * is mid-sentence does not want their own speech narrated back at them, so
 * the two collapse and only the first is spoken.
 */
export function announcementFor(phase: VoicePhase, previous: VoicePhase | null): string | null {
  if (phase === previous) return null;
  if (phase === "user-speaking" && previous === "listening") return null;
  if (phase === "listening" && previous === "user-speaking") return null;
  return PHASE_ANNOUNCEMENT[phase];
}

/** The microphone level above which a caller counts as speaking, 0..1. */
export const SPEECH_FLOOR = 0.08;
