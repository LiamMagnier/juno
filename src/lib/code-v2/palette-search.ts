/**
 * Message content in the Code ⌘K palette (Codex, T3 Code and Cursor all search
 * what was said, not only titles).
 *
 * Two sources. The open thread's own messages are searched here, in memory,
 * which is the only way to search a session that runs on the Mac (its
 * transcript is in the env server's log, never on the server). Other Code
 * sessions come from unified search (`/api/search?types=message`), narrowed
 * to the sessions in the Code list, so a chat's message never shows up in
 * Code's palette.
 *
 * Pure, no DOM: the palette renders what this returns.
 */
import type { TurnItem } from "./contracts";
import { groupTurns } from "./turns";

export interface MessageMatch {
  /** Unique within the result list. */
  id: string;
  /** The open thread: the turn to scroll to (`[data-turn]`). */
  turnId?: string;
  /** Another session: where to go, and its title. */
  threadId?: string;
  threadTitle?: string;
  /** Who said it, when known (the open thread). */
  who?: "you" | "alevr";
  snippet: string;
}

/** Lower-cased search terms, at most 8, each at least one character. */
export function queryTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 8);
}

/** One line around the first term, cut at word edges where it can be, with ellipses where it was cut. */
export function snippetAround(text: string, terms: readonly string[], width = 96): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= width) return flat;
  const lower = flat.toLowerCase();
  const at = Math.max(0, Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), flat.length));
  let start = Math.max(0, at - Math.floor(width / 3));
  let end = Math.min(flat.length, start + width);
  start = Math.max(0, end - width);
  if (start > 0) {
    const space = flat.indexOf(" ", start);
    if (space > 0 && space - start < 16) start = space + 1;
  }
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > start && end - space < 16) end = space;
  }
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

/**
 * The open thread's messages that contain every term, newest first. Each
 * carries the id of the turn it sits in (`groupTurns`, the same id the thread
 * puts on `[data-turn]`), so choosing one scrolls to it. Subagents' words and
 * the work log are not searched: only what was said in the thread.
 */
export function messageMatches(items: readonly TurnItem[], query: string, limit = 6): MessageMatch[] {
  const terms = queryTerms(query);
  if (!terms.length || terms.join("").length < 2) return [];
  const out: MessageMatch[] = [];
  const turns = groupTurns(items);
  for (let t = turns.length - 1; t >= 0 && out.length < limit; t--) {
    const turn = turns[t];
    const said = [...(turn.user ? [turn.user] : []), ...turn.items];
    for (let i = said.length - 1; i >= 0 && out.length < limit; i--) {
      const item = said[i];
      if (item.agentId) continue;
      if (item.kind !== "user_message" && item.kind !== "assistant_message") continue;
      const text = item.text ?? "";
      const lower = text.toLowerCase();
      if (!terms.every((term) => lower.includes(term))) continue;
      out.push({ id: `m:${item.id}`, turnId: turn.id, who: item.kind === "user_message" ? "you" : "alevr", snippet: snippetAround(text, terms) });
    }
  }
  return out;
}

/** The conversation id of a unified-search message hit (`/chat/<id>?m=…`), or null. */
export function conversationOfHref(href: string): string | null {
  const m = /^\/(?:chat|code)\/([^/?#]+)/.exec(href);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Unified-search message hits narrowed to other Code sessions. */
export function codeSessionHits(
  hits: readonly { id: string; type: string; href: string; snippet: { text: string } | null; title: string }[],
  codeThreads: ReadonlyMap<string, string>,
  openId: string,
  limit = 6,
): MessageMatch[] {
  const out: MessageMatch[] = [];
  for (const hit of hits) {
    if (hit.type !== "message") continue;
    const threadId = conversationOfHref(hit.href);
    if (!threadId || threadId === openId || !codeThreads.has(threadId)) continue;
    out.push({ id: `s:${hit.id}`, threadId, threadTitle: codeThreads.get(threadId), snippet: (hit.snippet?.text ?? hit.title).replace(/\s+/g, " ").trim() });
    if (out.length >= limit) break;
  }
  return out;
}
