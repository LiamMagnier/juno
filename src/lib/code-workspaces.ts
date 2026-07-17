/*
 * Mirror-sync reconciliation for PUT /api/code/workspaces.
 *
 * The app owns the workspace list and pushes full snapshots; the server
 * replaces the user's set. Since W5, workspace IDENTITY is the client-minted
 * `key` — the absolute `path` is device metadata that may change without
 * forking identity (a moved folder keeps its server row and its sessions).
 *
 * Matching precedence, per incoming item:
 *   1. (userId, key)  — when the item carries a key.
 *   2. (userId, path) — fallback, and the ONLY rule for pre-key clients.
 *      A keyed item that matches by path ADOPTS its key onto the row, so the
 *      first keyed sync upgrades existing rows in place instead of forking.
 *
 * Pure planning (no Prisma imports) so the hermetic test suite can exercise
 * the contract without a database; the route applies the plan transactionally.
 */

export interface MirrorWorkspaceItem {
  id: string;
  name: string;
  path: string;
  key?: string | null;
  lastOpenedAt?: string;
}

export interface ExistingWorkspaceRow {
  id: string;
  name: string;
  path: string;
  key: string | null;
}

export interface WorkspaceUpdate {
  id: string;
  /** True when the row is moving to a different path — the route vacates the
   *  old unique (userId, path) slot first so apply order can never conflict. */
  pathChanged: boolean;
  data: { name: string; path: string; lastOpenedAt: Date; key?: string };
}

export interface WorkspaceCreate {
  id: string;
  name: string;
  path: string;
  key: string | null;
  lastOpenedAt: Date;
}

export interface MirrorPlan {
  /** Rows to delete FIRST (unclaimed rows + stale occupants of claimed paths). */
  deleteIds: string[];
  updates: WorkspaceUpdate[];
  creates: WorkspaceCreate[];
}

const openedAt = (item: MirrorWorkspaceItem): Date =>
  item.lastOpenedAt ? new Date(item.lastOpenedAt) : new Date();

/**
 * Compute the delete/update/create set that reconciles `existing` (the user's
 * current server rows) with `items` (the client's full snapshot). Apply order
 * matters: deletes, then updates, then creates — deletes free up the
 * (userId, path) unique slot before a keyed row moves onto that path.
 */
export function planWorkspaceMirror(existing: ExistingWorkspaceRow[], items: MirrorWorkspaceItem[]): MirrorPlan {
  const byKey = new Map<string, ExistingWorkspaceRow>();
  const byPath = new Map<string, ExistingWorkspaceRow>();
  for (const row of existing) {
    if (row.key != null) byKey.set(row.key, row);
    byPath.set(row.path, row);
  }

  const claimed = new Set<string>(); // row ids matched to an incoming item
  const staleIds = new Set<string>(); // rows displaced by a keyed row moving onto their path
  const updates: WorkspaceUpdate[] = [];
  const creates: WorkspaceCreate[] = [];
  const createdKeys = new Set<string>();
  const takenPaths = new Set<string>(); // paths assigned by planned updates/creates

  for (const item of items) {
    const key = item.key ?? null;

    // 1. Identity match — key first.
    let row = key != null ? byKey.get(key) : undefined;
    // 2. Path fallback (pre-key clients, or first keyed sync adopting a key).
    //    Never steal a row a previous item in this snapshot already claimed.
    if (!row) {
      const pathRow = byPath.get(item.path);
      if (pathRow && !claimed.has(pathRow.id) && !staleIds.has(pathRow.id)) row = pathRow;
    }

    if (row) {
      if (claimed.has(row.id)) continue; // duplicate item in the snapshot — first wins
      claimed.add(row.id);
      // A keyed row moving onto a path still held by a DIFFERENT unclaimed row
      // must displace it, or the (userId, path) unique would reject the move.
      const occupant = byPath.get(item.path);
      if (occupant && occupant.id !== row.id && !claimed.has(occupant.id)) staleIds.add(occupant.id);
      takenPaths.add(item.path);
      updates.push({
        id: row.id,
        pathChanged: row.path !== item.path,
        data: {
          name: item.name,
          path: item.path,
          lastOpenedAt: openedAt(item),
          // Adopt/confirm the identity key; NEVER clear one — a pre-key client
          // omitting keys must not strip identity minted by a newer client.
          ...(key != null ? { key } : {}),
        },
      });
      continue;
    }

    // Nothing to match — a new workspace. Guard collisions within one
    // snapshot (same key twice, or a path another item already took): first
    // occurrence wins, so a malformed snapshot degrades instead of tripping
    // the (userId, path) unique mid-transaction.
    if ((key != null && createdKeys.has(key)) || takenPaths.has(item.path)) continue;
    if (key != null) createdKeys.add(key);
    takenPaths.add(item.path);
    creates.push({ id: item.id, name: item.name, path: item.path, key, lastOpenedAt: openedAt(item) });
  }

  // Mirror semantics: the snapshot replaces the set — every unclaimed row goes.
  const deleteIds = existing.filter((row) => !claimed.has(row.id)).map((row) => row.id);
  return { deleteIds, updates, creates };
}
