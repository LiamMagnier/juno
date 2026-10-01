/**
 * The words that carry a member's state (INTERACTION_SPEC §2.9 P1). A face
 * never stands for its state alone: every surface prints one of these beside
 * it. No pills, no dots.
 */
import type { CrewState } from "./rig";

/** Short words, for the peek over a thread and tight rows. */
export const SHORT_WORDS: Record<CrewState, string> = {
  available: "Here",
  thinking: "Thinking…",
  working: "Working",
  waiting: "Needs your answer",
  paused: "Paused",
  offline: "Offline",
};

/** A full line in the member's voice, when the surface has room. */
export function stateSentence(name: string, state: CrewState, now?: string): string {
  switch (state) {
    case "thinking":
      return now ?? `${name} is thinking`;
    case "working":
      return now ?? `${name} is working`;
    case "waiting":
      return now ?? `${name} needs your answer`;
    case "paused":
      return now ?? "Paused";
    case "offline":
      return now ?? "Offline";
    default:
      return now ?? "Free";
  }
}

/** Whether the words should use the attention ink (someone needs you). */
export const needsYou = (s: CrewState) => s === "waiting";
