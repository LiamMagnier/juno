/**
 * The shapes chat's web tools share: search results, the per-turn limits, the
 * provenance ledger handle and the private-text guard (SPEC §6).
 *
 * Types only, so every side can import them: the tool specs (WS1), the web
 * backend (WS2), the turn stream (WS4) and the route (WS9a). WS2 owns this file
 * after WS0.
 */

export type { EngineReport, EngineStatus } from "@/lib/search/search-engine";

/** One chat `web_search` result, as the tool formats it for the model. */
export interface ChatSearchResult {
  /** 1-based number in the turn's source registry, when results are numbered for citation. */
  n?: number;
  title: string;
  url: string;
  /** Cut at 300 characters. */
  snippet: string;
  /** ISO date the engine says the page was published; shown to the model as the page age. */
  publishedAt?: string;
  /** Engine that returned it ("tavily", "serper", "brave", "exa"). */
  engine: string;
  /**
   * Tavily's full page text. Server-side only: it is the turn's prefetch for a
   * later `web_fetch` of the same URL (SPEC §6.1 step 14) and never reaches the
   * model or the client as a search result.
   */
  rawContent?: string;
}

/**
 * Texts that must never leave in a search query: a verbatim ≥ 32-character
 * span of attachment text, project knowledge or memory entries, and the
 * account email as a case-insensitive exact substring (SPEC §6.3). Built by the
 * route from texts it already holds.
 */
export interface PrivateSpanSet {
  /** True when `query` would leak one of the spans. */
  matches(query: string): boolean;
}

/**
 * The turn's web budget (SPEC §6.6), sized by the round budget. Every `take*`
 * both checks and spends, so a refusal is decided in one place.
 */
export interface TurnWebLimits {
  /** One more call of this tool this turn (refusals count for `web_fetch`). */
  take(tool: "web_search" | "web_fetch"): boolean;
  /** One more fetch of this host, and a new distinct host if it is one. */
  takeHost(host: string): boolean;
  /** Spend up to `chars` of the turn's returned-text budget; returns how many were granted. */
  takeChars(chars: number): number;
  /** Count one provenance refusal; true once the turn's refusal limit is reached. */
  noteProvenanceRefusal(): boolean;
}

/** Where a URL on the ledger came from (SPEC §6.2.1). */
export type UrlLedgerKind =
  | "user_message" | "user_memory" | "search_result" | "fetched_page" | "tool_note"
  | "research_source" | "attachment" | "connector_result";

export interface UrlLedgerMatch {
  kind: UrlLedgerKind;
  /** The URL came from the user (typed or remembered), not from outside content. */
  userClass: boolean;
}

/**
 * The provenance ledger as a turn holds it.
 *
 * The ledger is built lazily, on the first `web_fetch` of the turn, so a web-on
 * turn that never fetches decrypts no older rows (SPEC §6.2.3). Additions made
 * before the build are buffered and applied after it, and `match` awaits the
 * build once. A built `UrlLedger` satisfies this interface too (its `match` is
 * synchronous), so callers always `await` the match and never care which one
 * they hold.
 */
export interface LazyUrlLedger {
  addText(text: string, kind: UrlLedgerKind, ref?: string): void;
  add(raw: string, kind: UrlLedgerKind, ref?: string, opts?: { bareDomain: boolean }): void;
  match(raw: string): UrlLedgerMatch | null | Promise<UrlLedgerMatch | null>;
}
