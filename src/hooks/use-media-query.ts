"use client";

import * as React from "react";

/**
 * A media query as state, through `useSyncExternalStore` so a render never
 * reads a value the query has already moved past. `false` on the server and
 * in the first client render, which is the desktop default every caller here
 * is written to degrade to.
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = React.useCallback(
    (notify: () => void) => {
      if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", notify);
      return () => list.removeEventListener("change", notify);
    },
    [query],
  );
  const read = React.useCallback(
    () => (typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(query).matches : false),
    [query],
  );
  return React.useSyncExternalStore(subscribe, read, () => false);
}

/** Phone width: where a popover or a docked panel becomes a bottom sheet. */
export const PHONE_QUERY = "(max-width: 639px)";
