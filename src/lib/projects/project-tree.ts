/**
 * Projects as folders: the rules for nesting one project inside another.
 *
 * Pure and dependency-free (no Prisma, no `server-only`), so the API, the sync
 * route, the chat route, the web UI and the tests all agree on one copy:
 *
 *   - A project's parent is another project owned by the same account.
 *   - No cycles: a project can never sit inside itself or its own descendants.
 *   - At most MAX_PROJECT_DEPTH levels, counting the top level as 1, so a move
 *     is refused when the moved subtree would end up deeper than that.
 *   - Deleting a folder moves its children up to the folder's own parent by
 *     default ("lift"); "cascade" deletes the whole subtree instead.
 *   - Inheritance: a subfolder's chats follow every ancestor's instructions and
 *     read every ancestor's files, root first, then the folder's own.
 */

/** Top level is depth 1; a folder four levels down is the deepest allowed. */
export const MAX_PROJECT_DEPTH = 4;

export interface ProjectTreeNode {
  id: string;
  parentId: string | null;
}

export type DeleteChildrenMode = "lift" | "cascade";

export type MoveRefusal = "not_found" | "parent_not_found" | "self" | "cycle" | "depth";

export type MoveCheck = { ok: true } | { ok: false; reason: MoveRefusal };

export const MOVE_REFUSAL_MESSAGES: Record<MoveRefusal, string> = {
  not_found: "That project was not found.",
  parent_not_found: "That folder was not found.",
  self: "A project can’t go inside itself.",
  cycle: "A project can’t go inside one of its own folders.",
  depth: `Folders nest at most ${MAX_PROJECT_DEPTH} levels deep.`,
};

function index<T extends ProjectTreeNode>(nodes: readonly T[]): Map<string, T> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function childrenIndex(nodes: readonly ProjectTreeNode[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = out.get(node.parentId) ?? [];
    list.push(node.id);
    out.set(node.parentId, list);
  }
  return out;
}

/**
 * The ids above `id`, nearest first (parent, grandparent, …). Stops at a
 * missing parent or at a cycle already in the data, so a corrupt row can never
 * hang the caller.
 */
export function ancestorIds(nodes: readonly ProjectTreeNode[], id: string): string[] {
  const byId = index(nodes);
  const out: string[] = [];
  const seen = new Set<string>([id]);
  let current = byId.get(id)?.parentId ?? null;
  while (current && !seen.has(current) && byId.has(current)) {
    out.push(current);
    seen.add(current);
    current = byId.get(current)?.parentId ?? null;
  }
  return out;
}

/** Every id below `id`, breadth first. Cycle-safe like `ancestorIds`. */
export function descendantIds(nodes: readonly ProjectTreeNode[], id: string): string[] {
  const kids = childrenIndex(nodes);
  const out: string[] = [];
  const seen = new Set<string>([id]);
  const queue = [...(kids.get(id) ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(kids.get(next) ?? []));
  }
  return out;
}

/** 1 for a top-level project. */
export function depthOf(nodes: readonly ProjectTreeNode[], id: string): number {
  return ancestorIds(nodes, id).length + 1;
}

/** Levels in the subtree rooted at `id`, itself included (a leaf is 1). */
export function subtreeHeight(nodes: readonly ProjectTreeNode[], id: string): number {
  const kids = childrenIndex(nodes);
  const walk = (node: string, seen: Set<string>): number => {
    let best = 0;
    for (const child of kids.get(node) ?? []) {
      if (seen.has(child)) continue;
      best = Math.max(best, walk(child, new Set([...seen, child])));
    }
    return best + 1;
  };
  return walk(id, new Set([id]));
}

/**
 * Whether `id` may move under `newParentId` (null = the top level).
 *
 * `nodes` is the owner's whole tree. A parent outside it is refused as
 * `parent_not_found`, which is also how another account's project is refused:
 * the caller loads only the acting owner's projects.
 */
export function validateProjectMove(
  nodes: readonly ProjectTreeNode[],
  id: string,
  newParentId: string | null
): MoveCheck {
  const byId = index(nodes);
  if (!byId.has(id)) return { ok: false, reason: "not_found" };
  if (newParentId === null) return { ok: true };
  if (newParentId === id) return { ok: false, reason: "self" };
  if (!byId.has(newParentId)) return { ok: false, reason: "parent_not_found" };
  if (descendantIds(nodes, id).includes(newParentId)) return { ok: false, reason: "cycle" };
  if (depthOf(nodes, newParentId) + subtreeHeight(nodes, id) > MAX_PROJECT_DEPTH) {
    return { ok: false, reason: "depth" };
  }
  return { ok: true };
}

