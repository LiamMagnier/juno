"use client";

import * as React from "react";

/**
 * The keyboard half of the ARIA radio pattern.
 *
 * `role="radiogroup"` is a promise to a keyboard or screen-reader user: the
 * group is ONE tab stop, arrows move between the options, Home/End reach the
 * ends. Five groups on this surface make that promise — Theme, Accent colour,
 * Response style, Read-aloud voice and the connector policy — and only the last
 * kept it. The other four gave every option its own tab stop and ignored the
 * arrow keys, so Tab walked through thirteen voices one at a time while the keys
 * a radiogroup is meant to respond to did nothing.
 *
 * This is the logic PermissionsSection had already written, lifted so all five
 * share it. Arrow keys move focus and select in the same gesture, per the
 * pattern, so what is focused is always what is announced as checked.
 *
 * @param items         The options, in DOM order.
 * @param selectedIndex Index of the checked option, or -1 while none is.
 * @param onSelect      Commit a new selection.
 * @returns `optionProps(index)` — spread onto each option element.
 */
export function useRadioGroup<T>(
  items: readonly T[],
  selectedIndex: number,
  onSelect: (item: T, index: number) => void
) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);

  const move = (index: number) => {
    refs.current[index]?.focus();
    onSelect(items[index], index);
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = items.length - 1;
    if (last < 0) return;
    let next: number;
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        next = index === last ? 0 : index + 1;
        break;
      case "ArrowUp":
      case "ArrowLeft":
        next = index === 0 ? last : index - 1;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      default:
        return;
    }
    event.preventDefault();
    move(next);
  };

  return (index: number) => ({
    ref: (node: HTMLButtonElement | null) => {
      refs.current[index] = node;
    },
    // Roving tabindex: the checked option is the one Tab lands on. When nothing
    // is checked the first option takes the stop — otherwise the roving rule
    // would give the group no tab stop at all and strand it.
    tabIndex: index === (selectedIndex < 0 ? 0 : selectedIndex) ? 0 : -1,
    onKeyDown: (event: React.KeyboardEvent) => onKeyDown(event, index),
  });
}
