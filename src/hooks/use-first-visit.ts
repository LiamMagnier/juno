"use client";

import * as React from "react";
import { FIRST_VISIT_ATTR } from "@/lib/ui-prefs";

/**
 * Whether this page load is the first of the browser session (spec C3): the
 * one editorial entrance, the 560ms greeting clip-wipe, plays only then.
 *
 * The ui-prefs boot script decides it before first paint, from
 * sessionStorage inside try/catch, and writes `html[data-first-visit]`; this
 * hook only reads that attribute, so CSS and React agree and a hydration
 * never disagrees with the server (which renders false: no entrance is the
 * safe default, and the CSS keyed on the attribute has already played it).
 */
export function readFirstVisit(root: Element | null = typeof document === "undefined" ? null : document.documentElement): boolean {
  return root?.hasAttribute(FIRST_VISIT_ATTR) ?? false;
}

const subscribe = () => () => {};
const serverSnapshot = () => false;

export function useFirstVisit(): boolean {
  return React.useSyncExternalStore(subscribe, () => readFirstVisit(), serverSnapshot);
}
