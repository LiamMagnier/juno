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
 *      A keyed item may adopt a path-matched row ONLY when that row has no key
 *      yet, so the first keyed sync upgrades pre-key rows in place instead of
 *      forking.
 *
 * A row's key is IMMUTABLE once set: it is only ever written null -> value.
 * That invariant is what keeps sessions attached. Two devices can hold the same
 * absolute path while each mints its own key (same user, two machines, both
 * with ~/code/app); adopting the incoming key onto a row that already carried a
 * different one rewrote a live workspace's identity, so every session keyed to
 * the old value was orphaned — and because each device re-adopted on its next
 * heartbeat, the two ping-ponged the key and orphaned each other forever.
 *
 * "Different key, same path" therefore resolves as IDENTITY WINS: since W5 the
 * key IS the workspace, so an item keyed K_b is simply not the row keyed K_a —
 * it shares only a path string. The item forks its own row, and the unmatched
 * row falls out through the mirror-replace rule below. This converges: the
 * server becomes a pure function of the pushed snapshot, and re-pushing it is a
 * no-op (the fork now matches by key). The alternative — dropping the incoming
 * key and keeping K_a — leaves the row's key contradicting every client that
 * pushed it, makes the result depend on sync history rather than the snapshot,
 * and still orphans the pushing device's sessions. Neither can keep BOTH rows:
 * (userId, path) is unique. Forking at least never mutates identity underneath
 * a row that other devices still reference by key.
 *
 * Pure planning (no Prisma imports) so the hermetic test suite can exercise
 * the contract without a database; the route applies the plan transactionally.
 */

import { z } from "zod";

/**
 * Code-session workspace attribution, shared by POST /api/conversations and
 * PATCH /api/conversations/[id] so a session created with a given workspace
 * accepts exactly what a retro-mark PATCH accepts. The caps are per-field and
 * deliberately unequal: `path` matches the 1000 the mirror stores (clamping it
 * to a shorter shared limit silently truncated long paths and broke the
 * path-fallback grouping above), while `key` is a client-minted identity and
 * `name` is display text.
 */
export const codeWorkspaceAttributionShape = {
  codeWorkspaceName: z.string().trim().min(1).max(300).nullable().optional(),
  codeWorkspacePath: z.string().trim().min(1).max(1000).nullable().optional(),
  codeWorkspaceKey: z.string().trim().min(1).max(200).nullable().optional(),
};

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
    //    A keyed item only takes a path-matched row that has NO identity yet:
    //    a row already carrying a different key is a different workspace that
    //    merely shares a path, so this item forks its own row instead of
    //    rewriting that row's key (see "identity wins" in the header).
    if (!row) {
      const pathRow = byPath.get(item.path);
      const adoptable = pathRow && (key == null || pathRow.key == null);
      if (adoptable && !claimed.has(pathRow.id) && !staleIds.has(pathRow.id)) row = pathRow;
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
          // Adopt/confirm the identity key. Only ever null -> value or a
          // no-op re-confirm: the matching rules above guarantee this row
          // either already holds `key` or holds none. NEVER clears one — a
          // pre-key client omitting keys must not strip identity minted by a
          // newer client.
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
