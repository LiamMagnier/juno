"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

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

function Entrance({ children }: { children: React.ReactNode }) {
  const [settled, setSettled] = React.useState(false);
  return (
    <div
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setSettled(true);
      }}
      className={cn(
        "h-full",
        !settled && "motion-safe:animate-rise-in motion-safe:[animation-duration:var(--dur-exit)]",
      )}
    >
      {children}
    </div>
  );
}

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return <Entrance key={routeGroup(pathname)}>{children}</Entrance>;
}
