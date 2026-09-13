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
      /motion-safe:/,

    ],
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
    responsive: [/w-full/, /max-w-\[min\(100%/],
  },
  {
    id: "error",
    sources: ["src/app/(app)/error.tsx", "src/app/global-error.tsx"],
    required: [
      /<h1\b/,
      /Try again/,
      /href="\/chat"/,
      /Juno can(?:&rsquo;|')t reach its backend/,
      /<main\b/,
    ],
    responsive: [/flex-wrap/, /width: 100%/, /max-width:/],
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
    responsive: [],
  },
] as const;

export const UI_SHARED_PREFERENCE_CONTRACT = {
  source: "src/app/globals.css",
  required: [/\.dark\b/, /@media \(prefers-reduced-motion: reduce\)/],
};

export const EXPECTED_UI_STATE_IDS = ["empty", "loading", "error", "partial", "success"] as const;
