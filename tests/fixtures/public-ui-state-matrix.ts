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
      /aria-label="Juno"/,
      /motion-safe:/,
      /motion-reduce:/,
    ],
    responsive: [/sm:/],
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
