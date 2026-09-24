/**
 * The provisional hold (SPEC §7.3): whether a live round's text is answer or
 * commentary, decided on the client before the server can say.
 *
 * Claude, Gemini and the compat models often write "Let me look that up." and
 * then call a tool in the same round. The server only learns that the text was
 * a preamble at `round_end`, by which time it has already streamed into the
 * answer area. So for a round whose deltas declare no `phase`, in a turn that
 * offered tools, the client holds the text back until the first of:
 *
 *   - a tool call for that round arrives → commentary (shown under the peek);
 *   - 600 ms since its first delta, 280 characters, or a paragraph break →
 *     answer (flushed after the peek collapses);
 *   - the stream ends → answer.
 *
 * With `phase` declared, or no tools offered, nothing is held. A verdict is
 * sticky: once a round is answer it stays answer until the server moves it,
 * which `applyStreamChunk` does by taking the round out of `liveRounds`.
 *
 * Pure. The caller keeps the first-seen time of each round and a timer for
 * `nextCheckAt`.
 */

import { RUN_PACING } from "@/lib/motion";
import type { LiveAnswerState, RoundVerdict } from "@/lib/run/types";

/** The shape of `LiveMessage.liveRounds` entries this module reads. */
export interface HoldRound {
  round: number;
  text: string;
  phase?: "commentary" | "answer";
}

export interface HoldInput {
  rounds: readonly HoldRound[];
  /** The turn's `fact:tools.offered` is non-empty. */
  toolsOffered: boolean;
  /** Rounds that already have a tool call. */
  callRounds: ReadonlySet<number>;
  streaming: boolean;
  /** Client time each round's text was first seen. */
  firstSeenAt: ReadonlyMap<number, number>;
  now: number;
  verdicts: Readonly<Record<number, RoundVerdict>>;
  holdMs?: number;
  holdChars?: number;
}

/** Whether a round's text is held at all: undeclared phase in a turn that offered tools. */
export function isHeldRound(round: Pick<HoldRound, "phase">, toolsOffered: boolean): boolean {
  return toolsOffered && round.phase === undefined;
}

const PARAGRAPH = /\n[ \t]*\n/;

/**
 * Settles every round that can be settled now. Returns the verdicts (a new
 * object only when one changed) and when to look again, or null when nothing
 * is still waiting on the clock.
 */
export function classifyRounds(input: HoldInput): { verdicts: Readonly<Record<number, RoundVerdict>>; nextCheckAt: number | null } {
  const holdMs = input.holdMs ?? RUN_PACING.textHoldMs;
  const holdChars = input.holdChars ?? RUN_PACING.textHoldChars;
  let verdicts = input.verdicts;
  let nextCheckAt: number | null = null;
  const set = (round: number, verdict: RoundVerdict) => {
    if (verdicts[round] === verdict) return;
    if (verdicts === input.verdicts) verdicts = { ...verdicts };
    (verdicts as Record<number, RoundVerdict>)[round] = verdict;
  };

  // A round's held text is the undeclared entries of that round, in order.
  const held = new Map<number, string>();
  let lastRound = -1;
  for (const entry of input.rounds) {
    lastRound = Math.max(lastRound, entry.round);
    if (entry.phase === "answer") set(entry.round, "answer");
    if (!isHeldRound(entry, input.toolsOffered)) continue;
    held.set(entry.round, (held.get(entry.round) ?? "") + entry.text);
  }
  if (!input.toolsOffered) {
    for (const entry of input.rounds) if (entry.phase !== "commentary") set(entry.round, "answer");
  }

  for (const [round, text] of held) {
    if (verdicts[round]) continue;
    if (input.callRounds.has(round)) {
      set(round, "commentary");
      continue;
    }
    // A later round began with no call for this one: the step ended inside the response (a
    // provider search), which never demotes text (§2.8 rule 1).
    if (!input.streaming || round < lastRound || text.length > holdChars || PARAGRAPH.test(text)) {
      set(round, "answer");
      continue;
    }
    const seen = input.firstSeenAt.get(round) ?? input.now;
    if (input.now - seen >= holdMs) {
      set(round, "answer");
      continue;
    }
    nextCheckAt = nextCheckAt === null ? seen + holdMs : Math.min(nextCheckAt, seen + holdMs);
  }
  return { verdicts, nextCheckAt };
}

/** Some round's text was released to the answer area as answer text. */
export function answerStarted(verdicts: Readonly<Record<number, RoundVerdict>>): boolean {
  return Object.values(verdicts).includes("answer");
}

/** Joins rounds as the persisted answer does: a blank line between different rounds (§2.8 rule 3). */
function joinRounds(parts: ReadonlyArray<{ round: number; text: string }>): string {
  let out = "";
  let previous: number | null = null;
  for (const part of parts) {
    if (previous !== null && part.round !== previous && out.trim()) {
      out = `${out.replace(/\s+$/, "")}\n\n${part.text.replace(/^\s+/, "")}`;
    } else {
      out += part.text;
    }
    previous = part.round;
  }
  return out;
}

/**
 * The text the answer area may render. At rest, and for a client without
 * `liveRounds` (no `timeline`), that is `content`. Live, it is the rounds the
 * hold released as answer, once the peek has collapsed out of the way.
 */
export function liveAnswerText(
  message: { content: string; liveRounds?: readonly HoldRound[] },
  state: LiveAnswerState | null,
): string {
  if (!message.liveRounds) return message.content;
  if (!state || !state.revealed) return "";
  return joinRounds(
    message.liveRounds.filter((entry) => entry.phase !== "commentary" && state.verdicts[entry.round] === "answer"),
  );
}

/** Rounds the hold classified as commentary, still live: shown in `RunCommentary` under the peek. */
export function heldCommentary(
  rounds: readonly HoldRound[] | undefined,
  verdicts: Readonly<Record<number, RoundVerdict>>,
): Array<{ round: number; text: string }> {
  if (!rounds) return [];
  const byRound = new Map<number, string>();
  for (const entry of rounds) {
    if (entry.phase !== undefined || verdicts[entry.round] !== "commentary") continue;
    byRound.set(entry.round, (byRound.get(entry.round) ?? "") + entry.text);
  }
  return [...byRound].map(([round, text]) => ({ round, text: text.trim() })).filter((entry) => entry.text);
}

// ── The peek's one open and one collapse (SPEC §7.5) ─────────────────────────

/**
 * "closed": never opened (mounted closed). "open": showing the latest steps.
 * "collapsed": it opened once and has folded away; it never opens again, not
 * even when a tool starts after the answer began (re-entry changes the line
 * only, §7.3).
 */
export type PeekState = "closed" | "open" | "collapsed";

export interface PeekInput {
  streaming: boolean;
  /** The run has at least one step to show (a tool row, reasoning, declared commentary). */
  hasStep: boolean;
  /** Answer text is about to render (the hold released a round as answer). */
  answerStarted: boolean;
}

/**
 * The peek opens once, when the first step exists and before any answer text,
 * and collapses at the first answer text or when the run ends (a Stop, a
 * failure, or done before any answer) — then stays collapsed.
 */
export function nextPeekState(state: PeekState, input: PeekInput): PeekState {
  switch (state) {
    case "closed":
      return input.streaming && input.hasStep && !input.answerStarted ? "open" : "closed";
    case "open":
      return input.answerStarted || !input.streaming ? "collapsed" : "open";
    case "collapsed":
      return "collapsed";
  }
}
