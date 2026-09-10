"use client";

/**
 * KaTeX's stylesheet, mounted where maths can actually appear.
 *
 * `katex.min.css` (24 KB) was imported from the root layout, so the landing,
 * the sign-in card and the legal pages — none of which render a formula —
 * paid for it on every visit. The markdown renderer is where the dependency
 * belongs, but that module is not this change's to edit; this is the
 * smallest client-side seam that lets the app shell own the import instead.
 * Render it once, from the signed-in layout. It draws nothing.
 */
import "katex/dist/katex.min.css";

export function KatexStyles() {
  return null;
}
