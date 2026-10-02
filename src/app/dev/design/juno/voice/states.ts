/** Every voice and dictation state is a URL (?state=), every clip a script (?play=). Shared by the server page and the client stage. */
export const STATES = [
  "dictation-idle",
  "dictation-permission",
  "dictation-listening",
  "dictation-interim",
  "dictation-done",
  "dictation-error",
  "voice-lab",
  "voice-connecting",
  "voice-listening",
  "voice-thinking",
  "voice-answering",
  "voice-muted",
  "voice-interrupted",
  "voice-tool-approval",
  "voice-error",
  "voice-ended",
  "orbit-voice",
  /** Round 3's name for orbit-voice, kept so old links resolve. */
  "crew-voice",
] as const;
export type VoiceState = (typeof STATES)[number];

export const PLAYS = ["voice", "dictation", "interrupt", "mute", "approval", "reconnect", "orbit", "crew"] as const;
export type Play = (typeof PLAYS)[number];
