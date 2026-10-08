"use client";

import * as React from "react";

/*
 * The homepage's one scroll reveal (owner, 2026-10-08: "make the animation of
 * homepage fade"). Every section below the hero fades up into place the first
 * time it reaches the reader: opacity, 14 px of rise and a 4 px blur clearing,
 * 760 ms on the long decelerate, its parts staggered 80 ms apart.
 *
 * It is written on `filter` (opacity() + blur()) and `translate`, never on
 * `opacity` or `transform`, so it multiplies with the motion the sections
 * already own (the showcase's scene cross-fades, the sequences' pops, the
 * hover lifts) instead of fighting them for one property.
 *
 * Progressive and flash-free: the server HTML is fully visible; only parts
 * still below the fold when this runs are held back, so nothing on screen at
 * hydration blinks out and back. Reduced motion: nothing is held, nothing moves.
 */

const SKIP = ".alv-showcase-scene, .alv-pop, .alv-word, .alv-hero";
const STAGGER_MS = 80;
const MAX_STAGGER = 6;

/** A section's reveal parts: each child of its column, and the cells of a grid inside it. */
function partsOf(section: Element): HTMLElement[] {
  const out: HTMLElement[] = [];
  const add = (el: Element) => {
    if (el instanceof HTMLElement && !el.matches(SKIP) && el.getClientRects().length) out.push(el);
  };
  for (const child of Array.from(section.children)) {
    if (!child.classList.contains("alv-col")) {
      add(child);
      continue;
    }
    for (const part of Array.from(child.children)) {
      const cells = Array.from(part.children);
      // A grid or list of like parts (bento cells, ledger rows, trust items) reveals cell by cell.
      const isGrid = cells.length >= 3 && cells.length <= 12 && cells.every((c) => /^(ARTICLE|DIV|LI|FIGURE)$/.test(c.tagName));
      if (isGrid && !part.matches(SKIP)) cells.forEach(add);
      else add(part);
    }
  }
  return out;
}

export function HomeReveal() {
  React.useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (typeof IntersectionObserver === "undefined") return;
    const main = document.querySelector(".alv main");
    if (!main) return;
    const fold = window.innerHeight * 0.92;
    const held: HTMLElement[] = [];
    for (const section of Array.from(main.children)) {
      if (section.matches(".alv-hero")) continue;
      partsOf(section).forEach((el, i) => {
        if (el.getBoundingClientRect().top < fold) return;
        el.style.setProperty("--alv-reveal-delay", `${Math.min(i, MAX_STAGGER) * STAGGER_MS}ms`);
        el.dataset.reveal = "";
        held.push(el);
      });
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          el.dataset.reveal = "on";
          io.unobserve(el);
          // Drop the filter once it has run: a resting filter is a layer kept for nothing.
          window.setTimeout(() => {
            delete el.dataset.reveal;
            el.style.removeProperty("--alv-reveal-delay");
          }, 1400);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 },
    );
    held.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);
  return null;
}
