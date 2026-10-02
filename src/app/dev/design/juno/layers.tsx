"use client";

import * as React from "react";

/*
 * The keyboard and focus contract for everything that floats (INTERACTION_SPEC
 * §1.5, K1–K3), in one place so every popover and sheet behaves the same:
 *
 *   popover   Escape closes it at once (no exit fade: keyboard work never waits)
 *             and gives focus back to what opened it; a press
 *             outside closes it; opened from the keyboard it appears in the
 *             same frame and focus moves to its checked item (or the first);
 *             the arrow keys move between its items.
 *   dialog    the same, and Tab stays inside it while it is open (a sheet or a
 *             modal is the whole conversation until it closes).
 *
 * "Opened from the keyboard" is read from the click itself: a button pressed
 * with Enter or Space reports `detail === 0`.
 */

const ITEM = [
  'button:not([disabled]):not([aria-disabled="true"])',
  "a[href]",
  "input:not([disabled])",
  "textarea",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

function items(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(ITEM)).filter((el) => el.getClientRects().length > 0);
}

/** True when a click came from the keyboard (Enter or Space on a button). */
export const fromKeyboard = (e: { detail: number }) => e.detail === 0;

export function usePopoverKeys(
  ref: React.RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
  kbd?: boolean,
  triggerSelector?: string,
  { trap = false }: { trap?: boolean } = {},
) {
  const closeRef = React.useRef(onClose);
  React.useLayoutEffect(() => {
    closeRef.current = onClose;
  });
  React.useEffect(() => {
    if (!open) return;
    const returnTo = document.activeElement as HTMLElement | null;
    let raf = 0;
    if (kbd || trap) {
      raf = requestAnimationFrame(() => {
        const root = ref.current;
        if (!root) return;
        if (trap) {
          // A dialog takes focus itself (it is announced by its name), and the first Tab lands on its first control.
          if (!root.hasAttribute("tabindex")) root.setAttribute("tabindex", "-1");
          root.focus({ preventScroll: true });
          return;
        }
        const first = root.querySelector<HTMLElement>('[aria-checked="true"], [aria-selected="true"]') ?? items(root)[0];
        first?.focus({ preventScroll: true });
      });
    }
    const onKey = (e: KeyboardEvent) => {
      const root = ref.current;
      if (e.key === "Escape") {
        e.preventDefault();
        // Dismissed from the keyboard, the layer goes in the same frame (F0, Revision 2): it is hidden now and
        // its exit animation, if any, plays unseen. Pointer dismissals keep the 160 ms ease-in exit.
        if (root) root.style.visibility = "hidden";
        closeRef.current();
        if (returnTo && document.contains(returnTo)) returnTo.focus({ preventScroll: true });
        return;
      }
      if (!root || !(root === document.activeElement || root.contains(document.activeElement))) return;
      const list = items(root);
      const i = list.indexOf(document.activeElement as HTMLElement);
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !trap) {
        e.preventDefault();
        list[(i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length]?.focus();
      }
      if (e.key === "Tab" && trap && list.length) {
        e.preventDefault();
        const next = i < 0 ? (e.shiftKey ? list.length - 1 : 0) : (i + (e.shiftKey ? -1 : 1) + list.length) % list.length;
        list[next]?.focus();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (!t || !ref.current || ref.current.contains(t)) return;
      if (triggerSelector && t.closest(triggerSelector)) return;
      closeRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    if (!trap) window.addEventListener("pointerdown", onDown);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown);
      if (trap && returnTo && document.contains(returnTo)) returnTo.focus({ preventScroll: true });
    };
  }, [open, kbd, ref, triggerSelector, trap]);
}

/** A sheet or modal: focus moves in, Tab stays in, Escape closes, focus returns to the opener. */
export function useDialogFocus(ref: React.RefObject<HTMLElement | null>, open: boolean, onClose: () => void) {
  usePopoverKeys(ref, open, onClose, true, undefined, { trap: true });
}

/** Phone width (where sheets come up from the bottom, O5), read on change through matchMedia, not a resize handler. */
export function usePhone(query = "(max-width: 760px)") {
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    const mq = window.matchMedia(query);
    const read = () => setOn(mq.matches);
    read();
    mq.addEventListener("change", read);
    return () => mq.removeEventListener("change", read);
  }, [query]);
  return on;
}
