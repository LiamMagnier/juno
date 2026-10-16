/**
 * Branches in a conversation: the rules, without a database.
 *
 * Editing a question or regenerating an answer used to destroy something. The
 * edit deleted every later message, and the regenerate overwrote the answer in
 * place, keeping only its text. Both now add a SIBLING row and keep the old
 * one together with everything that followed it, so a conversation is a tree
 * with exactly one path shown at a time — what ChatGPT and Claude draw as
 * "‹ 2/3 ›" under a turn.
 *
 * The columns (prisma/schema.prisma, Message):
 *
 *   parentId        the message this one follows. Writers that know nothing
 *                   about branches leave it NULL; such a row follows the
 *                   previous message on the shown path, and `impliedParents`
 *                   writes that down before any row leaves the path.
 *   branchGroupId   shared by the alternatives at one point (the first one's
 *                   id); NULL for a message that has never had one.
 *   branchSelected  the alternative chosen in its group, kept while the branch
 *                   around it is hidden, so going back restores the choices
 *                   made inside it.
 *   onActivePath    the shown path, denormalised. Every reader filters on it.
 *
 * The invariant that keeps every existing reader correct: the shown path, in
 * (createdAt, id) order, IS the path from the root to the leaf. A child is
 * always written after its parent, and a fork hides everything after the point
 * it forks at, so the order the transcript was always read in still holds.
 *
 * Pure and tested (tests/chat-branch-model.test.ts). The database half is
 * src/lib/chat/branches.ts.
 */

export interface BranchNode {
  id: string;
  parentId: string | null;
  branchGroupId: string | null;
  branchSelected: boolean;
  onActivePath: boolean;
  createdAt: Date;
}

/** Why a branch operation was refused. */
export type BranchRefusal =
  /** No such message in this conversation. */
  | { refused: "missing" }
  /** The message is not on the shown path, so nothing the reader sees can fork from it. */
  | { refused: "off_path" }
  /** The message has no alternatives to switch to. */
  | { refused: "no_branch" };

/** The writes one operation needs, as sets of message ids. */
export interface BranchChange {
  /** Parent pointers to record (id → parent id). */
  parents: Map<string, string>;
  /** Group ids to record (id → group id). */
  groups: Map<string, string>;
  activate: Set<string>;
  deactivate: Set<string>;
  select: Set<string>;
  unselect: Set<string>;
}

export function emptyChange(): BranchChange {
  return { parents: new Map(), groups: new Map(), activate: new Set(), deactivate: new Set(), select: new Set(), unselect: new Set() };
}

export function isRefusal(value: unknown): value is BranchRefusal {
  return !!value && typeof value === "object" && "refused" in value;
}

