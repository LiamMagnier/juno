/**
 * The transcript's navigation rail, as data (after beui's message scroller,
 * beui.dev/components/agents/message-scroller).
 *
 * One tick per turn — a question and the reply under it — on the transcript's
 * right edge. The turn in view is lit, its neighbours taper, and a tick's card
 * reads the question with the start of its answer. Built from the messages and
 * the window's measured offsets, never from the DOM: a long conversation only
 * mounts the rows near the viewport, so most turns have no element to read.
 *
 * Pure, so the rules are tested without a browser (tests/transcript-rail.test.ts).
 */

import type { TranscriptLayout } from "@/lib/chat/transcript-window";

export const RAIL_TITLE_LENGTH = 56;
export const RAIL_DESCRIPTION_LENGTH = 88;
/** A tick's row at full size, and the least it may shrink to before turns are sampled. */
export const RAIL_ITEM_SIZE = 14;
export const RAIL_MIN_ITEM_SIZE = 6;
/** How near either end of the scroll still counts as being at that end. */
export const RAIL_EDGE = 56;

export interface RailTurn {
  /** The question's message id: what a jump asks the window to bring into view. */
  id: string;
  /** Index of the question in the message list. */
  index: number;
  label: string;
  description?: string;
  /** 1-based position among all turns, for the accessible name. */
  position: number;
}

export interface RailMessage {
  id: string;
  role: string;
  content: string;
}

/** Markdown read as words: what a person sees, without the syntax that writes it. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/[*_~`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Cut at a word when one ends late enough, with an ellipsis. */
export function truncateAtWord(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const excerpt = text.slice(0, limit);
  const boundary = excerpt.lastIndexOf(" ");
  return `${excerpt.slice(0, boundary > limit * 0.65 ? boundary : limit).trim()}…`;
}

/**
 * Every question in the conversation, labelled by its own words and described
 * by the start of the reply after it. A long question carries on into the
 * description instead, since that is where its point usually is.
 */
export function railTurns(messages: readonly RailMessage[]): RailTurn[] {
  const turns: RailTurn[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "USER") return;
    const text = plainText(message.content);
    const next = messages[index + 1];
    const reply = next && next.role !== "USER" ? plainText(next.content) : "";
    let label = text || "Message";
    let rest = reply;
    if (text.length > RAIL_TITLE_LENGTH) {
      label = truncateAtWord(text, RAIL_TITLE_LENGTH);
      rest = reply || text.slice(label.length - 1).trim();
    }
    turns.push({
      id: message.id,
      index,
      label,
      description: rest ? truncateAtWord(rest, RAIL_DESCRIPTION_LENGTH) : undefined,
      position: turns.length + 1,
    });
  });
  return turns;
}

/**
 * Fits the turns to the rail's height. Ticks shrink from 14px to 6px; past
 * that, turns are sampled evenly, and the first and the newest always stay.
 */
export function fitRail(turns: readonly RailTurn[], height: number): { items: RailTurn[]; itemSize: number } {
  if (!turns.length || height <= 0) return { items: [], itemSize: RAIL_ITEM_SIZE };
  const itemSize = Math.max(RAIL_MIN_ITEM_SIZE, Math.min(RAIL_ITEM_SIZE, Math.floor(height / turns.length)));
  const capacity = Math.max(2, Math.floor(height / itemSize));
  if (turns.length <= capacity) return { items: [...turns], itemSize };
  const items: RailTurn[] = [];
  for (let k = 0; k < capacity; k++) {
    const turn = turns[Math.round((k * (turns.length - 1)) / (capacity - 1))];
    if (items[items.length - 1] !== turn) items.push(turn);
  }
  return { items, itemSize };
}

/**
 * The turn being read: the first at the top, the newest at the live edge,
 * otherwise the one whose span holds the middle of the viewport. `padding` is
 * the transcript's space above its first row. A viewport the window has not
 * measured yet (top is Infinity) is the live edge, where a chat opens.
 */
export function activeRailTurn(
  turns: readonly RailTurn[],
  layout: Pick<TranscriptLayout, "offsets" | "keys">,
  viewport: { top: number; height: number; atBottom: boolean },
  padding = 24,
): string | null {
  if (!turns.length) return null;
  if (viewport.atBottom || !Number.isFinite(viewport.top)) return turns[turns.length - 1].id;
  if (viewport.top <= RAIL_EDGE) return turns[0].id;
  const centre = viewport.top + viewport.height / 2 - padding;
  let active = turns[0];
  for (const turn of turns) {
    if ((layout.offsets[turn.index] ?? Infinity) <= centre) active = turn;
    else break;
  }
  return active.id;
}

/** The rail's own tick for a turn it sampled away: the nearest one at or before it. */
export function nearestRailItem(items: readonly RailTurn[], turns: readonly RailTurn[], id: string | null): string | null {
  if (!id || !items.length) return null;
  if (items.some((item) => item.id === id)) return id;
  const position = turns.find((turn) => turn.id === id)?.position ?? 0;
  let nearest = items[0];
  for (const item of items) if (item.position <= position) nearest = item;
  return nearest.id;
}

/** A tick's length relative to the highlighted one: lit, then tapering over two neighbours. */
export function tickScale(distance: number): number {
  return distance === 0 ? 1 : distance === 1 ? 0.68 : distance === 2 ? 0.44 : 0.25;
}
