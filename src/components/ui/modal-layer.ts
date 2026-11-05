"use client";

import * as React from "react";

/**
 * A full-screen layer drawn IN PLACE, made modal while `active`.
 *
 * Two layers cover the whole app without being a Radix dialog, because they
 * are the same element in two states or a route rather than an overlay: the
 * document viewer in fullscreen (the split pane, grown over the window, so the
 * open PDF and its find state survive the switch) and the /settings page (a
 * window over the app shell). Both used to be `fixed inset-0 z-modal` and
 * nothing else: Tab walked out of them into the invisible sidebar behind,
 * a screen reader read the page underneath, a wheel at the end of a list
 * scrolled the page underneath, and focus was dropped on <body> when they went
 * away.
 *
 * While active:
 *   - everything outside the layer is `inert`, so focus cannot leave it and
 *     assistive tech cannot reach the page behind (the native modal-dialog
 *     contract). Live regions are spared, and so are the branches that hold
 *     them: a toast raised from inside the layer must still be heard and
 *     clicked. Radix portals opened from inside the layer mount after this
 *     runs and are untouched;
 *   - focus moves into the layer if it was outside (the layer carries
 *     `tabIndex={-1}` so it can take it);
 *   - scroll does not chain to the page: the layer is given
 *     `overscroll-behavior: contain` (and must be a scroll container, e.g.
 *     `overflow-hidden`), never `overflow: hidden` on <html>, which would drop
 *     the root scrollbar and shift the page;
 *   - when it stops being modal (or unmounts), the inert marks are removed and
 *     focus goes back to whatever had it before, if focus would otherwise be
 *     lost.
 */
export function useModalLayer(ref: React.RefObject<HTMLElement | null>, active: boolean) {
  React.useEffect(() => {
    const layer = ref.current;
    if (!active || !layer) return;
    const doc = layer.ownerDocument;
    const before = doc.activeElement;
    const opener = before instanceof HTMLElement && before !== doc.body && !layer.contains(before) ? before : null;
    const marked = inertOutside(layer);
    layer.style.overscrollBehavior = "contain";
    if (!layer.contains(doc.activeElement)) layer.focus({ preventScroll: true });
    return () => {
      for (const el of marked) el.inert = false;
      layer.style.overscrollBehavior = "";
      const now = doc.activeElement;
      const lost = !now || now === doc.body || !now.isConnected;
      if (lost && opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [ref, active]);
}

/** What stays reachable while a layer is modal: live regions and the toaster. */
const KEEP = "[aria-live], [role='status'], [role='alert'], [data-sonner-toaster]";

/**
 * Marks every element outside `layer` inert, walking up its ancestors, and
 * returns what it marked so the caller can undo exactly that (an element that
 * was already inert stays inert).
 */
export function inertOutside(layer: HTMLElement): HTMLElement[] {
  const marked: HTMLElement[] = [];
  const mark = (el: Element) => {
    // `inert` is an HTMLElement property: an SVG or MathML root has none.
    if (!("inert" in el) || (el as HTMLElement).inert) return;
    if (el.matches(KEEP)) return;
    if (el.querySelector(KEEP)) {
      // A branch that holds a live region: keep the region, mark the rest.
      for (const child of Array.from(el.children)) mark(child);
      return;
    }
    (el as HTMLElement).inert = true;
    marked.push(el as HTMLElement);
  };
  for (let node: Element | null = layer; node && node.parentElement; node = node.parentElement) {
    if (node === layer.ownerDocument.body) break;
    for (const sibling of Array.from(node.parentElement.children)) {
      if (sibling !== node && sibling.tagName !== "SCRIPT" && sibling.tagName !== "STYLE") mark(sibling);
    }
  }
  return marked;
}