/** Thread order: (createdAt, id), the total order every transcript read uses. */
export function threadOrder(a: Pick<BranchNode, "createdAt" | "id">, b: Pick<BranchNode, "createdAt" | "id">): number {
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The shown path, root first. */
export function shownPath<T extends BranchNode>(nodes: readonly T[]): T[] {
  return nodes.filter((node) => node.onActivePath).sort(threadOrder);
}

/** The last message of the shown path, or null for an empty conversation. */
export function shownLeaf(nodes: readonly BranchNode[]): string | null {
  return shownPath(nodes).at(-1)?.id ?? null;
}

/**
 * Parent pointers the shown path implies but no row records yet.
 *
 * A row with no parent that is not the first on the path follows the row
 * before it. The first row keeps NULL: it is a root (and so are the
 * alternatives to an edited first question, which share its NULL parent).
 */
export function impliedParents(nodes: readonly BranchNode[]): Map<string, string> {
  const path = shownPath(nodes);
  const parents = new Map<string, string>();
  for (let i = 1; i < path.length; i++) {
    if (path[i].parentId == null) parents.set(path[i].id, path[i - 1].id);
  }
  return parents;
}

/** Nodes with the implied parents filled in, for the walks below. */
function withParents<T extends BranchNode>(nodes: readonly T[], parents: Map<string, string>): T[] {
  return nodes.map((node) => (parents.has(node.id) ? { ...node, parentId: parents.get(node.id)! } : node));
}

/** The shown rows from `id` to the leaf, `id` included. */
function shownFrom(nodes: readonly BranchNode[], id: string): string[] {
  const path = shownPath(nodes);
  const at = path.findIndex((node) => node.id === id);
  return at === -1 ? [] : path.slice(at).map((node) => node.id);
}

export interface ForkPlan {
  change: BranchChange;
  /** Parent of the new sibling (null when forking the first question). */
  parentId: string | null;
  /** The group the new sibling joins. */
  groupId: string;
  /** Whether the new sibling is shown. False only for a fork of a message that left the path meanwhile. */
  shown: boolean;
  /** Rows that leave the path: the target and everything after it. */
  hidden: string[];
}

/**
 * Add an alternative to `targetId` (an edit of a question, or a regenerate of
 * an answer). The target and everything after it leave the shown path; the
 * new sibling, which the caller writes with `parentId`/`groupId`, takes its
 * place and is the one selected.
 *
 * `allowOffPath` is for a regenerate that finishes after its answer was
 * switched away from on another device: the new answer still joins its group,
 * but hidden, because the reader is now looking at a different branch.
 */
export function planFork(
  nodes: readonly BranchNode[],
  targetId: string,
  options: { allowOffPath?: boolean } = {},
): ForkPlan | BranchRefusal {
  const target = nodes.find((node) => node.id === targetId);
  if (!target) return { refused: "missing" };
  if (!target.onActivePath && !options.allowOffPath) return { refused: "off_path" };
  const change = emptyChange();
  const parents = impliedParents(nodes);
  for (const [id, parent] of parents) change.parents.set(id, parent);
  const working = withParents(nodes, parents);
  const groupId = target.branchGroupId ?? target.id;
  if (!target.branchGroupId) change.groups.set(target.id, groupId);
  const shown = target.onActivePath;
  if (shown) {
    for (const node of working) {
      if ((node.branchGroupId ?? (node.id === target.id ? groupId : null)) === groupId && node.branchSelected) change.unselect.add(node.id);
    }
  }
  const hidden = shown ? shownFrom(working, target.id) : [];
  for (const id of hidden) change.deactivate.add(id);
  const parentId = working.find((node) => node.id === target.id)!.parentId;
  return { change, parentId, groupId, shown, hidden };
}

export interface SelectPlan {
  change: BranchChange;
  /** The alternative that was shown at this point before the switch. */
  replacedId: string;
  /** The new shown rows from the selected message to the leaf. */
  path: string[];
  /** False when the message was already the shown one (nothing to write). */
  changed: boolean;
}

/**
 * Show the branch that `messageId` starts: hide the alternative shown at its
 * point and everything after it, then show `messageId` and, below it, the
 * alternatives that were chosen inside its branch the last time it was shown.
 */
export function planSelect(nodes: readonly BranchNode[], messageId: string): SelectPlan | BranchRefusal {
  const target = nodes.find((node) => node.id === messageId);
  if (!target) return { refused: "missing" };
  if (!target.branchGroupId) return target.onActivePath ? { change: emptyChange(), replacedId: target.id, path: shownFrom(nodes, target.id), changed: false } : { refused: "no_branch" };
  const group = nodes.filter((node) => node.branchGroupId === target.branchGroupId);
  const current = group.find((node) => node.onActivePath);
  if (!current) return { refused: "off_path" };
  if (current.id === target.id) return { change: emptyChange(), replacedId: target.id, path: shownFrom(nodes, target.id), changed: false };

  const change = emptyChange();
  const parents = impliedParents(nodes);
  for (const [id, parent] of parents) change.parents.set(id, parent);
  const working = withParents(nodes, parents);
  for (const id of shownFrom(working, current.id)) change.deactivate.add(id);
  for (const node of group) {
    if (node.id === target.id) {
      if (!node.branchSelected) change.select.add(node.id);
    } else if (node.branchSelected) {
      change.unselect.add(node.id);
    }
  }

  // Walk down from the target, one child per level: the one chosen in its
  // group, else the newest. A row's children are the rows that name it.
  const children = new Map<string, BranchNode[]>();
  for (const node of working) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node);
    children.set(node.parentId, list);
  }
  const path: string[] = [];
  const seen = new Set<string>();
  let at: BranchNode | undefined = target;
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    path.push(at.id);
    const next: BranchNode[] = children.get(at.id) ?? [];
    at = next.length ? [...next].sort((a, b) => Number(b.branchSelected) - Number(a.branchSelected) || threadOrder(b, a))[0] : undefined;
  }
  for (const id of path) {
    change.deactivate.delete(id);
    if (!working.find((node) => node.id === id)!.onActivePath) change.activate.add(id);
  }
  // A row chosen on the way down that was not marked chosen is now (it was the
  // newest of a group with nothing chosen, which only an older write leaves).
  for (const id of path.slice(1)) {
    const node = working.find((n) => n.id === id)!;
    if (node.branchGroupId && !node.branchSelected) change.select.add(id);
  }
  return { change, replacedId: current.id, path, changed: true };
}

/** Where a message sits among its alternatives, oldest first. */
export interface SiblingPosition {
  index: number;
  siblingIds: string[];
}

/** Positions for every row of the given groups' members. */
export function siblingPositions(members: ReadonlyArray<Pick<BranchNode, "id" | "branchGroupId" | "createdAt">>): Map<string, SiblingPosition> {
  const byGroup = new Map<string, Array<Pick<BranchNode, "id" | "createdAt">>>();
  for (const member of members) {
    if (!member.branchGroupId) continue;
    const list = byGroup.get(member.branchGroupId) ?? [];
    list.push(member);
    byGroup.set(member.branchGroupId, list);
  }
  const positions = new Map<string, SiblingPosition>();
  for (const list of byGroup.values()) {
    if (list.length < 2) continue;
    const siblingIds = [...list].sort(threadOrder).map((member) => member.id);
    siblingIds.forEach((id, index) => positions.set(id, { index, siblingIds }));
  }
  return positions;
}

