/**
 * Find-in-conversation, over the transcript already decrypted in memory.
 *
 * Message bodies are encrypted at rest, so SQL `contains` cannot see them and
 * server-side search matches titles only (see lib/queries). That is a good
 * security decision with a bad product consequence: every incumbent has full
 * search, and Juno could not find a phrase in the conversation you were
 * currently reading.
 *
 * The open conversation is the one place the plaintext legitimately exists —
 * the client already holds it to render it. Searching there costs nothing, adds
 * no server surface, and weakens the at-rest guarantee not at all. It is not
 * cross-conversation search; it is the ~80% of the value that does not require
 * giving up the encryption.
 *
 * Pure and free of `server-only` so the matching is testable.
 */

export interface SearchableMessage {
  id: string;
  role: string;
  content: string;
}

export interface SearchMatch {
  messageId: string;
  role: string;
  /** Index of the match within the message's content. */
  start: number;
  end: number;
  /** Surrounding text for a result list, with the match inside it. */
  preview: string;
  /** Offsets of the match WITHIN `preview`. */
  previewStart: number;
  previewEnd: number;
}

export interface ConversationSearchResult {
  matches: SearchMatch[];
  /** The scan found at least one more match than it keeps for navigation. */
  truncated: boolean;
}

/** A hit's identity survives older history being inserted before it. */
export interface SearchSelection {
  messageId: string;
  start: number;
  end: number;
  index: number;
}

export const CONVERSATION_SEARCH_LIMIT = 500;
const PREVIEW_RADIUS = 48;

/** Collapse whitespace so a match spanning a line break still reads as one line. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * Every occurrence of `query` across the transcript, in reading order.
 *
 * Case-insensitive and literal — not a regex. A user typing `?` or `(` into a
 * find box means those characters, and treating them as syntax would either
 * throw or silently match the wrong thing.
 */
export function findInConversation(
  messages: readonly SearchableMessage[],
  query: string,
  options: { limit?: number } = {}
): SearchMatch[] {
  return searchConversation(messages, query, options).matches;
}

/**
 * Keep the scan bounded, but inspect one extra hit so the UI never presents
 * the navigation cap as the whole conversation's exact result count.
 */
export function searchConversation(
  messages: readonly SearchableMessage[],
  query: string,
  { limit = CONVERSATION_SEARCH_LIMIT }: { limit?: number } = {}
): ConversationSearchResult {
  const needle = query.trim();
  const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : CONVERSATION_SEARCH_LIMIT;
  if (!needle || cap === 0) return { matches: [], truncated: false };

  // Escaping makes this a literal search. Matching the ORIGINAL string also
  // preserves UTF-16 offsets: lowercasing "İ" expands to two code points and
  // used to shift every subsequent match's preview away from the actual word.
  const pattern = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");

  const matches: SearchMatch[] = [];
  for (const message of messages) {
    if (!message.content) continue;
    pattern.lastIndex = 0;
    for (;;) {
      const found = pattern.exec(message.content);
      if (!found) break;
      if (matches.length >= cap) return { matches, truncated: true };

      const at = found.index;
      const end = at + found[0].length;
      const sliceStart = Math.max(0, at - PREVIEW_RADIUS);
      const sliceEnd = Math.min(message.content.length, end + PREVIEW_RADIUS);
      const lead = flatten(message.content.slice(sliceStart, at));
      const hit = flatten(message.content.slice(at, end));
      const tail = flatten(message.content.slice(end, sliceEnd));
      const prefix = sliceStart > 0 ? "…" : "";

      matches.push({
        messageId: message.id,
        role: message.role,
        start: at,
        end,
        preview: `${prefix}${lead}${hit}${tail}${sliceEnd < message.content.length ? "…" : ""}`,
        previewStart: prefix.length + lead.length,
        previewEnd: prefix.length + lead.length + hit.length,
      });

      // `g` advances past this hit; an empty match is impossible because the
      // literal, non-empty query is escaped above.
    }
  }
  return { matches, truncated: false };
}

/** Resolve a stable hit first, then clamp its old position after edits/deletions. */
export function selectedMatchIndex(matches: readonly SearchMatch[], selection: SearchSelection | null): number {
  if (!selection || matches.length === 0) return 0;
  const retained = matches.findIndex((match) => match.messageId === selection.messageId && match.start === selection.start && match.end === selection.end);
  return retained >= 0 ? retained : Math.max(0, Math.min(selection.index, matches.length - 1));
}

/** Distinct messages containing a match, in reading order. */
export function matchedMessageIds(matches: readonly SearchMatch[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const m of matches) {
    if (seen.has(m.messageId)) continue;
    seen.add(m.messageId);
    ids.push(m.messageId);
  }
  return ids;
}

/** Step through matches, wrapping at both ends. */
export function stepMatch(current: number, total: number, direction: 1 | -1): number {
  if (total <= 0) return 0;
  const bounded = Math.max(0, Math.min(current, total - 1));
  return (bounded + direction + total) % total;
}
