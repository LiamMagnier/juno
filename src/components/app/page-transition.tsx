"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/**
 * Cross-route entrance for the app shell's content area: `pop-in` (scale
 * .96→1 + fade on the spring), the same entrance every floating layer has.
 *
 * Two deliberate constraints, both load-bearing:
 *
 * 1. THE CLASS IS DROPPED ONCE THE ANIMATION ENDS. `pop-in` fills `both`, and
 *    its final frame is still a `transform` (`translateY(0) scale(1)`), which
 *    makes this wrapper a containing block for every `fixed` descendant —
 *    the fullscreen canvas would anchor to it instead of the viewport. So the
 *    class exists for exactly one run; `animationend` takes it away. Under
 *    reduced motion the class is never applied (`motion-safe:`), so nothing
 *    is left waiting for an event that will not fire.
 *
 * 2. KEYED ON THE FIRST SEGMENT, not the full pathname. Changing the key
 *    remounts the subtree, and chat-view does `router.replace('/chat/<id>')`
 *    right after a brand-new chat's first reply — keying on the full path would
 *    remount the chat mid-stream and drop it. `/chat` → `/chat/abc` therefore
 *    keeps one key and does not animate; `/chat` → `/settings` does.
 */
function routeGroup(pathname: string): string {
  return "/" + (pathname.split("/")[1] ?? "");
}

function Entrance({ children }: { children: React.ReactNode }) {
  const [settled, setSettled] = React.useState(false);
  return (
    <div
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setSettled(true);
      }}
      className={cn("h-full [--pop-shift:6px]", !settled && "motion-safe:animate-pop-in")}
    >
      {children}
    </div>
  );
}

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return <Entrance key={routeGroup(pathname)}>{children}</Entrance>;
}
