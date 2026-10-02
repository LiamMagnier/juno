/**
 * Locking every loop to the page clock (SPEC §7.9 "Phase lock"): the glyph,
 * the shimmer and the markers each write their own `--loop-phase` from
 * `document.timeline.currentTime`, so they start together and read as one
 * gesture. WS0 lands the signature; WS5 implements it.
 */

import type { RefObject } from "react";

export function usePhaseLock(_ref: RefObject<HTMLElement | null>, _periodMs: number): void {
  throw new Error("not implemented: WS5");
}
