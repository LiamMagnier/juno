/**
 * A run, SPOKEN: what a voice-mode turn says about code it ran.
 *
 * TOOL_RUNTIME_DESIGN.md §6.12: a spoken turn speaks the outcome, never the
 * program and never raw output. A run longer than a few seconds gets one
 * spoken phase so the silence is explained; produced files are attached to the
 * transcript message and mentioned once, by name. The realtime voice relay has
 * no tools at all and says so itself (relay/src/session.ts), which this module
 * does not pretend otherwise about.
 *
 * Pure, so the read-aloud path (chat-view), native voice mode and the gallery
 * all say the same sentences. NEVER AN EM-DASH in any string.
 */

import { cleanForSpeech } from "@/lib/message-content";
import { readToolRuns, type ToolRunFile, type ToolRunView } from "@/lib/chat/tool-run";
import type { ClientActivityEvent } from "@/types/chat";

/** A run must be this old before the one spoken phase is said. */
export const VOICE_RUN_PHASE_AFTER_MS = 4_000;

export const VOICE_RUN_LABEL = {
  phaseData: "Running the numbers.",
  phaseScript: "Running the script.",
  phaseSkill: "Reading the skill.",
  failed: "That run failed, so I'm working from what it printed.",
  timedOut: "That run took too long and was stopped.",
  stopped: "Stopped.",
  unknown: "I can't tell whether that run finished, so I haven't run it again.",
  unavailable: "I can't run code right now.",
  declined: "Okay, I won't run that.",
  waiting: "I need your go-ahead on screen before I run that.",
} as const;

/**
 * The one phase a voice turn speaks while a run works, or null.
 * Said once per turn (`alreadySpoken`), and only past the few-seconds mark:
 * a two-second run is over before the sentence would be. An approval wait is
 * the exception, said at once.
 */
export function voiceRunCue(
  views: readonly ToolRunView[],
  elapsedMs: number,
  alreadySpoken: boolean,
): string | null {
  if (alreadySpoken) return null;
  // An approval blocks the turn until the person answers on screen, and a
  // listener may not be looking: that is said at once, not after a delay.
  if (views.some((v) => v.phase === "awaiting_approval")) return VOICE_RUN_LABEL.waiting;
  if (elapsedMs < VOICE_RUN_PHASE_AFTER_MS) return null;
  const live = [...views].reverse().find((v) => v.phase === "running" || v.phase === "queued");
  if (!live) return null;
  if (live.tool === "use_skill" || live.tool === "read_skill_file") return VOICE_RUN_LABEL.phaseSkill;
  return live.language === "bash" ? VOICE_RUN_LABEL.phaseScript : VOICE_RUN_LABEL.phaseData;
}

function listNames(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  if (names.length <= 4) return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`;
}

/** "I've attached chart.png and summary.csv to the chat." Once, by name. */
export function voiceFilesSentence(files: readonly ToolRunFile[]): string | null {
  const names = [...new Set(files.map((f) => f.name))];
  if (names.length === 0) return null;
  return `I've attached ${listNames(names)} to the chat.`;
}

/**
 * The spoken outcome of one settled run, or null when the answer itself is
 * the outcome (a success with nothing to attach is said by the reply).
 */
export function voiceRunOutcome(view: ToolRunView): string | null {
  switch (view.phase) {
    case "succeeded":
      return voiceFilesSentence(view.files);
    case "failed":
      return VOICE_RUN_LABEL.failed;
    case "timed_out":
      return VOICE_RUN_LABEL.timedOut;
    case "cancelled":
      return VOICE_RUN_LABEL.stopped;
    case "outcome_unknown":
      return VOICE_RUN_LABEL.unknown;
    case "unavailable":
      return VOICE_RUN_LABEL.unavailable;
    case "denied":
      return VOICE_RUN_LABEL.declined;
    default:
      return null;
  }
}

/**
 * What read-aloud says for a settled reply that ran code: the reply as speech
 * (code blocks become "code shown on screen", never read), then the files
 * once, when the reply did not already name them.
 */
export function speechForReply(text: string, activity: readonly ClientActivityEvent[] | null | undefined): string {
  const spoken = cleanForSpeech(text);
  const runs = readToolRuns(activity, { live: false });
  const files = runs.flatMap((run) => (run.phase === "succeeded" || run.phase === "failed" ? run.files : []));
  if (files.length === 0) return spoken;
  const lower = spoken.toLowerCase();
  const unnamed = files.filter((file) => !lower.includes(file.name.toLowerCase()));
  if (unnamed.length === 0) return spoken;
  const sentence = voiceFilesSentence(unnamed);
  return sentence ? `${spoken} ${sentence}`.trim() : spoken;
}
