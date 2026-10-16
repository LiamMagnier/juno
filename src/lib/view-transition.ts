"use client";

import type * as React from "react";
import { markRouteClick } from "@/lib/perf-marks";

/**
 * Same-document View Transitions for the two moves that most need to say
 * "you went in": a list row opening its thread, and an artifact going from
 * its docked canvas to full screen and back (spec D23, C18).
 *
 * The browser snapshots the page, the update runs, and only the named group
 * animates (globals.css, `html[data-vt]`, owned by P1): the root swaps
 * instantly, the `app-page` group fades out over 120 and in over 160 with a
 * 4px × shift rise, and the canvas group travels over 360 opening and 220
 * closing (`html[data-vt-dir="close"]`, which this file sets). Under reduced
 * motion the CSS plays a 160 cross-fade, never a cut. Where the API is
 * missing the update simply runs, as it always did. No signature moment
 * depends on the API (D23).
 *
 * A route change cannot be awaited directly in the App Router, so the update
 * callback pushes the route and resolves when PageTransition reports the new
 * pathname committed, or after ROUTE_WAIT_MS, whichever comes first: the page
 * is frozen on its snapshot while it waits, and a slow server must not hold it
 * there. 80ms keeps a route click inside the 100ms shell budget (spec §9);
 * the chat routes have loading states, so the commit is normally a frame or
 * two away.
 *
 * Marks: every navigation started here records `alevr:route-click`, and
 * PageTransition records `alevr:shell-visible` when the new path paints.
 */

export type ViewTransitionKind = "thread" | "canvas";
export type ViewTransitionDirection = "open" | "close";

/** The longest a route change may hold the page on its snapshot (spec D23). */
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
 * missing or another transition is already running. `dir: "close"` marks a
 * closing move (the canvas leaving full screen), which the CSS plays on the
 * shorter exit rung.
 */
export function withViewTransition(
  kind: ViewTransitionKind,
  update: () => void | Promise<void>,
  { dir = "open" }: { dir?: ViewTransitionDirection } = {},
): Promise<void> {
  if (!supportsViewTransitions() || running) return Promise.resolve(update()).then(() => undefined);
  const root = document.documentElement;
  root.dataset.vt = kind;
  if (dir === "close") root.dataset.vtDir = "close";
  else delete root.dataset.vtDir;
  running = true;
  const clear = () => {
    running = false;
    if (root.dataset.vt === kind) delete root.dataset.vt;
    delete root.dataset.vtDir;
  };
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
  markRouteClick(target);
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
  if (!supportsViewTransitions()) {
    // The Link navigates on its own; the click is still the start of the route budget.
    if (typeof window !== "undefined") markRouteClick(new URL(href, window.location.href).pathname);
    return false;
  }
  event.preventDefault();
  navigateWithViewTransition(router, href, kind);
  return true;
}
