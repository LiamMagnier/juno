/**
 * The rules for whether a public link may be served, and what a visitor may
 * report about one. Pure and import-free — no database, no zod — so the share
 * lookup, the admin tools, the report form on the public page and the tests all
 * read the same sentences without the public page shipping a validator. The
 * request schemas are in src/lib/share-schemas.ts.
 */

export interface ShareStanding {
  revokedAt: Date | null;
  takenDownAt: Date | null;
  /** The owner's `User.bannedAt`. */
  ownerBannedAt: Date | null;
}

/**
 * A link is live only while nobody has pulled it: not revoked by its owner, not
 * taken down by Juno, and not owned by a banned account.
 *
 * The ban is read at request time rather than copied onto each share, so it is
 * a suspension: banning an account takes every one of its links down on the
 * next request, and lifting the ban brings back the ones that were live. A
 * takedown is per link and outlasts an unban; only an admin restore undoes it.
 */
export function shareIsServable(standing: ShareStanding): boolean {
  return !standing.revokedAt && !standing.takenDownAt && !standing.ownerBannedAt;
}

export type ShareStatus = "live" | "revoked" | "taken-down" | "owner-banned";

/** The one word the admin tools show for a link. Takedown outranks the rest. */
export function shareStatus(standing: ShareStanding): ShareStatus {
  if (standing.takenDownAt) return "taken-down";
  if (standing.ownerBannedAt) return "owner-banned";
  if (standing.revokedAt) return "revoked";
  return "live";
}

/** Share tokens are 32 base64url characters; accept a little either side. */
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * A token from whatever an admin pasted: the bare token, or a full share URL
 * from any host (a report forwarded from staging, a link with a query string).
 */
export function parseShareToken(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (TOKEN.test(raw)) return raw;
  try {
    const url = new URL(raw);
    const match = /^\/share\/([^/]+)\/?$/.exec(url.pathname);
    return match && TOKEN.test(match[1]) ? match[1] : null;
  } catch {
    const match = /(?:^|\/)share\/([A-Za-z0-9_-]{16,128})(?:[/?#]|$)/.exec(raw);
    return match ? match[1] : null;
  }
}

export const SHARE_REPORT_REASONS = [
  { id: "phishing", label: "Phishing or a scam" },
  { id: "malware", label: "Malware or a harmful download" },
  { id: "illegal", label: "Illegal content" },
  { id: "harassment", label: "Harassment or hate" },
  { id: "sexual", label: "Sexual content" },
  { id: "other", label: "Something else" },
] as const;

export type ShareReportReason = (typeof SHARE_REPORT_REASONS)[number]["id"];

export const SHARE_REPORT_DETAIL_MAX = 2000;

/** Share tokens as the report form and the admin lookup accept them. */
export const SHARE_TOKEN_PATTERN = TOKEN;
