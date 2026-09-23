/**
 * The policy every adapter's tool loop shares (SPEC §4.1, §4.6).
 *
 * The four adapters keep their own request, stream and replay code; what they
 * share is WHEN to stop. The budget counts provider requests, including the
 * final tools-off one, so "10" means ten HTTP calls to the provider whatever
 * each one did. A request is final when the budget has one request left or
 * when the route asked for the end early (the spend guard predicted an
 * overrun, or the turn's provider-search cap was reached).
 *
 * Pure: no provider, no clock, no I/O.
 */

import type { ReasoningEffort } from "@/types/chat";

export { FINAL_ROUND_NOTE } from "./loop.prompt";

/** Provider requests per turn, INCLUDING the final tools-off request (DECISIONS T5, §4b). */
export function roundBudgetFor(effort: ReasoningEffort | null | undefined, voice: boolean): number {
  if (voice) return 7;                                   // unchanged: 6 tool rounds + 1 forced
  switch (effort) {
    case "minimal": case "low": return 4;
    case "high": return 16;
    case "xhigh": case "max": return 24;
    default: return 10;                                  // medium, Instant (null), unset
  }
}

/**
 * The turn's provider-search cap: how many searches the provider may run over
 * the whole turn (SPEC §4.1, the `web_search` row of §6.6). 3 / 6 / 10 / 16 for
 * budgets 4 / 10 / 16 / 24; voice's 7 counts as 10.
 *
 * Anthropic's `max_uses` is this number on EVERY request of the turn. It bounds
 * one request, so it cannot be the round budget (24 searches × 23 requests would
 * be ≈ 550 searches on a `max` turn), and it must not change between requests,
 * because a changed `tools` array invalidates preserved thinking and the tools
 * cache. The turn-wide bound is the route's: every provider search counts, and
 * at the cap it calls `requestFinal("searches")`.
 */
export function providerSearchCapFor(budget: number): number {
  if (budget <= 4) return 3;
  if (budget <= 10) return 6;
  if (budget <= 16) return 10;
  return 16;
}

export interface LoopController {
  readonly budget: number;
  readonly requests: number;
  /** Call before each provider request. `final` = this request must be tools-off. */
  beginRequest(): { index: number; final: boolean };
  /** The route calls this when the budget guard predicts an overrun or the turn's provider
   *  search cap is reached. Idempotent; the first reason wins. */
  requestFinal(reason: "budget" | "searches"): void;
  /** True when the NEXT request will be final (rounds exhausted or final requested). */
  nextIsFinal(): boolean;
  readonly finalReason: "rounds" | "budget" | "searches" | null;
}

/**
 * `finalReason` says why the loop was cut short, so the route can emit the
 * `tool_budget` notice. It stays null for a request that is final only because
 * the budget is a single request (a tool-less `streamChat` call): nothing was
 * cut. "rounds" is recorded when a final request is begun because the earlier
 * requests used up the budget — the model kept calling tools.
 */
export function createLoopController(opts: { budget: number }): LoopController {
  const budget = Math.max(1, Math.floor(Number.isFinite(opts.budget) ? opts.budget : 1));
  let requests = 0;
  let requested: "budget" | "searches" | null = null;
  let roundsExhausted = false;

  const lastRequestReached = () => requests >= budget - 1;

  return {
    get budget() {
      return budget;
    },
    get requests() {
      return requests;
    },
    beginRequest() {
      const index = requests;
      const exhausted = index >= budget - 1;
      if (exhausted && index > 0 && requested === null) roundsExhausted = true;
      requests += 1;
      return { index, final: exhausted || requested !== null };
    },
    requestFinal(reason) {
      if (requested === null && !roundsExhausted) requested = reason;
    },
    nextIsFinal() {
      return lastRequestReached() || requested !== null;
    },
    get finalReason() {
      if (requested !== null) return requested;
      return roundsExhausted ? "rounds" : null;
    },
  };
}
