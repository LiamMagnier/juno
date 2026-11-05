import type * as React from "react";

/**
 * The close focus for the catalogue's popovers (Radix `onCloseAutoFocus`,
 * which runs a tick after the content leaves). Focus that has already moved
 * on stays where it is: the catalogue that replaced the "Couldn't load" card
 * after a retry worked has put it in its search field, and the old card's
 * close used to pull it back to the chip. With no trigger to return to
 * (`returnFocusTo`), it goes to the chip, unless the person closed the
 * popover by acting elsewhere.
 */
export function catalogueCloseFocus(
  event: Event,
  { returnFocusTo, interactedOutside }: { returnFocusTo?: React.RefObject<HTMLElement | null>; interactedOutside: boolean },
) {
  const active = document.activeElement;
  if (active && active !== document.body) {
    event.preventDefault();
    return;
  }
  const to = returnFocusTo?.current;
  if (!to || !to.isConnected || interactedOutside) return;
  event.preventDefault();
  to.focus({ preventScroll: true });
}
