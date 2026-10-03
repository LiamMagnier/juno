"use client";

import * as React from "react";
import { Construction } from "@/components/home/construction";

/**
 * The homepage's construction (nested orbits at a 1.5 ratio on an ℵ number
 * line, one presence trajectory) as a faint backdrop behind a product page's
 * header: the owner's favourite thing about the homepage, "that background
 * that mix space & mathematics", carried into the app.
 *
 * One drawing for every page, so they all share it exactly. It sits behind the
 * header's text (an isolated stacking context on the header), centred on the
 * right of the title column, quieter than on the homepage, and fades out
 * towards the page body so it never sits behind content people read. It draws
 * itself once on arrival (the homepage's own `alv-draw`), and rests under
 * reduced motion. Decorative: hidden from assistive technology.
 */
export function PageBackdrop() {
  return (
    <div aria-hidden="true" className="page-backdrop alv pointer-events-none absolute -inset-x-16 -top-20 -z-10 h-[15rem] overflow-hidden">
      <div className="page-backdrop__drawing">
        <Construction />
      </div>
    </div>
  );
}
