"use client";

import * as React from "react";

const subscribeNever = () => () => {};

/**
 * The locale a price is formatted and labelled in: the document's own
 * `<html lang>`, which the root layout resolves on the server from the stored
 * interface language or Accept-Language. The server snapshot is "en", so the
 * first (hydrating) render matches the server's and the localized figure lands
 * on the next commit rather than as a hydration mismatch.
 *
 * The French and German price labels are written by hand in price-display.ts,
 * not machine-translated, because "TTC" and "inkl. MwSt." are legal wording.
 */
export function usePriceLocale(): string {
  return React.useSyncExternalStore(
    subscribeNever,
    () => (typeof document === "undefined" ? "en" : document.documentElement.lang || "en"),
    () => "en"
  );
}
