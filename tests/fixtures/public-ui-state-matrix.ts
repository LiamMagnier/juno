/**
 * Test-owned map of the web surfaces that can currently be checked without a
 * browser. Each state points at the production source that owns its semantics;
 * the matrix test reads those files and fails when the state loses its
 * accessibility or responsive contract.
 */

export const UI_STATE_FIXTURES = [
  {
    id: "empty",
    sources: ["src/components/chat/empty-state.tsx"],
    required: [
      /export function EmptyGreeting\(\)/,
      /<h1\b/,
      /How can I help/,
      // The V3 greeting: regular-weight serif, the name not set apart in italic.
      /font-serif text-display font-normal/,
    ],
    /*
     * The greeting arrives still (V3 foundations: no entrance animation), so it
     * owes reduced motion nothing and must not grow an animation back without
     * one. It used to require `motion-safe:` for its rise-in.
     */
    forbidden: [/className="[^"]*\banimate-/, /className="[^"]*motion-safe:/, /className="[^"]*\bitalic\b/],
    /*
     * The contract is "this surface adapts to the space it has". It used to be
     * spelled `/sm:/` — a grep for a VIEWPORT breakpoint prefix — and the
     * greeting genuinely carried two of them, stepping `page-title` → `display`
     * and `title` → `page-title` at 640px of window.
     *
     * That mechanism is gone on purpose. The window is not the space this
     * surface has: the sidebar takes 256px of it until the width where the
     * panel starts floating and then stops taking it, so a `sm:` step fires for
     * a change the column never saw, and fires the wrong way whenever the
     * sidebar's state disagrees with the window's size class. The rungs
     * themselves are fluid against the column now (`cqi`, tailwind.config.ts),
     * so the greeting adapts continuously and correctly with no breakpoint at
     * all.
     *
     * So the marker asserts what actually holds: the surface caps its measure,
     * and its heading is set in one of the two column-keyed rungs rather than a
     * fixed size. Grepping for `sm:` would now pass only if someone put the bug
     * back.
     */
    responsive: [/max-w-/, /text-(?:display|page-title)\b/],
  },
  {
    id: "loading",
    sources: ["src/components/chat/generation-placeholder.tsx"],
    required: [
      /role="status"/,
      /aria-live="polite"/,
      /data-modality=/,
      /data-stage=/,
      /motion-safe:/,
    ],
    forbidden: [],
    responsive: [/w-full/, /max-w-\[min\(100%/],
  },
  {
    id: "error",
    sources: ["src/app/(app)/error.tsx", "src/app/global-error.tsx"],
    required: [
      /<h1\b/,
      /Try again/,
      /href="\/chat"/,
      /We couldn’t load this page/,
      /<main\b/,
    ],
    forbidden: [],
    responsive: [/flex-wrap/, /max-width:1152px/, /grid-template-columns:minmax\(0,1fr\)/],
  },
  {
    id: "partial",
    sources: ["src/components/chat/message-list.tsx", "src/components/chat/chat-view.tsx"],
    required: [
      /role="status"/,
      /aria-live="polite"/,
      /role="log"/,
      /aria-live="off"/,
      /status=\{/,
    ],
    forbidden: [],
    responsive: [/w-full/, /max-w-3xl/, /coarse:/],
  },
  {
    id: "success",
    sources: ["scripts/public-ui-smoke.mjs"],
    required: [
      /export const PUBLIC_ROUTES/,
      /response\.ok/,
      /content-type/,
      /auth boundary \/chat/,
      /location/,
    ],
    forbidden: [],
    responsive: [],
  },
] as const;

export const UI_SHARED_PREFERENCE_CONTRACT = {
  source: "src/app/globals.css",
  required: [/\.dark\b/, /@media \(prefers-reduced-motion: reduce\)/],
};

export const EXPECTED_UI_STATE_IDS = ["empty", "loading", "error", "partial", "success"] as const;
