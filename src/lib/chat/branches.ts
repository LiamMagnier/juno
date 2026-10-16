import "server-only";
import { Prisma, type Role } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { BRANCH_COPY_ORIGIN } from "@/lib/library-removal-policy";
import {
  adoptedVersionTimes,
  isRefusal,
  pathTo,
  planFork,
  planSelect,
  shownPath,
  siblingPositions,
  threadOrder,
  type BranchChange,
  type BranchNode,
  type BranchRefusal,
  type ForkPlan,
  type RestoredBranchRow,
} from "@/lib/chat/branch-model";
import type { ClientMessageBranch } from "@/types/chat";

/*
 * Branches in a conversation: the database half. The rules, and why the
 * columns are what they are, are in branch-model.ts.
 *
 * Every operation that moves the shown path runs in one transaction that
 * first locks the Conversation row. A message insert takes a key-share lock on
 * the same row (its foreign key), so a reply landing while a branch is being
 * switched waits for the switch and then follows the path it left behind,
 * rather than attaching itself to a branch that was halfway through moving.
 */

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
type Db = Tx | typeof prisma;

/**
 * The shown path. Every reader of a transcript — paging, the model's history,
 * search, sharing, export, memory, native sync — filters messages with this,
 * so a conversation with branches still reads as one linear thread.
 */
export const ON_ACTIVE_PATH = { onActivePath: true } as const;

export type BranchedNode = BranchNode & { role: Role };

const NODE_SELECT = {
  id: true,
  role: true,
  parentId: true,
  branchGroupId: true,
  branchSelected: true,
  onActivePath: true,
  createdAt: true,
} as const;

/** The branch columns of a new sibling, as `forkMessage` hands them to its writer. */
export interface BranchFields {
  parentId: string | null;
  branchGroupId: string;
  branchSelected: boolean;
  onActivePath: boolean;
}

