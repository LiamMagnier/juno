/**
 * Which artifact version a public link serves — one rule, read by both sides
 * of the promise the Share dialog makes ("Later edits stay private").
 *
 * A Share has no version pin; it is frozen at `snapshotAt`, and the link serves
 * the version that was current at that instant. That is only a freeze while
 * every version a link can serve is immutable. Versions are append-only
 * everywhere except the design store, which folds a quick run of edits into
 * the newest checkpoint by rewriting that row's body in place
 * (src/lib/design/store.ts) — so a fold into the version a link had already
 * resolved to published the edit (audit artifacts.md, B1).
 *
 * The public resolver (src/lib/share.ts) and the store's fold decision
 * therefore read the same function: the store never folds into a version a
 * link resolves to, so once a link has resolved a version, that version's body
 * never changes and later edits land in versions the link cannot see.
 *
 * Pure and import-free, so the tests read it without a database.
 */

/** All the resolver needs to know about a version. */
export interface VersionStamp {
  version: number;
  createdAt: Date;
}

/**
 * The version a link frozen at `snapshotAt` serves: the highest-numbered one
 * created at or before that instant. When none predates it (a link minted in
 * the same instant as the first version, or clocks that disagree), the
 * earliest one, rather than a 404 for a fresh link. Null only when there are
 * no versions at all. Independent of the order `versions` arrive in.
 */
export function sharedVersionAt(versions: readonly VersionStamp[], snapshotAt: Date): number | null {
  const cutoff = snapshotAt.getTime();
  let newestBefore: number | null = null;
  let earliest: number | null = null;
  for (const v of versions) {
    if (earliest === null || v.version < earliest) earliest = v.version;
    if (v.createdAt.getTime() <= cutoff && (newestBefore === null || v.version > newestBefore)) newestBefore = v.version;
  }
  return newestBefore ?? earliest;
}

/**
 * Whether any of the links frozen at `snapshots` serves `version` — the
 * question the design store asks before it rewrites a checkpoint in place.
 * The caller passes every link that could serve again: live ones, and ones
 * taken down or suspended by a ban (an admin restore or a lifted ban brings
 * them back), but not revoked ones, which never serve again.
 */
export function versionIsShared(version: number, versions: readonly VersionStamp[], snapshots: readonly Date[]): boolean {
  return snapshots.some((snapshotAt) => sharedVersionAt(versions, snapshotAt) === version);
}