/** Whether a NEW project may be created under `parentId`. */
export function validateNewChild(nodes: readonly ProjectTreeNode[], parentId: string | null): MoveCheck {
  if (parentId === null) return { ok: true };
  if (!nodes.some((node) => node.id === parentId)) return { ok: false, reason: "parent_not_found" };
  if (depthOf(nodes, parentId) + 1 > MAX_PROJECT_DEPTH) return { ok: false, reason: "depth" };
  return { ok: true };
}

/**
 * What deleting the folder `id` does to the rest of the tree.
 *
 * `lift` (the default): its direct children move to its own parent, keeping
 * their own subtrees, and only `id` is deleted. `cascade`: `id` and every
 * descendant are deleted, deepest first so no row is ever orphaned mid-way.
 */
export function planFolderDelete(
  nodes: readonly ProjectTreeNode[],
  id: string,
  mode: DeleteChildrenMode = "lift"
): { reparent: { ids: string[]; parentId: string | null } | null; deleteIds: string[] } {
  const byId = index(nodes);
  const self = byId.get(id);
  if (!self) return { reparent: null, deleteIds: [] };
  if (mode === "cascade") {
    const below = descendantIds(nodes, id);
    return { reparent: null, deleteIds: [...below.reverse(), id] };
  }
  const direct = nodes.filter((node) => node.parentId === id).map((node) => node.id);
  return {
    reparent: direct.length ? { ids: direct, parentId: self.parentId } : null,
    deleteIds: [id],
  };
}

export interface ProjectTreeEntry<T> {
  node: T;
  depth: number;
  children: ProjectTreeEntry<T>[];
}

/**
 * The flat list as a forest. A row whose parent is not in the list (another
 * account's, or a dangling id) is treated as top level rather than dropped.
 */
export function buildProjectForest<T extends ProjectTreeNode>(
  nodes: readonly T[],
  compare?: (a: T, b: T) => number
): ProjectTreeEntry<T>[] {
  const byId = index(nodes);
  const kids = new Map<string | null, T[]>();
  for (const node of nodes) {
    const parent = node.parentId && byId.has(node.parentId) && node.parentId !== node.id ? node.parentId : null;
    const list = kids.get(parent) ?? [];
    list.push(node);
    kids.set(parent, list);
  }
  const seen = new Set<string>();
  const build = (parent: string | null, depth: number): ProjectTreeEntry<T>[] => {
    const list = [...(kids.get(parent) ?? [])];
    if (compare) list.sort(compare);
    const out: ProjectTreeEntry<T>[] = [];
    for (const node of list) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      out.push({ node, depth, children: build(node.id, depth + 1) });
    }
    return out;
  };
  const roots = build(null, 1);
  // A loop already in the data has no root to hang from. Its rows are drawn at
  // the top level rather than not at all, so nothing an owner has can vanish.
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    roots.push({ node, depth: 1, children: build(node.id, 2) });
  }
  return roots;
}

/** The forest flattened in display order, each row with its depth. */
export function flattenProjectForest<T>(forest: readonly ProjectTreeEntry<T>[]): { node: T; depth: number }[] {
  const out: { node: T; depth: number }[] = [];
  const walk = (entries: readonly ProjectTreeEntry<T>[]) => {
    for (const entry of entries) {
      out.push({ node: entry.node, depth: entry.depth });
      walk(entry.children);
    }
  };
  walk(forest);
  return out;
}

export interface InheritableProject<F> {
  name: string;
  instructions: string;
  files: readonly F[];
}

/**
 * What a chat in the LAST project of `lineage` is told, given the lineage root
 * first (top-level project … the chat's own folder).
 *
 * Instructions are concatenated parent first, each ancestor's block headed by
 * its name so the model can tell whose rule is whose; the folder's own
 * instructions come last and so read as the most specific. A level with no
 * instructions contributes nothing, so a project with no parent produces
 * exactly its own instructions, byte for byte, as before folders existed.
 * Files are concatenated in the same order.
 */
export function mergeInheritedProjectContext<F>(
  lineage: readonly InheritableProject<F>[]
): InheritableProject<F> | null {
  if (!lineage.length) return null;
  const own = lineage[lineage.length - 1];
  const ancestors = lineage.slice(0, -1).filter((level) => level.instructions.trim());
  const instructions = ancestors.length
    ? [
        ...ancestors.map((level) => `### From the folder "${level.name}"\n${level.instructions.trim()}`),
        ...(own.instructions.trim() ? [`### From "${own.name}"\n${own.instructions.trim()}`] : []),
      ].join("\n\n")
    : own.instructions;
  return {
    name: own.name,
    instructions,
    files: lineage.flatMap((level) => level.files),
  };
}
