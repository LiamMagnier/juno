"use client";

import * as React from "react";

/**
 * The command palette, fetched when something asks for it rather than with the
 * shell.
 *
 * WHY THIS FILE EXISTS. `command-palette.tsx` is the largest single component
 * in the app shell, and the shell is `(app)/layout.tsx` — so every app route
 * paid for it before it could hydrate, including the ones whose whole job is
 * to appear quickly. It is also, by definition, not on screen at first paint:
 * it is two dialogs that open on ⌘K, on the magnifying glass, or on one of
 * four events.
 *
 * WHY NOT `next/dynamic`. `next/dynamic` moves a component out of the entry
 * bundle but still fetches its chunk as soon as the component renders — and
 * this one has to render from the start, because it owns the keyboard
 * shortcuts that open it. Mounted unconditionally it would download on every
 * page load anyway, a few hundred milliseconds later. The listeners are the
 * cheap part; the dialogs are the expensive part, so the listeners live here
 * and the dialogs arrive when a listener fires.
 *
 * NOTHING IS LOST. Every trigger the palette answers to is re-dispatched
 * against the real component once it mounts, so a ⌘K pressed before the chunk
 * existed opens the menu rather than being swallowed. React runs a child's
 * effects before its parent's, so by the time the replay below runs the
 * palette's own listeners are already registered.
 */

type Palette = typeof import("@/components/app/command-palette");

/**
 * The chords `CommandMenu` binds (command-palette.tsx). Kept in step with it
 * and with use-global-shortcuts.ts — a chord listed there and missing here is
 * a shortcut that does nothing until the palette happens to be loaded.
 */
function isPaletteChord(e: KeyboardEvent): boolean {
  if (!(e.metaKey || e.ctrlKey)) return false;
  const key = e.key.toLowerCase();
  // ⌘K command menu · ⌘⇧O new chat · ⌘/ shortcuts sheet
  return key === "k" || (e.shiftKey && key === "o") || e.key === "/";
}

/** The events the two surfaces open on. */
const TRIGGER_EVENTS = [
  "juno:command-palette",
  "juno:shortcuts",
  "juno:search",
  // ⌘⇧L lands in the palette too: it is the one place the theme toggle also
  // writes the setting back (command-palette.tsx).
  "juno:toggle-theme",
] as const;

export function CommandPaletteLazy() {
  const [Loaded, setLoaded] = React.useState<Palette["CommandPalette"] | null>(null);
  // The trigger that arrived before the chunk did, replayed once it lands.
  const pending = React.useRef<Event | null>(null);
  const request = React.useRef<Promise<Palette> | null>(null);

  const load = React.useCallback(() => {
    request.current ??= import("@/components/app/command-palette").then((mod) => {
      // The updater form, because the value IS a component: passing it
      // directly would have React call it as a lazy initialiser.
      setLoaded(() => mod.CommandPalette);
      return mod;
    });
    return request.current;
  }, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isPaletteChord(e)) return;
      // The real handler prevents default on all three chords; do it here too
      // or the browser's own ⌘K / ⌘/ fires during the one keystroke that has
      // to wait for a network round trip.
      e.preventDefault();
      if (Loaded) return;
      pending.current = new KeyboardEvent("keydown", {
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        shiftKey: e.shiftKey,
      });
      void load();
    };
    const onTrigger = (e: Event) => {
      if (Loaded) return;
      pending.current = new CustomEvent(e.type);
      void load();
    };

    window.addEventListener("keydown", onKey);
    for (const name of TRIGGER_EVENTS) window.addEventListener(name, onTrigger);
    return () => {
      window.removeEventListener("keydown", onKey);
      for (const name of TRIGGER_EVENTS) window.removeEventListener(name, onTrigger);
    };
  }, [Loaded, load]);

  /*
   * Warm the chunk once the page has gone quiet.
   *
   * Without this the first ⌘K of a session waits on a network round trip; with
   * it the fetch happens while nothing else is competing for the connection,
   * which is the whole point of not having fetched it during load. `idle`
   * rather than a timer where the browser has it, so it yields to anything the
   * page is still doing.
   */
  React.useEffect(() => {
    if (Loaded) return;
    const idle = (window as unknown as {
      requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    }).requestIdleCallback;
    if (idle) {
      const handle = idle(() => void load(), { timeout: 4000 });
      const cancel = (window as unknown as {
        cancelIdleCallback?: (h: number) => void;
      }).cancelIdleCallback;
      return () => cancel?.(handle);
    }
    const timer = window.setTimeout(() => void load(), 2500);
    return () => window.clearTimeout(timer);
  }, [Loaded, load]);

  // Runs after the palette's own effects have registered its listeners, so the
  // replay is never dispatched into a window that is not listening yet.
  React.useEffect(() => {
    if (!Loaded || !pending.current) return;
    const event = pending.current;
    pending.current = null;
    window.dispatchEvent(event);
  }, [Loaded]);

  return Loaded ? <Loaded /> : null;
}
