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
  "crew-voice",
] as const;
export type VoiceState = (typeof STATES)[number];

export const PLAYS = ["voice", "dictation", "interrupt", "mute", "crew"] as const;
export type Play = (typeof PLAYS)[number];
