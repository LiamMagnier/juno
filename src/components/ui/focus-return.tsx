"use client";

import * as React from "react";

/**
 * Where focus goes back to when a dialog closes, for the dialogs Radix cannot
 * place on its own.
 *
 * Radix's modal Dialog hands focus back to its `<Dialog.Trigger>` and to
 * nothing else: it prevents its FocusScope's own return and focuses
 * `triggerRef`, which is null for every dialog opened some other way. Most of
 * the shell's dialogs are opened that way: the search overlay from the
 * sidebar's Search row (an event), the command menu and the shortcuts sheet
 * from a chord, every confirm from a menu item. Each of them dropped focus on
 * `<body>` when it closed, so a keyboard user's next Tab started over at
 * "Skip to content".
 *
 * `resolveFocusReturnTarget` picks the element to return to as the dialog
 * opens. A dialog opened from a menu item cannot go back to the item, which
 * leaves with its menu, so it goes back to the button that opened the menu:
 * a `role="menu"` is labelled by its trigger (Radix wires `aria-labelledby`,
 * as the APG menu-button pattern asks), walked up through submenus.
 */
export function resolveFocusReturnTarget(active: Element | null, doc: Document = document): HTMLElement | null {
  let node: Element | null = active && active !== doc.body && active !== doc.documentElement ? active : null;
  for (let depth = 0; node && depth < 8; depth++) {
    const menu = node.closest('[role="menu"][aria-labelledby]');
    if (!menu) break;
    const trigger = doc.getElementById(menu.getAttribute("aria-labelledby") ?? "");
    if (!trigger || trigger === node || menu.contains(trigger)) break;
    node = trigger;
  }
  return node && typeof (node as HTMLElement).focus === "function" ? (node as HTMLElement) : null;
}

type FocusReturn = { element: HTMLElement; caret: Range | null };

/**
 * The caret inside a contenteditable opener (the composer). Focusing an
 * editable host whose selection has moved elsewhere puts the caret at its
 * START, so a reader who pressed ⌘K mid-draft, then Escape, kept typing at
 * the front of their sentence. Text inputs keep their own selection; only the
 * editable host needs this.
 */
function captureCaret(element: HTMLElement): Range | null {
  if (!element.isContentEditable) return null;
  const selection = element.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  return element.contains(range.startContainer) && element.contains(range.endContainer) ? range.cloneRange() : null;
}

/** Focus the opener and, for an editable host, put its caret back (or at the end, never the start). */
function restoreFocus({ element, caret }: FocusReturn) {
  element.focus({ preventScroll: true });
  if (!element.isContentEditable) return;
  const selection = element.ownerDocument.getSelection();
  if (!selection) return;
  let range = caret;
  if (!range || !element.contains(range.startContainer) || !element.contains(range.endContainer)) {
    range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

/**
 * Captures the opener while the dialog's content RENDERS — before the commit
 * that mounts it, which is also the commit that unmounts a menu the dialog was
 * opened from (by the time an effect runs, the item is gone and focus is
 * already on `<body>`). Rendered inside the content, so it mounts once per
 * open; the initializer is idempotent, so a StrictMode double render is
 * harmless.
 */
function FocusReturnCapture({ target }: { target: React.MutableRefObject<FocusReturn | null> }) {
  React.useState(() => {
    if (typeof document === "undefined") return null;
    const element = resolveFocusReturnTarget(document.activeElement);
    target.current = element ? { element, caret: captureCaret(element) } : null;
    return null;
  });
  return null;
}

/**
 * `capture` goes inside the dialog content; `onCloseAutoFocus` replaces the
 * caller's (and calls it first).
 *
 * The return only happens when focus would otherwise be lost: Radix's own
 * handler runs after this one and focuses its Trigger when it has one, so the
 * check waits a microtask and does nothing unless focus is still on `<body>`.
 * A caller that prevents the default (a palette command that opens a popover
 * of its own once the palette has gone) keeps full control.
 */
export function useDialogFocusReturn(onCloseAutoFocus?: (event: Event) => void) {
  const target = React.useRef<FocusReturn | null>(null);
  const handleCloseAutoFocus = React.useCallback(
    (event: Event) => {
      onCloseAutoFocus?.(event);
      const opener = target.current;
      target.current = null;
      if (event.defaultPrevented || !opener) return;
      queueMicrotask(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active !== document.documentElement) return;
        if (opener.element.isConnected) restoreFocus(opener);
      });
    },
    [onCloseAutoFocus]
  );
  return { capture: <FocusReturnCapture target={target} />, onCloseAutoFocus: handleCloseAutoFocus };
}
