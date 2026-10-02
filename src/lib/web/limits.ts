/**
 * The per-turn and per-user web limits (SPEC §6.6), sized by the turn's round
 * budget: 4 / 10 / 16 / 24 requests (voice's 7 counts as 10).
 *
 * WS0 lands the signature; WS2 implements it.
 */

import type { TurnWebLimits } from "@/lib/web/types";

export function createTurnWebLimits(_input: {
  roundBudget: number;
  /** Keys the in-process per-user rolling counters; holds no content. */
  userId: string;
}): TurnWebLimits {
  throw new Error("not implemented: WS2");
}
