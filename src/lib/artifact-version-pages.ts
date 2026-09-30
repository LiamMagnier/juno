import { ARTIFACT_VERSION_PAGE_DEFAULT, ARTIFACT_VERSION_PAGE_MAX } from "@/lib/artifact-access";

/*
 * Paging through an artifact's history (GET /api/artifacts/[id]/versions).
 *
 * Newest first, keyed by version number: `before` is the smallest version the
 * client already has, and the next page is the versions below it. A version
 * number is a stable cursor because versions are immutable and never
 * renumbered, so a page never shifts under a client while it scrolls. Bodies
 * are left out unless asked for: a history panel needs numbers, origins and
 * times, and one body at a time (GET ./versions/[version]).
 *
 * Pure, so the parsing is tested without a database.
 */

export interface VersionPageQuery {
  /** Only versions below this one; null for the newest page. */
  before: number | null;
  limit: number;
  /** Include each version's body. */
  content: boolean;
}

export function parseVersionPageQuery(params: URLSearchParams): VersionPageQuery | null {
  const rawBefore = params.get("before");
  const rawLimit = params.get("limit");
  let before: number | null = null;
  if (rawBefore !== null && rawBefore !== "") {
    if (!/^\d+$/.test(rawBefore)) return null;
    before = Number(rawBefore);
    if (!Number.isSafeInteger(before) || before < 1) return null;
  }
  let limit = ARTIFACT_VERSION_PAGE_DEFAULT;
  if (rawLimit !== null && rawLimit !== "") {
    if (!/^\d+$/.test(rawLimit)) return null;
    limit = Math.min(ARTIFACT_VERSION_PAGE_MAX, Math.max(1, Number(rawLimit)));
  }
  const content = params.get("content") === "1" || params.get("content") === "true";
  return { before, limit, content };
}

/**
 * The cursor for the page after `rows` (newest first), or null when this page
 * reached version 1 or came back short.
 */
export function nextVersionCursor(rows: ReadonlyArray<{ version: number }>, limit: number): number | null {
  if (rows.length < limit) return null;
  const smallest = rows[rows.length - 1]?.version ?? 1;
  return smallest > 1 ? smallest : null;
}
