"use client";

import type { WorkInboxSession, WorkTriageCounts } from "@/components/work/work-transport";
import type { ClientWorkHost } from "@/lib/work/serializers";

/**
 * What Work looked like the last time the reader was on it.
 *
 * THE BUG THIS EXISTS FOR. Going from Chat to Work played a loading animation
 * every single time — including the fifteenth time in a session, on a list that
 * had not changed since the last look. Three placeholders stacked up for one
 * navigation: the route's `loading.tsx` shimmered the whole page, the Suspense
 * fallback under it drew the frame again, and then `sessions === null` drew a
 * third set of rows while the fetch was out. None of them were waiting for
 * anything the reader did not already have. A skeleton is a promise that
 * something is coming; playing one over data you are holding is a lie that
 * costs a beat.
 *
 * So the last successful answer is kept, and the page opens on it. The fetch
 * still goes out — this is a cache, not a substitute — and the rows update
 * underneath when it lands. A list that has not changed does not blink at all.
 *
 * IN MEMORY, DELIBERATELY. `sessionStorage` would survive a hard reload and
 * would also be read during hydration, where the server rendered `null` and the
 * client would render rows — a hydration mismatch that React resolves by
 * throwing the client tree away, which is a much worse flash than the one being
 * fixed. A module-scope object is empty on a fresh document, which is exactly
 * the state the server rendered, and full on every client navigation, which is
 * the case that was broken.
 *
 * AND THERE IS NO `clear()`, WHICH IS WORTH SAYING OUT LOUD, because the
 * obvious worry — the next account opening on the last account's tasks — is a
 * real one and is already answered. `signOutToSignIn` leaves by assigning
 * `window.location.href`, which is a document navigation: every module in the
 * page is torn down, this one included. A clear function would be unreachable
 * code that made the guarantee look like it depended on somebody remembering to
 * call it. If sign-out ever becomes a client-side route change, this needs one.
 *
 * STALENESS IS CARRIED, NOT HIDDEN. `loadedAt` comes back with the rows so the
 * page's own "last updated" line keeps telling the truth about how old they
 * are. A cache that resets that clock would make stale rows look fresh, which is
 * the one way this could be worse than the skeleton.
 */
export interface WorkSnapshot {
  /**
   * Mutable arrays, deliberately: these go straight into `useState` on the page
   * and a `readonly` type there would force a cast at every restore — a cast
   * that says nothing and hides the next one. Safety comes from `writeWorkSnapshot`
   * copying what it is given (`slice`), so the stored rows are never the caller's
   * array and a later `setSessions` cannot reach back into the cache.
   */
  sessions: WorkInboxSession[];
  /** ISO timestamp of the fetch these rows came from. */
  loadedAt: string;
  hosts: ClientWorkHost[] | null;
  counts: WorkTriageCounts | null;
}

/**
 * How many rows are kept.
 *
 * The page renders 25 and offers to show more, so a snapshot twice that deep
 * covers the first "show the rest" without a gap while staying a bounded object
 * rather than an ever-growing copy of the account.
 */
const MAX_SNAPSHOT_ROWS = 50;

/**
 * Past this, the rows are not worth opening on.
 *
 * Not about correctness — the refetch is already in flight and the timestamp is
 * already on screen. It is about what the first paint CLAIMS. Rows from this
 * morning, rendered as the live list, invite a decision on a run that has since
 * finished or failed. Two minutes is comfortably longer than a trip to Chat and
 * back (the case this exists for) and comfortably shorter than a lunch break.
 */
const SNAPSHOT_TTL_MS = 120_000;

let snapshot: WorkSnapshot | null = null;

/** The last view of the inbox, or `null` if there isn't a usable one. */
export function readWorkSnapshot(): WorkSnapshot | null {
  if (!snapshot) return null;
  const age = Date.now() - Date.parse(snapshot.loadedAt);
  // `Number.isNaN` guards an unparseable timestamp rather than trusting the
  // comparison: `NaN > TTL` is false, so a corrupt value would read as fresh
  // forever — the one direction this must not fail in.
  if (Number.isNaN(age) || age > SNAPSHOT_TTL_MS) {
    snapshot = null;
    return null;
  }
  return snapshot;
}

/** Record a successful load. Partial updates keep whatever they don't mention. */
export function writeWorkSnapshot(next: {
  sessions?: readonly WorkInboxSession[];
  loadedAt?: string;
  hosts?: readonly ClientWorkHost[];
  counts?: WorkTriageCounts;
}): void {
  const sessions = next.sessions ?? snapshot?.sessions;
  // Sessions are what the page opens on; without them there is nothing to
  // restore and a hosts-only snapshot would just be an object to expire.
  if (!sessions) return;
  const hosts = next.hosts ?? snapshot?.hosts ?? null;
  snapshot = {
    sessions: sessions.slice(0, MAX_SNAPSHOT_ROWS),
    loadedAt: next.loadedAt ?? snapshot?.loadedAt ?? new Date().toISOString(),
    hosts: hosts === null ? null : hosts.slice(),
    counts: next.counts ?? snapshot?.counts ?? null,
  };
}
