/*
 * The conversation a cloud run continues, trimmed to what a prompt can carry.
 *
 * A cloud run is a fresh process on a fresh machine. Before this, a second
 * message in a Code session reached a runner that had never seen the first
 * one or what the agent answered — so "now also add tests for that" arrived
 * with no "that". runner-context now returns the conversation's persisted
 * user and assistant turns and the runner seeds its session with them.
 *
 * Pure on purpose (no Prisma, no crypto): the route decrypts the rows and
 * this decides what fits. Tested directly in tests/code-continuity.test.ts.
 */

export interface RunnerHistoryTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Total characters across every kept turn — roughly 12k tokens, which leaves
 * the bulk of any model's context for the repository the agent is about to
 * read. Newest turns are kept first; the oldest fall off.
 */
export const RUNNER_HISTORY_CHAR_BUDGET = 48_000;
/** Longest single turn kept, so one pasted log cannot spend the whole budget. */
export const RUNNER_HISTORY_TURN_CAP = 12_000;
/** Turns kept at most, whatever their size. */
export const RUNNER_HISTORY_TURN_LIMIT = 40;

const HEAD_MARK = "\n…[the rest of this turn was omitted]";
const TAIL_MARK = "…[the start of this turn was omitted]\n";

/**
 * Clip one turn to the cap.
 *
 * A user turn keeps its HEAD: the instruction is written first and the
 * pasted file text under it is what runs long. An assistant turn keeps its
 * TAIL: a coding run's prose ends with what it did and what it found, and
 * the opening "I'll start by reading…" is the part nobody needs back.
 */
function clip(turn: RunnerHistoryTurn, cap: number): string {
  const text = turn.text.trim();
  if (text.length <= cap) return text;
  return turn.role === "user"
    ? text.slice(0, cap - HEAD_MARK.length) + HEAD_MARK
    : TAIL_MARK + text.slice(text.length - (cap - TAIL_MARK.length));
}

/**
 * The turns to seed, oldest first, under the budget.
 *
 * Walked from the newest backwards so the turns the next instruction refers
 * to are the ones that survive; an empty turn (an assistant row for a run
 * that produced only tool activity) is skipped rather than seeded as a blank
 * line; and a leading assistant turn — the one whose user turn fell off the
 * budget — is dropped, because every provider requires the first message of
 * a transcript to be the user's.
 */
export function trimRunnerHistory(
  turns: readonly RunnerHistoryTurn[],
  opts: { budget?: number; turnCap?: number; turnLimit?: number } = {},
): RunnerHistoryTurn[] {
  const budget = opts.budget ?? RUNNER_HISTORY_CHAR_BUDGET;
  const turnCap = opts.turnCap ?? RUNNER_HISTORY_TURN_CAP;
  const turnLimit = opts.turnLimit ?? RUNNER_HISTORY_TURN_LIMIT;

  const kept: RunnerHistoryTurn[] = [];
  let used = 0;
  for (let i = turns.length - 1; i >= 0 && kept.length < turnLimit; i -= 1) {
    const text = clip(turns[i], turnCap);
    if (!text) continue;
    if (used + text.length > budget) break;
    kept.push({ role: turns[i].role, text });
    used += text.length;
  }
  kept.reverse();
  while (kept.length > 0 && kept[0].role === "assistant") kept.shift();
  return kept;
}
