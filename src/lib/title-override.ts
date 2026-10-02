/**
 * A temporary document title that outranks the page's own (SPEC §9.8, §9.13).
 *
 * `DocumentTitle` re-applies its computed title on every `<head>` mutation, so
 * a direct `document.title =` is reverted in the same task. Anything that needs
 * the tab to say something else for a while — "Report ready" while the tab is
 * hidden, the report's title while it prints — sets an override here under its
 * own key, and `DocumentTitle` renders `override ?? computed`. Clearing a key
 * hands the title back to whichever override was set before it, or to the page.
 *
 * A tiny external store: module state, a listener set, `useSyncExternalStore`.
 */

import * as React from "react";

/** Insertion order is recency: a key that is set again moves to the end. */
const overrides = new Map<string, string>();
const listeners = new Set<() => void>();
let current: string | null = null;

function publish() {
  const next = [...overrides.values()].at(-1) ?? null;
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

/** Sets (or, with `null`, clears) the override held under `key`. The most recently set one wins. */
export function setTitleOverride(key: string, text: string | null): void {
  overrides.delete(key);
  if (text !== null && text !== "") overrides.set(key, text);
  publish();
}

/** The winning override, outside React. */
export function getTitleOverride(): string | null {
  return current;
}

export function subscribeTitleOverride(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The winning override, or null. Null during server rendering and hydration. */
export function useTitleOverride(): string | null {
  return React.useSyncExternalStore(subscribeTitleOverride, getTitleOverride, () => null);
}