async function lockConversation(tx: Tx, conversationId: string): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "Conversation" WHERE "id" = ${conversationId} FOR UPDATE`;
}

/** Every message of a conversation, branch columns only (a few dozen bytes a row). */
export function loadBranchNodes(db: Db, conversationId: string): Promise<BranchedNode[]> {
  return db.message.findMany({ where: { conversationId }, select: NODE_SELECT });
}

async function applyBranchChange(tx: Tx, conversationId: string, change: BranchChange): Promise<void> {
  if (change.parents.size > 0) {
    const ids = [...change.parents.keys()];
    const parents = ids.map((id) => change.parents.get(id)!);
    await tx.$executeRaw`
      UPDATE "Message" AS m
         SET "parentId" = v."parent"
        FROM unnest(${ids}::text[], ${parents}::text[]) AS v("id", "parent")
       WHERE m."id" = v."id" AND m."conversationId" = ${conversationId}
    `;
  }
  const byGroup = new Map<string, string[]>();
  for (const [id, groupId] of change.groups) byGroup.set(groupId, [...(byGroup.get(groupId) ?? []), id]);
  for (const [groupId, ids] of byGroup) {
    await tx.message.updateMany({ where: { conversationId, id: { in: ids } }, data: { branchGroupId: groupId } });
  }
  const write = async (ids: Set<string>, data: Prisma.MessageUpdateManyMutationInput) => {
    if (ids.size > 0) await tx.message.updateMany({ where: { conversationId, id: { in: [...ids] } }, data });
  };
  await write(change.deactivate, { onActivePath: false });
  await write(change.activate, { onActivePath: true });
  await write(change.unselect, { branchSelected: false });
  await write(change.select, { branchSelected: true });
}

/**
 * Shared links made before branches read "the shown path up to snapshotAt".
 * Before the path first moves, each one is pinned to the leaf it showed, so
 * an edit after sharing never changes a public page.
 */
async function pinUnpinnedShares(tx: Tx, userId: string, conversationId: string, nodes: readonly BranchNode[]): Promise<void> {
  const shares = await tx.share.findMany({
    where: { userId, conversationId, kind: "CHAT", revokedAt: null, leafMessageId: null },
    select: { id: true, snapshotAt: true },
  });
  if (shares.length === 0) return;
  const path = shownPath(nodes);
  for (const share of shares) {
    const leaf = path.filter((node) => node.createdAt <= share.snapshotAt).at(-1);
    if (leaf) await tx.share.updateMany({ where: { id: share.id, userId }, data: { leafMessageId: leaf.id } });
  }
}

/**
 * The earlier wordings and answers an in-place edit or regenerate kept, before
 * branches, as MessageVersion rows: moved into the target's group as hidden
 * siblings, so the one pager shows them with the new alternatives. Ciphertext
 * is copied verbatim (message-crypto is row-independent). Done inside the
 * operation's transaction, so no reader ever sees one both ways.
 */
async function adoptLegacyVersions(
  tx: Tx,
  conversationId: string,
  target: BranchedNode,
  plan: Pick<ForkPlan, "parentId" | "groupId">,
  nodes: readonly BranchNode[],
): Promise<number> {
  const versions = await tx.messageVersion.findMany({
    where: { messageId: target.id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (versions.length === 0) return 0;
  const parentCreatedAt = plan.parentId ? nodes.find((node) => node.id === plan.parentId)?.createdAt ?? null : null;
  const times = adoptedVersionTimes(target.createdAt, parentCreatedAt, versions.length);
  await tx.message.createMany({
    data: versions.map((version, i) => ({
      conversationId,
      role: target.role,
      content: version.content,
      reasoning: version.reasoning,
      model: version.model,
      promptTokens: version.promptTokens,
      completionTokens: version.completionTokens,
      sources: version.sources === null ? Prisma.DbNull : (version.sources as Prisma.InputJsonValue),
      createdAt: times[i],
      parentId: plan.parentId,
      branchGroupId: plan.groupId,
      branchSelected: false,
      onActivePath: false,
    })),
  });
  await tx.messageVersion.deleteMany({ where: { messageId: target.id } });
  return versions.length;
}

/**
 * Add an alternative to a message, inside the caller's transaction: the target
 * and everything after it leave the shown path (kept, not deleted) and the row
 * `create` writes takes their place. `create` receives the branch columns and
 * returns the row it wrote, with whatever include the caller needs.
 */
export async function forkMessage<T>(
  tx: Tx,
  input: { userId: string; conversationId: string; targetId: string; allowOffPath?: boolean },
  create: (fields: BranchFields) => Promise<T>,
): Promise<{ created: T; plan: ForkPlan } | BranchRefusal> {
  await lockConversation(tx, input.conversationId);
  const nodes = await loadBranchNodes(tx, input.conversationId);
  const plan = planFork(nodes, input.targetId, { allowOffPath: input.allowOffPath });
  if (isRefusal(plan)) return plan;
  if (plan.shown) await pinUnpinnedShares(tx, input.userId, input.conversationId, nodes);
  await adoptLegacyVersions(tx, input.conversationId, nodes.find((node) => node.id === input.targetId)!, plan, nodes);
  await applyBranchChange(tx, input.conversationId, plan.change);
  // A suggestion lives as long as the reply that made it is the one being
  // read: the replies leaving the path retire theirs, as an overwritten or
  // deleted reply always did. Applying a canvas change from a reply nobody is
  // looking at would be a change with no visible cause.
  if (plan.hidden.length > 0) {
    await tx.artifactProposal.updateMany({
      where: { messageId: { in: plan.hidden }, status: "PENDING" },
      data: { status: "STALE", resolvedAt: new Date() },
    });
  }
  const created = await create({
    parentId: plan.parentId,
    branchGroupId: plan.groupId,
    branchSelected: plan.shown,
    onActivePath: plan.shown,
  });
  return { created, plan };
}

export interface SelectedBranch {
  conversationId: string;
  /** The alternative that was shown before; the client replaces from it on. */
  replacedId: string;
  /** The new shown rows from the selected message to the leaf. */
  path: string[];
  changed: boolean;
}

/**
 * Where a reply that replaces nothing is written (a new turn's answer, a
 * room's next member, an edited question's first answer), decided inside the
 * caller's transaction under the conversation lock, so a branch switch
 * cannot land between this read and the insert.
 *
 *  - Its question is no longer shown (switched away from on another device
 *    while the reply was written): it stays with that question, hidden, and
 *    comes back when that branch is shown.
 *  - Its question is the shown leaf: it records it as its parent.
 *  - Otherwise (something else was appended after the question meanwhile)
 *    it records nothing and follows the shown leaf, like every writer that
 *    knows nothing about branches. Naming a parent in the middle of the shown
 *    path would give that row two shown children, and the next branch switch
 *    could walk down only one of them, leaving the other hidden with no pager
 *    to bring it back.
 */
export async function replyPlacement(
  tx: Tx,
  conversationId: string,
  answersMessageId: string | null,
): Promise<{ parentId?: string; onActivePath?: boolean }> {
  await lockConversation(tx, conversationId);
  if (!answersMessageId) return {};
  const parent = await tx.message.findFirst({
    where: { id: answersMessageId, conversationId },
    select: { id: true, onActivePath: true },
  });
  if (!parent) return {};
  if (!parent.onActivePath) return { parentId: parent.id, onActivePath: false };
  return (await shownLeafId(tx, conversationId)) === parent.id ? { parentId: parent.id } : {};
}

/** Show the branch a message starts. Scoped to the owner; another account's message is "missing". */
export async function selectBranch(userId: string, messageId: string): Promise<SelectedBranch | BranchRefusal> {
  const message = await prisma.message.findFirst({
    where: { id: messageId, conversation: { userId } },
    select: { conversationId: true },
  });
  if (!message) return { refused: "missing" };
  const conversationId = message.conversationId;
  return prisma.$transaction(async (tx) => {
    await lockConversation(tx, conversationId);
    const nodes = await loadBranchNodes(tx, conversationId);
    const plan = planSelect(nodes, messageId);
    if (isRefusal(plan)) return plan;
    if (plan.changed) {
      await pinUnpinnedShares(tx, userId, conversationId, nodes);
      await applyBranchChange(tx, conversationId, plan.change);
    }
    return { conversationId, replacedId: plan.replacedId, path: plan.path, changed: plan.changed };
  });
}

/**
 * An edited question's files: each live attachment of the original copied onto
 * the new sibling, reusing the stored object (the Library-clone mechanism,
 * src/lib/library-attach.ts), so each branch owns its own rows and neither
 * loses a file when the other is removed.
 */
export async function copyMessageAttachments(
  tx: Tx,
  userId: string,
  link: { fromMessageId: string; toMessageId: string; conversationId: string },
): Promise<number> {
  const sources = await tx.attachment.findMany({
    where: { userId, messageId: link.fromMessageId, deletedAt: null },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  for (const src of sources) {
    const copy = await tx.attachment.create({
      data: {
        userId,
        conversationId: link.conversationId,
        messageId: link.toMessageId,
        kind: src.kind,
        fileName: src.fileName,
        mimeType: src.mimeType,
        size: src.size,
        storageKey: src.storageKey,
        extractedText: src.extractedText,
        width: src.width,
        height: src.height,
        origin: BRANCH_COPY_ORIGIN,
        parserState: src.parserState,
        parserVersion: src.parserVersion,
        projectId: src.projectId,
      },
    });
    await tx.attachmentVersion.create({
      data: {
        attachmentId: copy.id,
        version: copy.version,
        origin: BRANCH_COPY_ORIGIN,
        kind: copy.kind,
        fileName: copy.fileName,
        mimeType: copy.mimeType,
        size: copy.size,
        storageKey: copy.storageKey,
        extractedText: copy.extractedText,
        parserState: copy.parserState,
        parserVersion: copy.parserVersion,
      },
    });
  }
  return sources.length;
}

/**
 * An imported conversation's branch tree, written once its rows exist
 * (src/app/api/import; the rules are `restoreImportedBranches`).
 */
export async function writeRestoredBranches(tx: Tx, conversationId: string, rows: readonly RestoredBranchRow[]): Promise<void> {
  if (rows.length === 0) return;
  await tx.$executeRaw`
    UPDATE "Message" AS m
       SET "parentId" = v."parent",
           "branchGroupId" = v."grp",
           "onActivePath" = v."shown",
           "branchSelected" = v."selected"
      FROM unnest(
             ${rows.map((row) => row.id)}::text[],
             ${rows.map((row) => row.parentId)}::text[],
             ${rows.map((row) => row.branchGroupId)}::text[],
             ${rows.map((row) => row.onActivePath)}::boolean[],
             ${rows.map((row) => row.branchSelected)}::boolean[]
           ) AS v("id", "parent", "grp", "shown", "selected")
     WHERE m."id" = v."id" AND m."conversationId" = ${conversationId}
  `;
}

/** An earlier version's metadata, as `ClientMessage.versions` carries it. */
export interface BranchVersionMeta {
  id: string;
  model: string | null;
  createdAt: Date;
}

/**
 * The alternatives at each given row's point of the thread: pager positions
 * (rows with no alternatives are absent) and every member's metadata.
 */
async function branchMembers(
  db: Db,
  conversationId: string,
  rows: ReadonlyArray<{ id: string; branchGroupId: string | null }>,
): Promise<{ positions: Map<string, ClientMessageBranch>; byId: Map<string, BranchVersionMeta> }> {
  const groups = [...new Set(rows.map((row) => row.branchGroupId).filter((id): id is string => !!id))];
  if (groups.length === 0) return { positions: new Map(), byId: new Map() };
  const members = await db.message.findMany({
    where: { conversationId, branchGroupId: { in: groups } },
    select: { id: true, branchGroupId: true, createdAt: true, model: true },
  });
  return { positions: siblingPositions(members), byId: new Map(members.map((m) => [m.id, { id: m.id, model: m.model, createdAt: m.createdAt }])) };
}

/** Pager positions for the given rows of one conversation; rows with no alternatives are absent. */
export async function branchPositions(
  db: Db,
  conversationId: string,
  rows: ReadonlyArray<{ id: string; branchGroupId: string | null }>,
): Promise<Map<string, ClientMessageBranch>> {
  return (await branchMembers(db, conversationId, rows)).positions;
}

/**
 * The rows with their pager position attached, for serializeMessage.
 *
 * Also `versions` for the apps, which page through a message's earlier
 * versions (`versions`, then GET /api/messages/{id}/versions) and do not read
 * `branch` yet: the alternatives before this one stand in for them, as the
 * older answers and wordings they showed before branches. The web reads
 * `branch` whenever it is there. A row that still has MessageVersion rows of
 * its own (it has never branched) keeps them.
 */
export async function withBranchPositions<T extends { id: string; branchGroupId: string | null; versions?: BranchVersionMeta[] }>(
  db: Db,
  conversationId: string,
  rows: readonly T[],
): Promise<Array<T & { branch: ClientMessageBranch | null }>> {
  const { positions, byId } = await branchMembers(db, conversationId, rows);
  return rows.map((row) => {
    const branch = positions.get(row.id) ?? null;
    if (!branch || row.versions?.length) return { ...row, branch };
    const versions = branch.siblingIds.slice(0, branch.index).flatMap((id) => byId.get(id) ?? []);
    return { ...row, branch, versions };
  });
}

/**
 * The alternatives before a message, oldest first, for GET
 * /api/messages/{id}/versions: what `withBranchPositions` lists as its
 * `versions`. Empty for a message with no alternatives.
 */
export async function earlierAlternatives(db: Db, message: { id: string; conversationId: string; branchGroupId: string | null }) {
  if (!message.branchGroupId) return [];
  const group = (
    await db.message.findMany({ where: { conversationId: message.conversationId, branchGroupId: message.branchGroupId } })
  ).sort(threadOrder);
  const at = group.findIndex((row) => row.id === message.id);
  return at <= 0 ? [] : group.slice(0, at);
}

/** The ids of the path that ends at a message, root first; null when it is not in the conversation. */
export async function pathIdsTo(db: Db, conversationId: string, leafId: string): Promise<string[] | null> {
  return pathTo(await loadBranchNodes(db, conversationId), leafId);
}

/** The last shown message of a conversation, for pinning a new share. */
export async function shownLeafId(db: Db, conversationId: string): Promise<string | null> {
  const leaf = await db.message.findFirst({
    where: { conversationId, ...ON_ACTIVE_PATH },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  return leaf?.id ?? null;
}

export function branchRefusalResponse(refusal: BranchRefusal): { status: number; error: string } {
  switch (refusal.refused) {
    case "missing":
      return { status: 404, error: "Not found" };
    case "off_path":
      return { status: 409, error: "That message is no longer in the branch you are viewing. Reload the chat and try again." };
    case "no_branch":
      return { status: 409, error: "That message has no other versions." };
  }
}
