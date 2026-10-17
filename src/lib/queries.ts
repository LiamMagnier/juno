import "server-only";
import { prisma } from "@/lib/prisma";
import { ARTIFACT_CLIENT_INCLUDE, serializeMessage, serializeArtifact, serializeConversation } from "@/lib/serializers";
import type { ClientArtifact, ClientConversation, ClientMessage, ConversationHistory } from "@/types/chat";
import {
  FIRST_PAGE_MESSAGES, NEWEST_FIRST, OLDEST_FIRST, readHistoryPage, type HistoryCursor, type PageRequest,
} from "@/lib/chat/history-page";
import { ON_ACTIVE_PATH, withBranchPositions } from "@/lib/chat/branches";

/**
 * Attachment columns needed to build a ClientAttachment — deliberately without
 * `extractedText`. Kept beside the query rather than in serializers so the
 * `select` and the shape it feeds stay visibly in step.
 */
const ATTACHMENT_CLIENT_SELECT = {
  id: true,
  kind: true,
  fileName: true,
  mimeType: true,
  size: true,
  storageKey: true,
  width: true,
  height: true,
} as const;

export interface ListConversationsOptions {
  q?: string;
  folderId?: string;
  /**
   * Archived chats leave the Recent list but stay readable and searchable, so
   * the default hides them while "only" backs an archive view and "include"
   * keeps them reachable from search.
   */
  archived?: "exclude" | "only" | "include";
}

export async function listConversations(
  userId: string,
  opts: ListConversationsOptions = {}
): Promise<ClientConversation[]> {
  const q = opts.q?.trim();
  const archived = opts.archived ?? "exclude";
  const convos = await prisma.conversation.findMany({
    where: {
      userId,
      ...(opts.folderId ? { folderId: opts.folderId } : {}),
      ...(archived === "only" ? { archivedAt: { not: null } } : archived === "exclude" ? { archivedAt: null } : {}),
      // Message bodies are encrypted at rest (see message-crypto.ts), so SQL
      // `contains` can no longer see them — search matches titles only.
      ...(q ? { title: { contains: q, mode: "insensitive" } } : {}),
    },
    orderBy: [{ pinned: "desc" }, { lastMessageAt: "desc" }],
    /*
     * AN EXPLICIT SELECT, naming exactly what `serializeConversation` reads.
     *
     * Without one Prisma returns all 20 scalar columns, and this list is
     * serialised into the RSC payload of a `force-dynamic` layout — so
     * `userId`, `clientRequestId`, `forkedFromId` and `updatedAt` were
     * downloaded 200 times on every page load and every `router.refresh()`,
     * for four values no client ever reads.
     *
     * It is also the guard: adding a column to the model no longer silently
     * widens this payload, and dropping one from the serialiser without
     * dropping it here is a type error rather than dead weight.
     */
    select: {
      id: true,
      title: true,
      titleSource: true,
      model: true,
      origin: true,
      kind: true,
      codeWorkspaceName: true,
      codeWorkspacePath: true,
      codeWorkspaceKey: true,
      pinned: true,
      folderId: true,
      projectId: true,
      activeConnectors: true,
      archivedAt: true,
      lastMessageAt: true,
      createdAt: true,
    },
    take: 200,
  });
  return convos.map(serializeConversation);
}

export interface ConversationThread {
  conversation: ClientConversation;
  messages: ClientMessage[];
  artifacts: ClientArtifact[];
}

/** A thread opened on its newest page; `history` says how to read further back. */
export interface ConversationThreadPage extends ConversationThread {
  history: ConversationHistory;
}

/**
 * What a transcript row is read with, everywhere a client receives one. Explicit
 * select, not `true`: the full attachment row carries `extractedText`, up to
 * 200,000 characters of document text per attachment, which serializeAttachment
 * does not use. It was being read out of Postgres and thrown away on every
 * thread load. Version metadata only (the pager's "‹ 2/3 ›") — contents stay
 * server-side until GET /api/messages/[id]/versions pages them in.
 */
const MESSAGE_CLIENT_INCLUDE = {
  attachments: { where: { deletedAt: null }, select: ATTACHMENT_CLIENT_SELECT },
  versions: { select: { id: true, model: true, createdAt: true }, orderBy: { createdAt: "asc" as const } },
};

/**
 * readHistoryPage's reads, scoped to one conversation the caller has already
 * checked, and to its shown branch (src/lib/chat/branches.ts): an edited
 * question's earlier answers and a regenerated answer's earlier versions are
 * reached through the pager, never interleaved into the transcript. A
 * deep link to a message on a hidden branch locates nothing and opens the
 * newest page, as a deleted message would.
 */
function messagePageReader(conversationId: string) {
  return {
    newestFirst: (where: object, take: number | undefined) =>
      prisma.message.findMany({ where: { conversationId, ...ON_ACTIVE_PATH, ...where }, orderBy: NEWEST_FIRST, take, include: MESSAGE_CLIENT_INCLUDE }),
    locate: (messageId: string): Promise<HistoryCursor | null> =>
      prisma.message.findFirst({ where: { id: messageId, conversationId, ...ON_ACTIVE_PATH }, select: { id: true, createdAt: true } }),
    count: (where: object) => prisma.message.count({ where: { conversationId, ...ON_ACTIVE_PATH, ...where } }),
  };
}

