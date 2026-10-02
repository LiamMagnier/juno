/*
 * What `search_chats` tells the model (SPEC §3.8.6). English, in a `*.prompt.ts`
 * file so the i18n extractor never harvests it (INV-29). The header is Juno's;
 * the hits are the user's past chats, which can hold text pasted from anywhere,
 * so they sit inside the untrusted envelope.
 */

export const PAST_CHATS_LABEL = "past chats";

export function searchedChatsLine(query: string, count: number, scopedToProject: boolean): string {
  const where = scopedToProject ? "this project's past chats" : "the user's past chats";
  return `Searched ${where} for "${query}": ${count} match${count === 1 ? "" : "es"}.`;
}

export function chatHitLine(title: string, date: string, href: string, excerpt: string): string {
  return `- ${title} (${date}) — ${href}${excerpt ? `: ${excerpt}` : ""}`;
}

export const NO_CHATS_TEXT =
  "No past chats match. Try other keywords, or answer from the current conversation.";

export const EMPTY_CHATS_QUERY_TEXT =
  "The query is empty. Nothing was searched. Send keywords to find.";

export const SEARCH_CHATS_UNAVAILABLE_TEXT =
  "Searching past chats is not available in this conversation. Nothing was searched.";
