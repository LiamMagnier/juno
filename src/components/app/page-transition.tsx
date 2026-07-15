"use client";

import * as React from "react";
import { usePathname } from "next/navigation";

/**
 * Cross-route fade for the app shell's content area.
 *
 * Two deliberate constraints, both load-bearing:
 *
 * 1. OPACITY ONLY — no translate/scale. `model-selector` and `canvas-panel`
 *    position themselves `fixed`, and any transform on an ancestor turns it into
 *    a containing block, which would re-anchor them to this wrapper mid-flight.
 *
 * 2. KEYED ON THE FIRST SEGMENT, not the full pathname. Changing the key
 *    remounts the subtree, and chat-view does `router.replace('/chat/<id>')`
 *    right after a brand-new chat's first reply — keying on the full path would
 *    remount the chat mid-stream and drop it (the exact failure its own comment
 *    warns about). `/chat` → `/chat/abc` therefore keeps one key and does not
 *    animate; `/chat` → `/settings` does.
 */
function routeGroup(pathname: string): string {
  return "/" + (pathname.split("/")[1] ?? "");
}

export function PageTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={routeGroup(pathname)} className="h-full motion-safe:animate-page-in">
      {children}
    </div>
  );
}
