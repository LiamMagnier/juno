"use client";

import dynamic from "next/dynamic";

/*
 * The Activity panel as its own chunk (SPEC §8.3). chat-view mounts
 * `LazyActivityPanel` inside the right-column shell; the run block calls
 * `prefetchActivityPanel()` when a run in the view first starts working, so by
 * the time anyone opens the panel the chunk is already there and the first
 * open never shows a blank.
 */

const load = () => import("./activity-panel");

let prefetched: Promise<unknown> | null = null;

/** Starts loading the panel's chunk; safe to call on every render, it loads once. */
export function prefetchActivityPanel(): void {
  prefetched ??= load().catch(() => {
    // A failed prefetch is retried by the real load when the panel opens.
    prefetched = null;
  });
}

export const LazyActivityPanel = dynamic(() => load().then((module) => module.ActivityPanel), {
  ssr: false,
  loading: () => null,
});
