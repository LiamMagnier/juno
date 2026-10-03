"use client";

import * as React from "react";
import { Construction } from "@/components/home/construction";

/**
 * The homepage's construction (nested orbits at a 1.5 ratio on an ℵ number
 * line, one presence trajectory) as a faint backdrop behind a product page's
 * header: the owner's favourite thing about the homepage, "that background
 * that mix space & mathematics", carried into the app.
 *
 * One drawing for every page, so they all share it exactly: the dot matrix
 * (dot-construction.tsx) behind the header's text (an isolated stacking
 * context on the header), its origin right of the title column, quieter than
 * on the homepage, faded out towards the page body so it never sits behind
 * content people read. It draws itself on once on arrival, ring by ring, then
 * only sways; no trajectory and no ticks (the homepage's live frame keeps
 * those), no pointer parallax. Still under reduced motion. Decorative.
 */
export function PageBackdrop() {
  return (
    <div aria-hidden="true" className="page-backdrop alv pointer-events-none absolute -inset-x-16 -top-20 -z-10 h-[15rem] overflow-hidden">
      <div className="page-backdrop__drawing">
        <Construction ticks={false} trajectory={false} />
      </div>
    </div>
  );
}
