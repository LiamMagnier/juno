// Pure hydration-envelope shaping. Deliberately free of `server-only` and of any
// Prisma import so the contract invariant below can be tested directly, without a
// database and without a React Server Component boundary.
export type EntityData = Record<string, unknown>;

export type EntityEnvelope = {
  type: string;
  id: string;
  revision: number;
  deletedAt: string | null;
  data: EntityData | null;
};

export type EntityRevisionRow = {
  entityId: string;
  revision: number;
  deletedAt: Date | null;
  updatedAt: Date;
};

/**
 * Shapes hydration envelopes so `data === null` if and only if `deletedAt` is
 * set — the invariant the OpenAPI contract states ("Tombstoned entities carry
 * deletedAt with data null") and that native clients enforce strictly.
 *
 * The case that made this a release blocker: an EntityRevision can survive its
 * underlying row. Artifact rows cascade-delete when their Conversation goes
 * (`onDelete: Cascade`), which happens in the database and so never runs the
 * application code that would tombstone the revision. The revision is left with
 * `deletedAt: null`, the index keeps advertising the entity as live, and
 * hydration then found no row and emitted `data: null` WITH `deletedAt: null` —
 * an envelope that is neither live nor tombstoned. Ten such rows existed on the
 * real account (4 artifact, 6 artifact_version) and stalled its initial sync
 * with "Juno returned malformed synchronization data".
 *
 * A row that is gone IS deleted, so it is reported as a tombstone. When the
 * revision carries no deletion time we fall back to its `updatedAt`, which is
 * the last moment the server knows the entity changed — monotonic, already
 * persisted, and never invented from the current clock, so repeated hydrations
 * of the same entity stay byte-identical.
 *
 * Exported separately from `loadEntities` so the invariant is testable without a
 * database.
 */
export function buildEntityEnvelopes(
  type: string,
  ids: string[],
  data: Map<string, EntityData>,
  revisions: EntityRevisionRow[],
): EntityEnvelope[] {
  const revisionById = new Map(revisions.map((row) => [row.entityId, row]));
  const entities: EntityEnvelope[] = [];
  for (const id of ids) {
    const row = data.get(id) ?? null;
    const revision = revisionById.get(id);
    if (!row && !revision) continue; // unknown or foreign id — nothing to report
    entities.push({
      type,
      id,
      revision: revision?.revision ?? 0,
      // Never `null` when there is no data: that combination is exactly what
      // native clients reject as malformed.
      deletedAt: row
        ? null
        : (revision?.deletedAt ?? revision?.updatedAt ?? null)?.toISOString()
          ?? new Date(0).toISOString(),
      data: row,
    });
  }
  return entities;
}

