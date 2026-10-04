/**
 * The little a turn's two web tools share beyond their limits: the search
 * prefetch, the enumeration guard's latch, the once-per-turn degraded notice
 * and where audit events go.
 *
 * Keyed by the turn's `TurnWebLimits` object, because that is the one per-turn
 * object BOTH backends already receive (`chatWebSearch` and `fetchPageForChat`
 * have fixed context shapes, SPEC §12.7), and a WeakMap means nothing outlives
 * the turn that made it: when the limits object is dropped, so is the text a
 * search prefetched. Per turn only (SPEC §6.7) — the shared per-user cache is a
 * follow-up — so a private chat keeps nothing past its own turn (INV-32).
 *
 * Pure and free of `server-only`.
 */

import type { TurnWebLimits } from "@/lib/web/types";

/** A search result's page text, served to a later `web_fetch` of the same URL (SPEC §6.1 step 14). */
export interface PrefetchedPage {
  url: string;
  title: string;
  text: string;
}

/**
 * What the web backends report for the audit trail. Hosts, counts and keyed
 * hashes only; never a URL, a query or page text. The route wires it for saved
 * chats and leaves it unset in private ones (INV-32).
 */
export interface WebAuditEvent {
  kind: "fetch_provenance_refused" | "injection_detected";
  severity: "warning" | "violation";
  detail: Record<string, string | number | boolean>;
}

export type WebAuditSink = (event: WebAuditEvent) => void;

export interface WebTurnState {
  /** Canonical provenance key (`canonKey`) → the page text a search already returned. */
  prefetch: Map<string, PrefetchedPage>;
  /**
   * Canonical provenance key → the whole text of a page `web_fetch` opened this
   * turn, so `find_in_page` searches the page the model already holds without
   * a second request. Per turn and in memory only, like the prefetch.
   */
  opened: Map<string, PrefetchedPage>;
  /** Set once the enumeration guard trips: every later `web_fetch` this turn is refused. */
  fetchDisabled: boolean;
  /** Whether this turn already reported a degraded search. */
  degradedReported: boolean;
  audit: WebAuditSink | null;
}

const STATES = new WeakMap<TurnWebLimits, WebTurnState>();

/** The turn's shared web state, created on first use. */
export function webTurnState(limits: TurnWebLimits): WebTurnState {
  let state = STATES.get(limits);
  if (!state) {
    state = { prefetch: new Map(), opened: new Map(), fetchDisabled: false, degradedReported: false, audit: null };
    STATES.set(limits, state);
  }
  return state;
}

/**
 * Where this turn's web audit events go. The route calls it once, beside
 * `createTurnWebLimits`, for a saved chat; a private chat never calls it.
 */
export function setWebAuditSink(limits: TurnWebLimits, sink: WebAuditSink | null): void {
  webTurnState(limits).audit = sink;
}

/** Sends an event to the turn's sink, if it has one. An audit failure never fails a tool call. */
export function auditWeb(limits: TurnWebLimits, event: WebAuditEvent): void {
  const sink = webTurnState(limits).audit;
  if (!sink) return;
  try {
    sink(event);
  } catch {
    // The audit trail is best effort; the call it describes has already happened.
  }
}

/**
 * True the first time a turn's search degrades, false after: the
 * `search_degraded` notice is once per turn (SPEC §6.3), however many
 * searches fell back.
 */
export function firstSearchDegradation(limits: TurnWebLimits): boolean {
  const state = webTurnState(limits);
  if (state.degradedReported) return false;
  state.degradedReported = true;
  return true;
}
