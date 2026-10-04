"use client";

import * as React from "react";

/**
 * A handler whose identity never changes but which always calls the newest
 * function passed in. `undefined` stays `undefined`, so an absent handler can
 * still hide its control.
 *
 * For EVENT handlers only (clicks, submits, key presses) — never for a value
 * read during render. Exists because the chat's handlers come from use-chat,
 * whose callbacks close over the hook's options object and the message array:
 * every streamed token made new functions, and every memoised child below the
 * chat (the composer, each settled transcript row) re-rendered once per token
 * to receive them (docs/rework/program/PERFORMANCE.md). A click reads the
 * newest closure either way.
 */
export function useLatestHandler<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R;
export function useLatestHandler<A extends unknown[], R>(handler: ((...args: A) => R) | undefined): ((...args: A) => R) | undefined;
export function useLatestHandler<A extends unknown[], R>(handler: ((...args: A) => R) | undefined): ((...args: A) => R) | undefined {
  const ref = React.useRef(handler);
  React.useLayoutEffect(() => {
    ref.current = handler;
  });
  const stable = React.useCallback((...args: A) => ref.current!(...args), []);
  return handler ? stable : undefined;
}
