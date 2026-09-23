"use client";

import { findOccurrences } from "@/lib/documents/viewer-kind";

/**
 * Find-in-document, painted with the CSS Custom Highlight API.
 *
 * WHY HIGHLIGHTS AND NOT <mark>. The PDF text layer is pdf.js's DOM: spans it
 * positioned and scaled one by one, which it re-measures on zoom. Wrapping a
 * match in a <mark> splits those spans and throws its measurements off, and
 * the reading views are React trees that would have to be re-rendered with
 * marks in them for every keystroke. A highlight is a set of Ranges the
 * browser paints over text that is otherwise untouched — no DOM changes, no
 * re-render, and it paints through the text layer's transparent glyphs.
 *
 * Where the API is missing, the find bar still counts and still scrolls to each
 * match; only the paint is absent.
 */

const ALL = "juno-find";
const ACTIVE = "juno-find-active";

type HighlightRegistry = { set(name: string, value: unknown): void; delete(name: string): void };
type HighlightCtor = new (...ranges: Range[]) => unknown;

function registry(): { highlights: HighlightRegistry; Highlight: HighlightCtor } | null {
  if (typeof CSS === "undefined" || typeof window === "undefined") return null;
  const highlights = (CSS as unknown as { highlights?: HighlightRegistry }).highlights;
  const Highlight = (window as unknown as { Highlight?: HighlightCtor }).Highlight;
  return highlights && Highlight ? { highlights, Highlight } : null;
}

export function paintFindHighlights(ranges: Range[], active: Range | null) {
  const api = registry();
  if (!api) return;
  api.highlights.set(ALL, new api.Highlight(...ranges));
  if (active) api.highlights.set(ACTIVE, new api.Highlight(active));
  else api.highlights.delete(ACTIVE);
}

export function clearFindHighlights() {
  const api = registry();
  if (!api) return;
  api.highlights.delete(ALL);
  api.highlights.delete(ACTIVE);
}

/**
 * The text under `root`, as one string plus the text nodes it came from.
 * Anything inside `[data-find-skip]` (a line-number gutter, a label) is not
 * part of the document and is left out.
 */
function collectText(root: Node): { text: string; nodes: Text[]; starts: number[] } {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (parent?.closest("[data-find-skip]")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node as Text;
    starts.push(text.length);
    nodes.push(t);
    text += t.data;
  }
  return { text, nodes, starts };
}

function locate(nodes: Text[], starts: number[], offset: number, preferEnd: boolean): { node: Text; offset: number } | null {
  // Binary search for the node containing `offset`. At a boundary, an END
  // point belongs to the node before it, so a match never ends at offset 0 of
  // the next node (which would include nothing of it but still wrap to it).
  let lo = 0;
  let hi = nodes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const start = starts[mid];
    if (start < offset || (!preferEnd && start === offset)) lo = mid;
    else hi = mid - 1;
  }
  const node = nodes[lo];
  if (!node) return null;
  return { node, offset: Math.min(Math.max(offset - starts[lo], 0), node.data.length) };
}

/** Every occurrence of `query` under `root`, as live DOM Ranges, in document order. */
export function findRanges(root: Node, query: string, limit = 2000): Range[] {
  if (!query.trim()) return [];
  const { text, nodes, starts } = collectText(root);
  if (!nodes.length) return [];
  const ranges: Range[] = [];
  for (const [start, end] of findOccurrences(text, query, limit)) {
    const a = locate(nodes, starts, start, false);
    const b = locate(nodes, starts, end, true);
    if (!a || !b) continue;
    const range = document.createRange();
    try {
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      ranges.push(range);
    } catch {
      // A node detached between the walk and here — skip the match.
    }
  }
  return ranges;
}

/** Scroll `scroller` so `range` sits a third of the way down it. */
export function scrollRangeIntoView(scroller: HTMLElement, range: Range, behavior: ScrollBehavior = "smooth") {
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;
  const box = scroller.getBoundingClientRect();
  const top = scroller.scrollTop + (rect.top - box.top) - box.height / 3;
  const left =
    rect.left < box.left || rect.right > box.right
      ? scroller.scrollLeft + (rect.left - box.left) - box.width / 3
      : scroller.scrollLeft;
  scroller.scrollTo({ top: Math.max(0, top), left: Math.max(0, left), behavior });
}
