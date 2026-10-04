"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

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
 *    `transform` behind when it finishes (constraint 1 still holds) and never
 *    runs under reduced motion.
 */
export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const group = routeGroup(pathname ?? "/");
  const ref = React.useRef<HTMLDivElement>(null);
  const previous = React.useRef(group);
  React.useLayoutEffect(() => {
    if (previous.current === group) return;
    previous.current = group;
    const el = ref.current;
    if (!el || typeof el.animate !== "function") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const style = getComputedStyle(document.documentElement);
    const duration = parseFloat(style.getPropertyValue("--dur-exit")) || 160;
    const easing = style.getPropertyValue("--ease-out-soft").trim() || "ease-out";
    const shift = parseFloat(style.getPropertyValue("--motion-shift"));
    const rise = 6 * (Number.isFinite(shift) ? shift : 1);
    const animation = el.animate(
      [{ opacity: 0, transform: `translateY(${rise}px)` }, { opacity: 1, transform: "none" }],
      { duration, easing },
    );
    return () => animation.cancel();
  }, [group]);
  return <div ref={ref} className="h-full">{children}</div>;
}
