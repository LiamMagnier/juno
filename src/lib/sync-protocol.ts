export const MAX_CHANGE_PAGE_SIZE = 500;

/**
 * Thrown when a client's cursor predates the compaction floor: changes in
 * (cursor, floor] may have been pruned, so an incremental catch-up would
 * silently lose data. Routes translate this into 410 — the client must
 * resync from bootstrap.
 */
export class CursorCompactedError extends Error {
  constructor(public readonly floor: bigint) {
    super("cursor_compacted");
    this.name = "CursorCompactedError";
  }
}

/** A cursor exactly at the floor has consumed everything the pruner deleted;
 *  anything below it may have missed pruned changes. */
export function ensureCursorAboveFloor(after: bigint, floor: bigint): void {
  if (after < floor) throw new CursorCompactedError(floor);
}

export function parseCursor(value: string | null): bigint {
  if (value === null || value === "") return 0n;
  if (!/^(0|[1-9][0-9]{0,30})$/.test(value)) throw new Error("invalid_cursor");
  return BigInt(value);
}

export function parseChangeLimit(value: string | null): number {
  if (value === null || value === "") return 100;
  if (!/^[0-9]+$/.test(value)) throw new Error("invalid_limit");
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHANGE_PAGE_SIZE) throw new Error("invalid_limit");
  return limit;
}

export function changeEnvelope(change: {
  cursor: bigint;
  entityType: string;
  entityId: string;
  parentEntityId?: string | null;
  revision: number;
  operation: string;
  changedAt: Date;
}) {
  return {
    cursor: change.cursor.toString(),
    entityType: change.entityType,
    entityId: change.entityId,
    parentEntityId: change.parentEntityId ?? null,
    revision: change.revision,
    operation: change.operation,
    changedAt: change.changedAt.toISOString(),
  };
}
