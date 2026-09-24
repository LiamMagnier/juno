/**
 * The private-text guard on chat search queries (SPEC §6.3 query hygiene).
 *
 * A search query goes to a third-party engine. The model is told never to put
 * the user's documents in one, and this is what holds when it does anyway: a
 * query that repeats a verbatim span of 32 characters or more from an
 * attachment, a project file or a memory entry is refused before any engine
 * sees it, and so is a query that contains the account email (usually shorter
 * than 32 characters, so matched as an exact substring instead).
 *
 * Matching is case-insensitive and whitespace-insensitive, which errs toward
 * refusing: "verbatim" should not be defeated by a line break the model turned
 * into a space.
 *
 * Built by the route from texts it already holds; indexed lazily on the first
 * query, so a turn that never searches pays nothing. The index is 32-bit hashes
 * of 16-character anchors taken every 16 characters: any 32-character span of a
 * text contains one of them, so a query window that hits no anchor cannot be a
 * span, and a window that does is confirmed with a plain substring test. Exact,
 * and a few megabytes for a large attachment. Pure and free of `server-only`.
 */

import type { PrivateSpanSet } from "@/lib/web/types";

/** The shortest verbatim span that counts (§6.3). */
export const PRIVATE_SPAN_CHARS = 32;
const ANCHOR = 16;

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/** FNV-1a over `text[from, from + ANCHOR)`. */
function anchorHash(text: string, from: number): number {
  let hash = 0x811c9dc5;
  for (let i = from; i < from + ANCHOR; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createPrivateSpanSet(input: { texts: readonly string[]; email?: string | null }): PrivateSpanSet {
  const email = input.email ? normalize(input.email) : "";
  let texts: string[] | null = null;
  let anchors: Set<number> | null = null;

  const index = () => {
    if (texts && anchors) return { texts, anchors };
    texts = input.texts.map(normalize).filter((text) => text.length >= PRIVATE_SPAN_CHARS);
    anchors = new Set<number>();
    for (const text of texts) {
      for (let at = 0; at + ANCHOR <= text.length; at += ANCHOR) anchors.add(anchorHash(text, at));
    }
    return { texts, anchors };
  };

  return {
    matches(query: string): boolean {
      const q = normalize(query);
      if (email && q.includes(email)) return true;
      if (q.length < PRIVATE_SPAN_CHARS || input.texts.length === 0) return false;
      const { texts: corpus, anchors: known } = index();
      if (corpus.length === 0) return false;
      const windows = new Set<number>();
      for (let at = 0; at + ANCHOR <= q.length; at += 1) {
        if (!known.has(anchorHash(q, at))) continue;
        // A span containing this anchor starts at most ANCHOR - 1 characters before it.
        const first = Math.max(0, at - (ANCHOR - 1));
        const last = Math.min(at, q.length - PRIVATE_SPAN_CHARS);
        for (let start = first; start <= last; start += 1) windows.add(start);
      }
      for (const start of windows) {
        const window = q.slice(start, start + PRIVATE_SPAN_CHARS);
        if (corpus.some((text) => text.includes(window))) return true;
      }
      return false;
    },
  };
}

/** A guard that guards nothing, for a turn that holds no private text. */
export const NO_PRIVATE_SPANS: PrivateSpanSet = { matches: () => false };
