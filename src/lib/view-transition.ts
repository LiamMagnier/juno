"use client";

import type * as React from "react";

/**
 * Same-document View Transitions for the two moves that most need to say
 * "you went in": a list row opening its thread, and an artifact going from
 * its docked canvas to full screen and back.
 *
 * The browser snapshots the page, the update runs, and the old view leaves
 * while the new one arrives (globals.css, `html[data-vt]`): the old fades out
 * at about 0.65x the entrance on the accelerate curve, the new fades in and
 * rises a few pixels. The rise is multiplied by --motion-shift, so under
 * reduced motion (the OS, Settings › Motion › Reduced) the same transition is
 * a plain crossfade, never a cut. Where the API is missing the update simply
 * runs, as it always did.
 *
 * A route change cannot be awaited directly in the App Router, so the update
 * callback pushes the route and resolves when PageTransition reports the new
 * pathname committed, or after ROUTE_WAIT_MS, whichever comes first: the page
 * is frozen on its snapshot while it waits, and a slow server must not hold it
 * there. The chat routes have loading states, so the commit is normally a
 * frame or two away.
 */

export type ViewTransitionKind = "thread" | "canvas";

/**
 * Which way a transition goes, for the moves whose two directions are timed
 * differently. The canvas opens over the slow rung on out-expo and closes over
 * the base rung on the accelerate (globals.css, `html[data-vt-dir="close"]`).
 */
export type ViewTransitionDirection = "open" | "close";

/**
 * The longest a route change may hold the page on its snapshot (spec D23,
 * C18): 80ms. While it waits, the whole window is a frozen picture that does
 * not answer the pointer, so this is a ceiling on a freeze, not a pacing
 * choice. It was 450, which on a slow server held the window still for
 * almost half a second after every sidebar click.
 */
export const ROUTE_WAIT_MS = 80;

let running = false;
const routeWaiters = new Set<(pathname: string) => void>();

export function supportsViewTransitions(): boolean {
  return typeof document !== "undefined" && typeof document.startViewTransition === "function";
}

/** A view transition is animating (other entrances stand down so nothing fades twice). */
export function viewTransitionActive(): boolean {
  return running;
}

/**
 * Runs `update` inside a view transition of `kind`, or plainly where the API is
 * missing or another transition is already running. `dir` stamps
 * `html[data-vt-dir]` for the length of the transition, so a move whose close
 * is timed apart from its open (the canvas) gets its own exit; without it the
 * close replayed the open.
 */
export function withViewTransition(
  kind: ViewTransitionKind,
  update: () => void | Promise<void>,
  options: { dir?: ViewTransitionDirection } = {},
): Promise<void> {
  if (!supportsViewTransitions() || running) return Promise.resolve(update()).then(() => undefined);
  const root = document.documentElement;
  const clear = () => {
    running = false;
    if (root.dataset.vt === kind) delete root.dataset.vt;
    delete root.dataset.vtDir;
  };
  root.dataset.vt = kind;
  if (options.dir) root.dataset.vtDir = options.dir;
  else delete root.dataset.vtDir;
  running = true;
  let transition: ViewTransition;
  try {
    transition = document.startViewTransition(update);
  } catch {
    clear();
    return Promise.resolve(update()).then(() => undefined);
  }
  return transition.finished.catch(() => undefined).finally(clear);
}

/** Called by PageTransition when a pathname has committed. */
export function notifyRouteCommitted(pathname: string): void {
  for (const waiter of [...routeWaiters]) waiter(pathname);
}

/** Pushes `href` inside a view transition of `kind`. */
export function navigateWithViewTransition(router: { push(href: string): void }, href: string, kind: ViewTransitionKind = "thread"): void {
  const target = new URL(href, window.location.href).pathname;
  if (!supportsViewTransitions() || target === window.location.pathname) {
    router.push(href);
    return;
  }
  void withViewTransition(
    kind,
    () =>
      new Promise<void>((resolve) => {
        let timer = 0;
        const finish = () => {
          routeWaiters.delete(onRoute);
          window.clearTimeout(timer);
          resolve();
        };
        const onRoute = (pathname: string) => {
          if (pathname === target) finish();
        };
        routeWaiters.add(onRoute);
        timer = window.setTimeout(finish, ROUTE_WAIT_MS);
        router.push(href);
      }),
  );
}

/**
 * For a list row's link: a plain primary click opens `href` inside a view
 * transition; a modified click (new tab, new window) and browsers without the
 * API keep the link's own behaviour. Returns true when it took the click.
 */
export function openWithViewTransition(
  event: React.MouseEvent<HTMLAnchorElement>,
  router: { push(href: string): void },
  href: string,
  kind: ViewTransitionKind = "thread",
): boolean {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
  if (!supportsViewTransitions()) return false;
  event.preventDefault();
  navigateWithViewTransition(router, href, kind);
  return true;
}
