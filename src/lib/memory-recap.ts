/*
 * THE RECAP — what changed in what Juno knows, over a week, a month, a quarter.
 *
 * Claude ships a Monthly Recap of "the topics you spent time on and how you
 * work". This is Juno's, and it is built as a REVIEW rather than a report: the
 * most useful thing a recap can do for memory is put the month's new beliefs
 * in front of the person they are about, while they can still remember
 * whether they are true. So it leads with what was learned (correctable in
 * place), then what Juno changed its mind about, what it forgot, and what it
 * leaned on — and last, the conversations themselves.
 *
 * WHEN THINGS HAPPENED is the subtle part, and `updatedAt` is the wrong answer
 * to it: every chat turn stamps `lastUsedAt` on the facts it used, and that
 * write moves `updatedAt` too, so "rows updated this month" is "rows that were
 * useful this month". Every time here comes from the data's own meaning:
 *
 *   learned     the fact's createdAt
 *   replaced    the REPLACEMENT's createdAt — that is the moment of the change
 *   conflicting the row's createdAt — it was born losing a conflict
 *   forgotten   the suppression's createdAt
 *   expired     the fact's expiresAt
 *   leaned on   the fact's lastUsedAt
 *
 * Pure — no Prisma, no React — so every one of those rules is testable.
 */

/** The columns a recap reads — a subset of what the memory page already loads. */
export interface RecapRow {
  id: string;
  content: string;
  kind: string;
  category: string | null;
  status: string;
  reason: string | null;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  supersededById: string | null;
}

export const RECAP_PERIODS = [7, 30, 90] as const;
export type RecapPeriod = (typeof RECAP_PERIODS)[number];

export interface MemoryRecap {
  days: number;
  since: string;
  /** Facts first learned in the window, newest first — including ones since retired. */
  learned: RecapRow[];
  /** `learned`, counted by category, largest first. */
  learnedByCategory: { category: string | null; count: number }[];
  /** Beliefs replaced in the window, with what replaced them. */
  replaced: { before: RecapRow; after: RecapRow | null }[];
  /** Facts that arrived losing a conflict with something the user said. */
  conflicting: RecapRow[];
  /** Statements the user asked Juno to forget in the window. */
  forgotten: RecapRow[];
  /** Temporary facts whose moment passed in the window. */
  expired: RecapRow[];
  /** Active facts Juno used in the window, most recently used first. */
  leanedOn: RecapRow[];
}

const LEANED_ON_LIMIT = 6;

const inWindow = (iso: string | null, since: number, until: number) => {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) && t >= since && t <= until;
};

export function buildMemoryRecap(rows: readonly RecapRow[], opts: { days: number; now?: Date }): MemoryRecap {
  const until = (opts.now ?? new Date()).getTime();
  const since = until - opts.days * 86_400_000;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const facts = rows.filter((row) => row.kind === "FACT");
  const newestFirst = (key: (row: RecapRow) => string | null) => (a: RecapRow, b: RecapRow) =>
    new Date(key(b) ?? 0).getTime() - new Date(key(a) ?? 0).getTime();

  const learned = facts.filter((row) => inWindow(row.createdAt, since, until)).sort(newestFirst((r) => r.createdAt));

  const counts = new Map<string | null, number>();
  for (const row of learned) counts.set(row.category, (counts.get(row.category) ?? 0) + 1);
  const learnedByCategory = [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count || String(a.category).localeCompare(String(b.category)));

  const replaced = facts
    .filter((row) => row.status === "superseded")
    .map((before) => ({ before, after: before.supersededById ? byId.get(before.supersededById) ?? null : null }))
    // A replacement that was since deleted leaves no date to place the change
    // at. Rather than guess, the recap leaves it out — the row is still on the
    // memory page, under "what Juno stopped believing".
    .filter(({ after }) => after !== null && inWindow(after.createdAt, since, until))
    .sort((a, b) => new Date(b.after!.createdAt).getTime() - new Date(a.after!.createdAt).getTime());

  const conflicting = facts
    .filter((row) => row.status === "contradicted" && inWindow(row.createdAt, since, until))
    .sort(newestFirst((r) => r.createdAt));

  const forgotten = rows
    .filter((row) => row.kind === "SUPPRESSION" && inWindow(row.createdAt, since, until))
    .sort(newestFirst((r) => r.createdAt));

  const expired = facts
    .filter((row) => row.status === "expired" && inWindow(row.expiresAt, since, until))
    .sort(newestFirst((r) => r.expiresAt));

  const leanedOn = facts
    .filter((row) => row.status === "active" && inWindow(row.lastUsedAt, since, until))
    .sort(newestFirst((r) => r.lastUsedAt))
    .slice(0, LEANED_ON_LIMIT);

  return {
    days: opts.days,
    since: new Date(since).toISOString(),
    learned,
    learnedByCategory,
    replaced,
    conflicting,
    forgotten,
    expired,
    leanedOn,
  };
}

/** True when the window holds nothing at all to show. */
export function recapIsEmpty(recap: MemoryRecap, themes: readonly string[]): boolean {
  return (
    recap.learned.length === 0 &&
    recap.replaced.length === 0 &&
    recap.conflicting.length === 0 &&
    recap.forgotten.length === 0 &&
    recap.expired.length === 0 &&
    recap.leanedOn.length === 0 &&
    themes.length === 0
  );
}

/**
 * One line per conversation, from the extractor's digests.
 *
 * A digest is merged chunk by chunk as a long chat is distilled (" · "
 * between the parts, see `extractConversationMemory`), so the first part is
 * what the chat was about when it began — the right line for a list of what
 * the month was spent on. Duplicates collapse: five chats "about the thesis"
 * are one theme, not five.
 */
export function recapThemes(digests: readonly (string | null)[], limit = 8): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const digest of digests) {
    const first = digest?.replace(/^…/, "").split(" · ")[0]?.trim();
    if (!first) continue;
    const key = first.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(first.length > 140 ? `${first.slice(0, 139).trimEnd()}…` : first);
    if (out.length >= limit) break;
  }
  return out;
}
