import { bindingWindow } from "@/lib/spend-ceiling";
import type { ClientSpend } from "@/types/app";

/*
 * What will stop a Work run, in the reader's words.
 *
 * This file used to hold `WorkRunDisclosure`, the "what this run commits to"
 * line under the chat composer's task toggle. The toggle is gone (the model
 * now decides when a message becomes a background task), and with it the
 * disclosure and the approval-mode phrasing it wore. What is left is the one
 * derivation other surfaces still read: which of the account's rolling windows
 * stops a run, for the schedule editor and the voice briefing. The path stays
 * so their imports, and the tests that pin this derivation, stay put.
 */

/** Which window will stop a run first, and when it frees up. */
export interface RunLimit {
  window: "session" | "weekly";
  /** Epoch ms when that window frees up; null when there is no window. */
  resetsAtMs: number | null;
  /** Spend enforcement is switched off, so no window applies to this account. */
  unmetered: boolean;
}

/**
 * What will stop this run, read from the account's own windows.
 *
 * There is no per-run ceiling any more. This used to be `runCeilingsFor`, which
 * restated `runBudgetForPlan` in the units a person thinks in — "$2, 600,000
 * tokens or 20 minutes" — and the composer printed it under the field. Every
 * one of those numbers is gone: a run goes until the work is done or until the
 * account's rolling window is used up, and that is the sentence the reader now
 * needs. A line promising a ceiling the runtime no longer applies is the same
 * defect as a control that implies something the runtime cannot do; it is just
 * quieter.
 *
 * The binding window is whichever has the least room LEFT, and it is derived by
 * `bindingWindow` — the same call `windowVerdict` makes, so there is one
 * derivation rather than two. It used to compare percentages here while the
 * gate compared absolute remainders, and the weekly budget is many times the
 * session budget, so the two disagreed routinely: at 90% of the session window
 * and 95% of the weekly one, percentage says weekly and the remainder says
 * session. The composer then read out the weekly reset, a day or more away,
 * over a run the five-hour cell was about to stop — a surface naming a limit
 * that is not the one the runtime applies, which is the defect this whole
 * package exists to remove.
 *
 * `unmetered` is the account with `Settings.spendCapDisabled`. It has no window
 * at all, and "0% of your 5-hour limit" would be a meter describing something
 * nothing is measuring. What such a run actually gets is the finite backstop in
 * `spend-ceiling.ts`; what the reader is told is that their limits are off.
 */
export function runLimitFrom(spend: ClientSpend): RunLimit {
  if (spend.capDisabled) {
    return { window: "session", resetsAtMs: null, unmetered: true };
  }
  const binding = bindingWindow({
    session: spend.windows.session,
    weekly: spend.windows.weekly,
  });
  // A metered account with no window at all is not a state the bootstrap can
  // produce — a budget it can enforce is what makes it metered — but the type
  // allows it, and inventing a window here would be the invention this function
  // exists to stop.
  if (binding == null) {
    return { window: "session", resetsAtMs: null, unmetered: true };
  }
  return { window: binding.name, resetsAtMs: binding.resetsAtMs, unmetered: false };
}

/**
 * The limit as a clause: "runs until your 5-hour limit is used up".
 *
 * Nothing prints it since the disclosure went, but
 * tests/work-run-budget.test.ts pins this wording as the true replacement for
 * the old per-run ceilings, so it goes when that assertion does.
 */
export function runStopsPhrase(limit: RunLimit): string {
  if (limit.unmetered) return "runs until it is done";
  return limit.window === "session"
    ? "runs until your 5-hour limit is used up"
    : "runs until your weekly limit is used up";
}
