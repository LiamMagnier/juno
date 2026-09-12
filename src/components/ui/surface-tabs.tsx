"use client";

import * as React from "react";
import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";

import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * LEVEL 2 — which view of a product you are looking at.
 *
 * The shell has exactly three levels of choice and each one is drawn in its
 * own material, so a glance says which control does what:
 *
 *   1 · which product   → the sidebar's `<ProductSwitch>`: a bounded, hairline
 *                          pill with a tonal `--sidebar-accent` thumb. The ONLY
 *                          bounded track in the shell.
 *   2 · which view      → this: labels on the page ground with one 2px accent
 *                          bar under the active one, sitting on the single rule
 *                          that closes the page header. No box, no fill, no key.
 *   3 · which slice     → chips (`Pressable kind="chip"`, e.g. the triage bar).
 *
 * Work's four-tab nav and Code's tab nav used to be drawn in the SAME
 * inset-well-plus-raised-key material as the product switch, 100px apart on
 * `/work`, which meant nothing on screen said which control leaves the product
 * and which changes the view. That is the bug this primitive exists to close;
 * it replaces two hand-rolled forks (WorkNav's `offsetLeft`/`ResizeObserver`
 * thumb placement, CodeSurfaceNav's duplicated track with no travel at all).
 *
 * LINKS, NOT TABS. Every destination is a URL somebody can bookmark, ⌘-click,
 * hover-preview and restore from history — the whole reason both callers used
 * anchors. A `<Tabs>` root would promise `role="tablist"` semantics over
 * separate routes, so the contract here is `<nav>` + `aria-current="page"`, the
 * same one `NavRow` and `ProductSwitch` use.
 */
export type SurfaceTab = {
  href: string;
  label: string;
  /** Optional native tooltip — one line on what the view holds. */
  title?: string;
};

export function SurfaceTabs({
  tabs,
  activeHref,
  ariaLabel,
  className,
}: {
  tabs: readonly SurfaceTab[];
  /** `null` while no tab owns the route (a detail page under the surface). */
  activeHref: string | null;
  ariaLabel: string;
  className?: string;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  // `layoutId` is global to the page: two tab rows on screen at once (or the
  // sidebar's product thumb) must never share one, or the bar tries to fly
  // between them.
  const barId = `${React.useId()}-tab-bar`;

  return (
    <nav aria-label={ariaLabel} className={cn("border-b border-border", className)}>
      {/* `-mb-px` drops the row onto the nav's own rule so the active bar and
          the baseline read as one line rather than two 1px strokes 2px apart.
          The row scrolls sideways on a narrow window rather than compressing
          its last label into a chip. */}
      <ul
        role="list"
        className="-mb-px flex items-center gap-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const active = tab.href === activeHref;
          return (
            <li key={tab.href} className="relative shrink-0">
              <Link
                href={tab.href}
                title={tab.title}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "relative block whitespace-nowrap rounded-control px-3 py-2 text-ui font-medium",
                  "transition-colors duration-fast ease-out-soft motion-reduce:transition-none coarse:py-3",
                  // Focus is the global `outline: 2px solid --ring` (globals.css).
                  // WorkNav used to add a second, differently shaped
                  // `ring-2 ring-offset-2` on top of it; two rings on one
                  // element is a bug, not emphasis.
                  active
                    ? "text-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                {tab.label}
              </Link>
              {active && (
                // `--primary`, deliberately: FLAT_UI §2.4 names the accent as
                // "the selected mark". Level 1 is tonal, level 2 is accent —
                // two levels, two languages, no ambiguity about which is which.
                <motion.span
                  layoutId={barId}
                  aria-hidden="true"
                  transition={reduceMotion ? { duration: 0 } : spring.standard}
                  className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-primary"
                />
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
