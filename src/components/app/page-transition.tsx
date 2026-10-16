"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { DURATION } from "@/lib/design/tokens.generated";
import { markRouteClick, markShellVisible } from "@/lib/perf-marks";

/**
 * The pathname a click navigates to inside the app, or null: a plain primary
 * click on a same-origin link to another path (a modified click opens a tab,
 * and a hash or same-path link is not a route change).
 */
export function routeClickTarget(
  event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "defaultPrevented" | "target">,
  location: Pick<Location, "origin" | "pathname" | "href">,
): string | null {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;
  const target = event.target as Element | null;
  const anchor = target && typeof target.closest === "function" ? target.closest("a[href]") : null;
  if (!anchor || anchor.getAttribute("target") === "_blank" || anchor.hasAttribute("download")) return null;
  try {
    const url = new URL(anchor.getAttribute("href")!, location.href);
    if (url.origin !== location.origin || url.pathname === location.pathname) return null;
    return url.pathname;
  } catch {
    return null;
  }
}
import { notifyRouteCommitted, viewTransitionActive } from "@/lib/view-transition";

/** The fallback entrance (spec P2 (18)): 160 opacity, plus a 6px rise only while motion is allowed. */
export const PAGE_ENTRANCE = { durationMs: DURATION.exit, risePx: 6 } as const;

/**
 * The WAAPI keyframes for the entrance. The rise is multiplied by
 * --motion-shift, which reduced motion zeroes, and the last frame is
 * `transform: none` with no fill, so nothing is left behind (constraint 1).
 */
export function pageEntranceKeyframes(shift: number): Keyframe[] {
  const rise = PAGE_ENTRANCE.risePx * (Number.isFinite(shift) ? shift : 1);
  return rise === 0
    ? [{ opacity: 0 }, { opacity: 1 }]
    : [{ opacity: 0, transform: `translateY(${rise}px)` }, { opacity: 1, transform: "none" }];
}

/**
 * Cross-route entrance for the app shell's content area: a 160ms crossfade
 * with a 6px rise (`rise-in` on the `--dur-exit` rung). Switching Chat ⇄ Work
 * or Chat ⇄ Code is a segmented control moving a thumb, and the content behind
 * it should answer in the same register — a quick settle, not a hard cut and
 * not the scaled pop a floating layer makes when it opens.
 *
 * Two deliberate constraints, both load-bearing:
 *
 * 1. THE CLASS IS DROPPED ONCE THE ANIMATION ENDS. `rise-in` leaves a
 *    `transform` (`translateY(0)`) on its final frame, which
 *    makes this wrapper a containing block for every `fixed` descendant —
 *    the fullscreen canvas would anchor to it instead of the viewport. So the
 *    class exists for exactly one run; `animationend` takes it away. Under
 *    reduced motion the class is never applied (`motion-safe:`), so nothing
 *    is left waiting for an event that will not fire.
 *
 * 2. SOFT SURFACES ARE KEYED ON THEIR FIRST SEGMENT; everything else on its
 *    first two. Changing the key remounts the subtree. Chat, Code, Work and
 *    Design rewrite their own URL while they run (chat-view does
 *    `router.replace('/chat/<id>')` right after a brand-new chat's first
 *    reply), and Settings swaps its section in place, so on those a key per
 *    path would remount the surface mid-stream and drop it: `/chat` to
 *    `/chat/abc` keeps one key and does not animate. Every other page is a
 *    list that opens a detail, and there the detail IS a new page. Keyed on
 *    the first segment alone, `/projects` to `/projects/abc` (and the same on
 *    Artifacts, Skills, Automations and Research) cut with no entrance at all,
 *    the one navigation in the product that most needs to say "you went in".
 */
const SOFT_SURFACES = new Set(["chat", "code", "work", "design", "settings"]);

function routeGroup(pathname: string): string {
  const segments = pathname.split("/");
  return SOFT_SURFACES.has(segments[1] ?? "") ? `/${segments[1]}` : `/${segments.slice(1, 3).join("/")}`;
}

/**
 * 3. THE SUBTREE IS NO LONGER REMOUNTED TO REPLAY IT (2026-10-04). It used to
 *    be: the wrapper was keyed on the route group, so every cross-group click
 *    (Chat → Projects, Orbit → an agent) threw away and rebuilt the whole page
 *    tree under the shell. Rebuilt Suspense boundaries are NEW boundaries, and
 *    React shows a new boundary's fallback even inside a navigation
 *    transition — then holds the real content back until 300 ms after that
 *    fallback appeared (its FALLBACK_THROTTLE_MS). Measured on a production
 *    build: Orbit → agent took ~400 ms with the server answering in ~20 ms
 *    (docs/rework/program/PERFORMANCE.md). Now the wrapper stays mounted and
 *    the same entrance is played with the Web Animations API, which leaves no
 *    `transform` behind when it finishes (constraint 1 still holds).
 *
 * 4. REDUCED MOTION IS A CROSSFADE, NOT A CUT. The rise is multiplied by
 *    --motion-shift, which the reduced tier zeroes, so the same call plays an
 *    opacity-only fade there (opacity is feedback, Tier A). It used to skip
 *    the entrance outright under the preference.
 *
 * 5. A VIEW TRANSITION OWNS ITS OWN NAVIGATION. A list row that opens its
 *    detail through lib/view-transition.ts (a recent chat, a project's chat)
 *    gets the browser's old-to-new crossfade, which has the exit this wrapper
 *    cannot give; the entrance here then stands down so the page is not
 *    faded twice.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const group = routeGroup(pathname ?? "/");
  const ref = React.useRef<HTMLDivElement>(null);
  const previous = React.useRef(group);
  // A view transition waiting on this route (a list row opening its thread)
  // takes its "after" snapshot once the new path has committed.
  // Every in-app link click starts the route budget (alevr:route-click), not
  // only the ones that run a view transition: one capture listener for the shell.
  React.useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const href = routeClickTarget(event, window.location);
      if (href) markRouteClick(href);
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
  const firstPath = React.useRef(true);
  React.useLayoutEffect(() => {
    if (!pathname) return;
    notifyRouteCommitted(pathname);
    // The route budget (spec §9): alevr:route-click → alevr:shell-visible.
    // The first commit is the page load, not a route change.
    if (firstPath.current) firstPath.current = false;
    else markShellVisible(pathname);
  }, [pathname]);
  React.useLayoutEffect(() => {
    if (previous.current === group) return;
    previous.current = group;
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    if (viewTransitionActive()) return;
    const style = getComputedStyle(document.documentElement);
    const duration = parseFloat(style.getPropertyValue("--dur-exit")) || PAGE_ENTRANCE.durationMs;
    const easing = style.getPropertyValue("--ease-out-soft").trim() || "ease-out";
    const shift = parseFloat(style.getPropertyValue("--motion-shift"));
    // 6 * (Number.isFinite(shift) ? shift : 1): see pageEntranceKeyframes.
    const animation = el.animate(pageEntranceKeyframes(shift), { duration, easing, fill: "none" });
    return () => animation.cancel();
  }, [group]);
  // `app-page`: the box a thread view transition names (globals.css), so the
  // page crossfades and rises while the sidebar beside it only crossfades.
  return <div ref={ref} className="app-page h-full">{children}</div>;
}
