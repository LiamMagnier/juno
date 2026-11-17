/** The stage's states, readable by the server page (stage.tsx is a client module). */
export const STAGE_STATES = [
  "composer",
  "connecting",
  "listening",
  "thinking",
  "speaking",
  "muted",
  "muted-speaking",
  "reconnecting",
  "error",
  "ended",
] as const;
export type StageState = (typeof STAGE_STATES)[number];
