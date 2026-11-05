/**
 * Orbit's owner-tunable numbers, read from env with conservative defaults and
 * clamps (docs/OPEN_DECISIONS.md §11, "owner to confirm"; listed in
 * .env.example). Unset, empty or unreadable values are the default; a value
 * outside its bounds is clamped to them.
 *
 * Read on the server only (the Work runner and the agents' server modules):
 * the pure rule modules (note-review.ts, goals.ts) keep the defaults as
 * constants and take these as arguments.
 */

import { MAX_AGENT_NOTE_CHARS } from "@/lib/agents/domain";
import { GOAL_CHECK_STEP_CHARS, GOAL_CHECK_TOTAL_CHARS } from "@/lib/agents/goals";
import { MAX_RUN_NOTE_CHARS, MAX_RUN_NOTES_PER_RUN } from "@/lib/agents/note-review";

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw.trim());
  if (!Number.isFinite(value) || !Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** `AGENT_RUN_NOTES_PER_RUN`: the most notes one task may save with `remember` (1–10, default 3). */
export function runNotesPerRun(raw: string | undefined = process.env.AGENT_RUN_NOTES_PER_RUN): number {
  return boundedInteger(raw, MAX_RUN_NOTES_PER_RUN, 1, 10);
}

/** `AGENT_RUN_NOTE_MAX_CHARS`: one task note's length (100 to the profile's own bound, default 500). */
export function runNoteMaxChars(raw: string | undefined = process.env.AGENT_RUN_NOTE_MAX_CHARS): number {
  return boundedInteger(raw, MAX_RUN_NOTE_CHARS, 100, MAX_AGENT_NOTE_CHARS);
}

/** The criteria check's model bounds: `AGENT_GOAL_CHECK_TIMEOUT_MS` (5–120 s, default 30 s) and `AGENT_GOAL_CHECK_MAX_TOKENS` (40–400, default 120). */
export function goalCheckModelBounds(
  env: { timeoutMs?: string; maxTokens?: string } = {
    timeoutMs: process.env.AGENT_GOAL_CHECK_TIMEOUT_MS,
    maxTokens: process.env.AGENT_GOAL_CHECK_MAX_TOKENS,
  }
): { timeoutMs: number; maxTokens: number } {
  return {
    timeoutMs: boundedInteger(env.timeoutMs, 30_000, 5_000, 120_000),
    maxTokens: boundedInteger(env.maxTokens, 120, 40, 400),
  };
}

/**
 * How much of the steps' results the criteria check reads:
 * `AGENT_GOAL_CHECK_STEP_CHARS` per step (300–6,000, default 1,500) and
 * `AGENT_GOAL_CHECK_TOTAL_CHARS` in all (1,000–32,000, default 8,000).
 */
export function goalCheckTextBounds(
  env: { stepChars?: string; totalChars?: string } = {
    stepChars: process.env.AGENT_GOAL_CHECK_STEP_CHARS,
    totalChars: process.env.AGENT_GOAL_CHECK_TOTAL_CHARS,
  }
): { stepChars: number; totalChars: number } {
  return {
    stepChars: boundedInteger(env.stepChars, GOAL_CHECK_STEP_CHARS, 300, 6_000),
    totalChars: boundedInteger(env.totalChars, GOAL_CHECK_TOTAL_CHARS, 1_000, 32_000),
  };
}
