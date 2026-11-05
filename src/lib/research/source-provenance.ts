/**
 * Where the text behind a source came from: a page the run actually opened, or
 * whatever the search engine handed back with the result.
 *
 * `ResearchSource.snapshot` cannot answer this on its own, and the difference
 * matters to every verdict reached against it. Search backends that return page
 * text in the same call (Tavily's `include_raw_content`, Exa's `text`) have that
 * text stored as the snapshot during SEARCH, so "has a snapshot" — which is what
 * the run view counts as `read`, and what the citation audit used to treat as
 * "the page was read" — is true of a few hundred characters of lede exactly as
 * it is of a document the run fetched itself. A figure missing from a lede is
 * not evidence the page lacks it.
 *
 * The rows have no column for this (see `upsertSource` in stages/types.ts), but
 * the run's event log does: every stage that FETCHES a page appends a
 * `source_read` event for it — the READ stage's required fetch and its deepen,
 * the link hop, the workers' `open_page`, and owner-scoped retrieval. The one
 * `source_read` that is not a fetch is the READ stage's bookkeeping line for a
 * body it already held, which carries `ranked: true`. The plan's
 * `sweepFetched` list is the same fact written a second way, and is unioned in.
 *
 * Pure and free of `server-only`, so the benchmark and the eval set can run it
 * under plain `tsx --test`.
 */

import { canonicalUrl } from "@/lib/search/url-safety";
import { isPrivateSourceUrl } from "@/lib/research/private-sources";
import { DEEPEN_BELOW_CHARS } from "@/lib/research/stages/limits";

/**
 * How the text a citation is judged against was obtained.
 *
 *  - `opened`: the run fetched the page itself. What the passage says is what
 *    the page said.
 *  - `search_text`: the search provider supplied a substantial body (at least
 *    `PREVIEW_BELOW_CHARS`) and the run never opened the page. It is the page's
 *    text as the provider extracted it — usable evidence, but not first-hand.
 *  - `search_preview`: the provider supplied less than that, and the run never
 *    opened the page. A lede, not a document: a check that fails against it has
 *    not been shown to fail against the page.
 *  - `private`: the person's own record, read in full by owner-scoped
 *    retrieval. Never fetched from the web.
 *  - `not_read`: found by a search and never given a body at all. Nothing to
 *    cite.
 */
export type SourceReadState = "opened" | "search_text" | "search_preview" | "private" | "not_read";

export const SOURCE_READ_STATES: readonly SourceReadState[] = [
  "opened",
  "search_text",
  "search_preview",
  "private",
  "not_read",
];

/**
 * Below this many characters, a body the run did not fetch itself is a preview.
 *
 * The SAME threshold the READ stage uses to decide a search payload is worth
 * opening properly (`DEEPEN_BELOW_CHARS`): a source the run would have deepened
 * if it had had the budget is, by the run's own rule, a preview. Two numbers
 * here would let the audit call "read" what the reader stage calls "skimmed".
 */
export const PREVIEW_BELOW_CHARS = DEEPEN_BELOW_CHARS;

export function isSourceReadState(value: unknown): value is SourceReadState {
  return typeof value === "string" && (SOURCE_READ_STATES as readonly string[]).includes(value);
}

/** A research event as the provenance read needs it: its kind and payload only. */
export interface ProvenanceEvent {
  kind: string;
  payload: unknown;
}

/**
 * The canonical URLs of every page the run fetched, from its event log and its
 * plan. `null` when neither holds any record of a read at all — a run written
 * before the ledger, or a caller with no run — which is "unknown", not "nothing
 * was opened": without the ledger the honest answer is to say nothing.
 */
export function openedUrlsFrom(input: {
  events: readonly ProvenanceEvent[];
  sweepFetched?: readonly string[] | null;
}): Set<string> | null {
  const opened = new Set<string>();
  let sawLedger = false;
  for (const event of input.events) {
    if (event.kind !== "source_read") continue;
    sawLedger = true;
    const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
      ? (event.payload as Record<string, unknown>)
      : null;
    if (!payload || typeof payload.url !== "string" || !payload.url.trim()) continue;
    // The READ stage's bookkeeping line for a body it already held. It is
    // emitted for every source in a reading wave, fetched or not, so it says
    // nothing about whether this one was opened.
    if (payload.ranked === true) continue;
    opened.add(canonicalUrl(payload.url));
  }
  for (const url of input.sweepFetched ?? []) {
    if (typeof url !== "string" || !url.trim()) continue;
    sawLedger = true;
    opened.add(canonicalUrl(url));
  }
  return sawLedger ? opened : null;
}

/**
 * One source's read state. `opened` is the run's ledger from `openedUrlsFrom`;
 * null there means the ledger is unknown, and the answer is then null too for
 * anything the URL and the body length cannot settle on their own.
 */
export function sourceReadState(
  source: { url: string; textChars: number },
  opened: ReadonlySet<string> | null
): SourceReadState | null {
  if (isPrivateSourceUrl(source.url)) return "private";
  if (source.textChars <= 0) return "not_read";
  if (!opened) return null;
  if (opened.has(canonicalUrl(source.url))) return "opened";
  return source.textChars < PREVIEW_BELOW_CHARS ? "search_preview" : "search_text";
}

/** Whether a verdict reached against this text can fail the claim, or only fail to confirm it. */
export function isPreviewOnly(state: SourceReadState | null | undefined): boolean {
  return state === "search_preview";
}

/** Counts per state, for a methodology line or a run header. Unknown states are not counted. */
export function readStateCounts(states: Iterable<SourceReadState | null>): Record<SourceReadState, number> {
  const counts: Record<SourceReadState, number> = {
    opened: 0,
    search_text: 0,
    search_preview: 0,
    private: 0,
    not_read: 0,
  };
  for (const state of states) if (state) counts[state] += 1;
  return counts;
}
