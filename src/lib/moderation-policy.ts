/**
 * The ban/strike decision, with no database in it.
 *
 * `recordFlag` (moderation.ts) reads the account, asks this function what to
 * do, and writes the answer. Keeping the rule here means the case that
 * motivated it can be pinned by `scripts/test-moderation.ts` without Prisma:
 * "I will kill you at chess" matches the credible-threat regex (intent +
 * target within 30 characters), and a regex hit at critical severity used to
 * ban the account on the spot — permanently, with no human in the loop, and
 * `getCurrentUser` returning null on the very next request. A paying customer
 * was gone mid-sentence.
 *
 * The rule now:
 *
 *  - `csam` at high/critical bans immediately, whatever the source. This is
 *    the one category where the cost of a false negative is not one Juno is
 *    willing to carry for the length of a review queue.
 *  - A MANUAL high/critical flag is an owner decision already; it bans.
 *  - An AUTOMATIC high/critical flag in any other category is recorded as
 *    `flagged` with `reviewedAt: null` — the request itself is still refused
 *    (the route's 403 does not depend on this) — and the account is banned
 *    only on a SECOND such hit while the first is still awaiting review, or
 *    when the owner reviews the flag and bans by hand. A first hit the owner
 *    has reviewed and dismissed counts for nothing, so a dismissed false
 *    positive cannot be the "first strike" of a later ban.
 *  - Low/medium severities keep the strike ladder (STRIKE_LIMIT).
 */

export type FlagSeverity = "low" | "medium" | "high" | "critical";
export type FlagSource = "auto" | "manual";
export type FlagAction = "flagged" | "strike" | "banned";

/** Soft strikes at or above this count trigger an automatic ban. */
export const STRIKE_LIMIT = 3;

/** Severities that can end an account without accruing strikes. */
export const SEVERE: readonly FlagSeverity[] = ["critical", "high"];

/** Categories whose severe hits ban on first sight, even from the regex layer. */
export const IMMEDIATE_BAN_CATEGORIES: readonly string[] = ["csam"];

export interface FlagDecisionInput {
  severity: FlagSeverity;
  source: FlagSource;
  category: string;
  /** The account's current soft-strike count. */
  strikes: number;
  /**
   * How many earlier AUTOMATIC high/critical flags on this account are still
   * `flagged` and unreviewed. One or more makes this hit the second.
   */
  pendingSevereAutoFlags: number;
}

export interface FlagDecision {
  action: FlagAction;
  /** The strike count after this flag. */
  strikes: number;
  banned: boolean;
  /** Recorded for a human to look at: `reviewedAt` stays null. */
  awaitsReview: boolean;
}

export function isSevere(severity: FlagSeverity): boolean {
  return SEVERE.includes(severity);
}

export function decideFlagAction(input: FlagDecisionInput): FlagDecision {
  if (!isSevere(input.severity)) {
    const strikes = input.strikes + 1;
    const banned = strikes >= STRIKE_LIMIT;
    return { action: banned ? "banned" : "strike", strikes, banned, awaitsReview: false };
  }

  const immediate =
    input.source === "manual" ||
    IMMEDIATE_BAN_CATEGORIES.includes(input.category) ||
    input.pendingSevereAutoFlags >= 1;
  if (immediate) {
    return { action: "banned", strikes: input.strikes, banned: true, awaitsReview: false };
  }
  return { action: "flagged", strikes: input.strikes, banned: false, awaitsReview: true };
}