/**
 * The path that ends at `leafId`, root first: its ancestors by parent pointer.
 * Rows that record no parent are followed by thread order along the shown
 * path, which is what an unwritten pointer means. Null when the leaf is not
 * in `nodes`.
 */
export function pathTo(nodes: readonly BranchNode[], leafId: string): string[] | null {
  const parents = impliedParents(nodes);
  const working = withParents(nodes, parents);
  const byId = new Map(working.map((node) => [node.id, node]));
  if (!byId.has(leafId)) return null;
  const path: string[] = [];
  const seen = new Set<string>();
  let at = byId.get(leafId);
  while (at && !seen.has(at.id)) {
    seen.add(at.id);
    path.push(at.id);
    at = at.parentId ? byId.get(at.parentId) : undefined;
  }
  return path.reverse();
}

/**
 * Timestamps for older wordings adopted as siblings (MessageVersion rows from
 * before branches). They are placed just before the message they were earlier
 * versions of, oldest first, so the pager reads in the order they were written
 * — and after its parent, so a branch made of one still reads in thread order.
 */
export function adoptedVersionTimes(targetCreatedAt: Date, parentCreatedAt: Date | null, count: number): Date[] {
  const end = targetCreatedAt.getTime();
  const floor = parentCreatedAt ? parentCreatedAt.getTime() + 1 : Number.NEGATIVE_INFINITY;
  return Array.from({ length: count }, (_, i) => new Date(Math.max(floor, end - (count - i))));
}

/**
 * The client half: the transcript after a switch or an edit. Everything above
 * the alternative that was shown stays as it is; it and everything after it
 * give way to the new branch's rows. Null when the replaced row is not loaded
 * (the caller reads the newest page instead).
 */
export function replaceBranchTail<T extends { id: string }>(current: readonly T[], replacedId: string, path: readonly T[]): T[] | null {
  const at = current.findIndex((message) => message.id === replacedId);
  if (at === -1) return null;
  return [...current.slice(0, at), ...path];
}

/** One imported message with the branch columns its export carried (src/app/api/import). */
export interface ImportedBranchRow {
  /** The new row's id. */
  id: string;
  createdAt: Date;
  /** The id it had in the export. */
  sourceId?: string;
  parentSourceId?: string | null;
  branchGroupSourceId?: string | null;
  onActivePath?: boolean;
  branchSelected?: boolean;
}

export interface RestoredBranchRow {
  id: string;
  parentId: string | null;
  branchGroupId: string | null;
  onActivePath: boolean;
  branchSelected: boolean;
}

/**
 * The branch columns of an imported conversation, from an export made with
 * every branch (`/api/account/export?branches=all`), in the new rows' ids.
 *
 * Null when there is nothing to restore (a linear export), and null when the
 * tree does not hold together — a pointer to a message the file does not
 * carry, a child older than its parent, or a shown branch that is not one
 * line from the first message to the last. A file like that was edited by
 * hand, and it imports linear and whole, as every import did before
 * branches, rather than as a tree the transcript would draw wrongly.
 */
export function restoreImportedBranches(rows: readonly ImportedBranchRow[]): RestoredBranchRow[] | null {
  if (!rows.some((row) => typeof row.onActivePath === "boolean")) return null;
  const ordered = [...rows].sort(threadOrder);
  const position = new Map(ordered.map((row, i) => [row.id, i]));
  const bySource = new Map<string, string>();
  for (const row of ordered) if (row.sourceId) bySource.set(row.sourceId, row.id);
  const resolve = (sourceId: string | null | undefined): string | null | undefined => {
    if (sourceId == null) return null;
    return bySource.get(sourceId);
  };

  const restored: RestoredBranchRow[] = [];
  for (const row of ordered) {
    const parentId = resolve(row.parentSourceId);
    const branchGroupId = resolve(row.branchGroupSourceId);
    if (parentId === undefined || branchGroupId === undefined) return null;
    if (parentId && position.get(parentId)! >= position.get(row.id)!) return null;
    const onActivePath = row.onActivePath ?? true;
    restored.push({ id: row.id, parentId, branchGroupId, onActivePath, branchSelected: row.branchSelected ?? onActivePath });
  }
  const shown = restored.filter((row) => row.onActivePath);
  if (shown.length === 0) return null;
  for (let i = 0; i < shown.length; i++) {
    const parent = shown[i].parentId;
    if (parent !== null && (i === 0 || parent !== shown[i - 1].id)) return null;
  }
  return restored;
}
