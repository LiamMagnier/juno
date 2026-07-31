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
  { limit = 500 }: { limit?: number } = {}
): SearchMatch[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];

  const matches: SearchMatch[] = [];
  for (const message of messages) {
    if (!message.content) continue;
    const haystack = message.content.toLowerCase();

    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;

      const end = at + needle.length;
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

      if (matches.length >= limit) return matches;
      // Advance past this match so overlapping needles ("aa" in "aaa") cannot
      // loop forever, and a zero-length needle is impossible (guarded above).
      from = at + needle.length;
    }
  }
  return matches;
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
  return (current + direction + total) % total;
}
