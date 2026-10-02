/**
 * The per-turn and per-user web limits (SPEC §6.6), sized by the turn's round
 * budget: 4 / 10 / 16 / 24 requests (voice's 7 counts as 10).
 *
 * Every `take*` both checks and spends, so a refusal is decided in exactly one
 * place and a caller cannot check, forget to spend, and let a loop past the
 * cap. `web_fetch` refusals count toward its per-turn cap (§6.2.5): a model
 * probing for URLs that were never on the ledger spends its own budget doing it.
 *
 * The per-user counters are rolling windows in process memory, keyed by the
 * account id and holding timestamps only — never a URL, a host or a query — so
 * a private chat is rate limited like any other without anything about it
 * being kept (INV-32). They are per process by design: a restart forgets them,
 * which errs toward letting a user read, not toward a stored trail.
 *
 * Pure and free of `server-only`.
 */

import type { TurnWebLimits } from "@/lib/web/types";

/** One column of the §6.6 table. */
export interface WebLimitTier {
  roundBudget: 4 | 10 | 16 | 24;
  searches: number;
  fetches: number;
  distinctHosts: number;
  fetchesPerHost: number;
  provenanceRefusals: number;
  returnedChars: number;
}

export const WEB_LIMIT_TIERS: readonly WebLimitTier[] = [
  { roundBudget: 4, searches: 3, fetches: 4, distinctHosts: 4, fetchesPerHost: 3, provenanceRefusals: 3, returnedChars: 60_000 },
  { roundBudget: 10, searches: 6, fetches: 10, distinctHosts: 8, fetchesPerHost: 4, provenanceRefusals: 3, returnedChars: 120_000 },
  { roundBudget: 16, searches: 10, fetches: 16, distinctHosts: 12, fetchesPerHost: 5, provenanceRefusals: 3, returnedChars: 160_000 },
  { roundBudget: 24, searches: 16, fetches: 24, distinctHosts: 16, fetchesPerHost: 6, provenanceRefusals: 3, returnedChars: 200_000 },
];

/**
 * The column for a round budget: the smallest tier that covers it, so voice's
 * 7 reads as 10 and anything past 24 stays at 24.
 */
export function webLimitTier(roundBudget: number): WebLimitTier {
  return WEB_LIMIT_TIERS.find((tier) => roundBudget <= tier.roundBudget) ?? WEB_LIMIT_TIERS[WEB_LIMIT_TIERS.length - 1];
}

/** Per user, rolling (§6.6). */
export const USER_WEB_LIMITS = {
  fetchesPer10Min: 60,
  fetchesPerDay: 400,
  searchesPer10Min: 40,
} as const;

const TEN_MINUTES_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Accounts tracked at once; the least recently active is forgotten first. */
const MAX_TRACKED_USERS = 10_000;

interface UserWindow {
  fetches: number[];
  searches: number[];
}

/**
 * The rolling per-user counters. One process-wide instance backs every turn;
 * tests make their own so they neither see nor leave anything behind.
 */
export class UserWebCounters {
  private readonly users = new Map<string, UserWindow>();

  constructor(private readonly now: () => number = Date.now) {}

  /** One more call for `userId`, or false when a window is full. Spends only on success. */
  take(userId: string, tool: "web_search" | "web_fetch"): boolean {
    const at = this.now();
    const window = this.window(userId);
    if (tool === "web_search") {
      window.searches = window.searches.filter((t) => at - t < TEN_MINUTES_MS);
      if (window.searches.length >= USER_WEB_LIMITS.searchesPer10Min) return false;
      window.searches.push(at);
      return true;
    }
    window.fetches = window.fetches.filter((t) => at - t < DAY_MS);
    if (window.fetches.length >= USER_WEB_LIMITS.fetchesPerDay) return false;
    let recent = 0;
    for (const t of window.fetches) if (at - t < TEN_MINUTES_MS) recent += 1;
    if (recent >= USER_WEB_LIMITS.fetchesPer10Min) return false;
    window.fetches.push(at);
    return true;
  }

  /** How many accounts are tracked (for tests). */
  get size(): number {
    return this.users.size;
  }

  private window(userId: string): UserWindow {
    const existing = this.users.get(userId);
    if (existing) {
      // Re-insert so Map order is least-recently-active first.
      this.users.delete(userId);
      this.users.set(userId, existing);
      return existing;
    }
    const created: UserWindow = { fetches: [], searches: [] };
    this.users.set(userId, created);
    if (this.users.size > MAX_TRACKED_USERS) {
      const oldest = this.users.keys().next().value;
      if (oldest !== undefined) this.users.delete(oldest);
    }
    return created;
  }
}

const PROCESS_COUNTERS = new UserWebCounters();

export interface TurnWebLimitsInput {
  roundBudget: number;
  /** Keys the in-process per-user rolling counters; holds no content. */
  userId: string;
  /** Tests pass their own; production uses the process-wide counters. */
  userCounters?: UserWebCounters;
}

class TurnWebBudget implements TurnWebLimits {
  private searches = 0;
  private fetches = 0;
  private refusals = 0;
  private charsLeft: number;
  private readonly perHost = new Map<string, number>();

  constructor(
    private readonly tier: WebLimitTier,
    private readonly userId: string,
    private readonly counters: UserWebCounters,
  ) {
    this.charsLeft = tier.returnedChars;
  }

  take(tool: "web_search" | "web_fetch"): boolean {
    if (tool === "web_search") {
      if (this.searches >= this.tier.searches) return false;
      if (!this.counters.take(this.userId, tool)) return false;
      this.searches += 1;
      return true;
    }
    if (this.fetches >= this.tier.fetches) return false;
    if (!this.counters.take(this.userId, tool)) return false;
    this.fetches += 1;
    return true;
  }

  takeHost(host: string): boolean {
    const key = host.toLowerCase().replace(/\.+$/, "").replace(/^www\./, "");
    const seen = this.perHost.get(key);
    if (seen === undefined) {
      if (this.perHost.size >= this.tier.distinctHosts) return false;
      this.perHost.set(key, 1);
      return true;
    }
    if (seen >= this.tier.fetchesPerHost) return false;
    this.perHost.set(key, seen + 1);
    return true;
  }

  takeChars(chars: number): number {
    const granted = Math.max(0, Math.min(Math.floor(chars), this.charsLeft));
    this.charsLeft -= granted;
    return granted;
  }

  noteProvenanceRefusal(): boolean {
    this.refusals += 1;
    return this.refusals >= this.tier.provenanceRefusals;
  }
}

export function createTurnWebLimits(input: TurnWebLimitsInput): TurnWebLimits {
  return new TurnWebBudget(webLimitTier(input.roundBudget), input.userId, input.userCounters ?? PROCESS_COUNTERS);
}
