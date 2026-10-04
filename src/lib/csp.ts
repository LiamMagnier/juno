/**
 * The Content-Security-Policy, as a pure function of the request nonce.
 *
 * Separate from src/middleware.ts so the policy can be asserted in tests —
 * middleware runs on the Edge runtime and cannot be imported by `tsx --test`.
 * A policy nobody can test is a policy nobody will dare promote from
 * Report-Only to enforcing.
 *
 * No Node-only imports here: this is loaded by the Edge middleware.
 */

export interface CspOptions {
  /** Per-request nonce. Next stamps this onto its own script tags. */
  nonce: string;
  /** wss:// origin of the voice relay, when one is configured. */
  relayUrl?: string;
  /**
   * Origin that serves artifact previews (NEXT_PUBLIC_SANDBOX_ORIGIN), when it
   * is not this one. Previews are loaded by URL precisely so they do NOT run
   * under this policy — see src/lib/sandbox-policy.ts — and the frame has to be
   * allowed to load them.
   */
  sandboxOrigin?: string | null;
  /** Allow eval only in development mode for Fast Refresh */
  isDev?: boolean;
}

/**
 * Stripe's embedded Checkout (the plans page pays inside Alevr, card, Apple
 * Pay and Google Pay): the checkout frame and its API, from Stripe's own CSP
 * guidance for embedded Checkout. Its script is loaded by our nonced code, so
 * 'strict-dynamic' already admits it.
 */
export const STRIPE_CONNECT = ["https://api.stripe.com", "https://checkout.stripe.com"];
export const STRIPE_FRAMES = ["https://js.stripe.com", "https://*.js.stripe.com", "https://checkout.stripe.com", "https://hooks.stripe.com"];

export function buildCsp({ nonce, relayUrl, sandboxOrigin, isDev }: CspOptions): string {
  const allowEval = isDev ?? (process.env.NODE_ENV === "development");
  const connect = ["'self'", relayUrl || null, ...STRIPE_CONNECT].filter(Boolean).join(" ");
  const frames = ["'self'", "blob:", sandboxOrigin || null, ...STRIPE_FRAMES].filter(Boolean).join(" ");
  return [
    "default-src 'self'",
    // 'strict-dynamic' lets Next's nonced loader pull in its own chunks. The
    // https: host source is ignored by browsers that honour strict-dynamic and
    // serves as the fallback for those that do not; same for 'unsafe-inline',
    // which any nonce-aware browser discards. In development, 'unsafe-eval' is
    // needed for Next.js Fast Refresh / React hot reload.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'unsafe-inline' ${allowEval ? "'unsafe-eval' " : ""}https:`,
    // Unavoidable: the app sets inline `style=` for animation delays and
    // measured layout throughout.
    "style-src 'self' 'unsafe-inline'",
    // `https:` is deliberate, not lazy. Source-citation chips load each
    // source's own favicon from its own origin (src/components/chat/
    // source-chip.tsx) — a deliberate anti-tracking choice — so the set of
    // legitimate image hosts genuinely is "the web".
    "img-src 'self' blob: data: https:",
    "font-src 'self' data:",
    `connect-src ${connect}`,
    // `https:` for the same reason as img-src: the announcement form lets the
    // owner paste a hosted video URL ("Paste a URL instead"), and without it
    // that <video> was refused by this policy and rendered as an empty box.
    // Media cannot execute script, so this widens nothing that runs.
    "media-src 'self' blob: data: https:",
    `frame-src ${frames}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "report-uri /api/csp-report",
  ].join("; ");
}