/** Rows as the client receives them: decrypted, with their pager positions. */
async function serializeRows<T extends Parameters<typeof serializeMessage>[0]>(conversationId: string, rows: readonly T[]): Promise<ClientMessage[]> {
  const positioned = await withBranchPositions(prisma, conversationId, rows);
  return Promise.all(positioned.map((row) => serializeMessage(row)));
}

function readArtifacts(userId: string, conversationId: string) {
  // The chat's artifacts, each with its newest window of versions (the rest
  // page in from /api/artifacts/[id]/versions), a waiting suggestion's label
  // and a design's working copy. Trashed ones are kept (they carry
  // `deletedAt`), so a card can say "In Recently deleted" and offer Restore;
  // every way into the canvas reads the live ones only (`liveArtifacts`).
  return prisma.artifact.findMany({
    where: { conversationId, userId },
    orderBy: { createdAt: "asc" },
    include: ARTIFACT_CLIENT_INCLUDE,
  });
}

/**
 * The whole thread: every message, oldest first. The contract of
 * GET /api/conversations/[id] without paging parameters, which the Mac and
 * iPhone apps read (NativeThreadClient.swift). The web surfaces, Code
 * included, open on getConversationThreadPage instead.
 */
export async function getConversationThread(
  userId: string,
  conversationId: string
): Promise<ConversationThread | null> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
  });
  if (!conversation) return null;

  const [messages, artifacts] = await Promise.all([
    // `use-chat` used to poll this read every 12s for up to an hour to recover
    // a dropped stream; it now asks for the newest page (`?limit=`) instead.
    prisma.message.findMany({ where: { conversationId, ...ON_ACTIVE_PATH }, orderBy: OLDEST_FIRST, include: MESSAGE_CLIENT_INCLUDE }),
    readArtifacts(userId, conversationId),
  ]);

  return {
    conversation: serializeConversation(conversation),
    messages: await serializeRows(conversationId, messages),
    artifacts: artifacts.map(serializeArtifact),
  };
}

/**
 * The thread opened on its newest page (/chat/[id], and the API with
 * `?limit=`). Every artifact still comes with it: they are few, and the cards
 * in any page that is loaded later must find theirs already in hand.
 *
 * `focusMessageId` widens the page back to a deep-linked message (?m=) so it
 * renders with the route instead of after a second request.
 */
export async function getConversationThreadPage(
  userId: string,
  conversationId: string,
  opts: { limit?: number; focusMessageId?: string | null } = {}
): Promise<ConversationThreadPage | null> {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
  });
  if (!conversation) return null;

  const [page, artifacts] = await Promise.all([
    readHistoryPage(messagePageReader(conversationId), {
      limit: opts.limit ?? FIRST_PAGE_MESSAGES,
      throughMessageId: opts.focusMessageId,
    }),
    readArtifacts(userId, conversationId),
  ]);

  return {
    conversation: serializeConversation(conversation),
    messages: await serializeRows(conversationId, page.rows),
    artifacts: artifacts.map(serializeArtifact),
    history: page.history,
  };
}

/**
 * Older messages of a conversation the user owns, for scrolling back
 * (GET /api/conversations/[id]/messages). Null when it is not theirs: another
 * account's conversation and a missing one are the same answer.
 */
export async function getConversationHistory(
  userId: string,
  conversationId: string,
  request: PageRequest
): Promise<{ messages: ClientMessage[]; history: ConversationHistory } | null> {
  const owned = await prisma.conversation.findFirst({
    where: { id: conversationId, userId },
    select: { id: true },
  });
  if (!owned) return null;
  const page = await readHistoryPage(messagePageReader(conversationId), request);
  return { messages: await serializeRows(conversationId, page.rows), history: page.history };
}

/**
 * The shown rows from one message to the leaf, for the client after a branch
 * switch. Null when there are more than `max` of them: the client then reads
 * the newest page instead of being sent a whole branch.
 */
export async function getBranchPath(conversationId: string, ids: readonly string[], max: number): Promise<ClientMessage[] | null> {
  if (ids.length > max) return null;
  const rows = await prisma.message.findMany({
    where: { conversationId, id: { in: [...ids] } },
    orderBy: OLDEST_FIRST,
    include: MESSAGE_CLIENT_INCLUDE,
  });
  return serializeRows(conversationId, rows);
}

/** One row as the client receives it, read with the transcript's include. */
export async function getClientMessage(conversationId: string, messageId: string): Promise<ClientMessage | null> {
  const row = await prisma.message.findFirst({ where: { id: messageId, conversationId }, include: MESSAGE_CLIENT_INCLUDE });
  return row ? (await serializeRows(conversationId, [row]))[0] : null;
}
