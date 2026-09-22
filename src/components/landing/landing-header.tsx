"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * The landing's sticky bar, which wears its material only once there is
 * something under it.
 *
 * At rest the bar is the page: no fill, no hairline, no blur, so the hero's
 * wash and dot field run up to the top of the window unbroken. The moment the
 * document scrolls, content starts passing beneath it and the bar takes the
 * ground at 85% over a 12px blur with one bottom hairline, the flat header
 * Claude and ChatGPT wear. No float shadow either way: a sticky header is
 * chrome that stays on the page, not a layer that leaves it.
 *
 * The switch is an IntersectionObserver on an 8px sentinel pinned to the top
 * of the document, never a scroll listener: the browser reports one crossing,
 * not a stream of frames. Colour, edge and blur cross-fade on the base rung;
 * none of them travel, so reduced motion keeps the same fade.
 *
 * Only the frame is client code. The bar's contents (logo, section links,
 * account buttons, the phone menu) arrive as server-rendered children.
 */
export function LandingHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  const sentinelRef = React.useRef<HTMLSpanElement>(null);
  const [scrolled, setScrolled] = React.useState(false);

  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting));
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  return (
    <>
      <span ref={sentinelRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-2" />
      <header
        data-scrolled={scrolled ? "" : undefined}
        className={cn(
          "sticky top-0 z-toolbar border-b border-transparent",
          "transition-[background-color,border-color,backdrop-filter] duration-base ease-out-soft",
          "data-[scrolled]:border-border data-[scrolled]:bg-background/85 data-[scrolled]:backdrop-blur-md",
          // Without script the observer never runs, so the bar keeps its
          // material from the start rather than leaving the section links
          // floating unbacked over the content scrolling beneath them.
          "[@media(scripting:none)]:border-border [@media(scripting:none)]:bg-background/85 [@media(scripting:none)]:backdrop-blur-md",
          className
        )}
      >
        {children}
      </header>
    </>
  );
}
