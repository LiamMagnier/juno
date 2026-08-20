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
  /** Allow eval only in development mode for Fast Refresh */
  isDev?: boolean;
}

export function buildCsp({ nonce, relayUrl, isDev }: CspOptions): string {
  const allowEval = isDev ?? (process.env.NODE_ENV === "development");
  const connect = ["'self'", relayUrl || null].filter(Boolean).join(" ");
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
    "media-src 'self' blob: data:",
    "frame-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    "report-uri /api/csp-report",
  ].join("; ");
}
