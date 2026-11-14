import "server-only";
import { parseRoutingReceipt } from "@/lib/router/receipt";
import { refreshResearchFacts } from "@/lib/research/working-time";
import type {
  Attachment,
  Artifact,
  ArtifactProposal,
  ArtifactVersion,
  Conversation,
  Message,
  MessageVersion,
  Prisma,
} from "@prisma/client";
import { artifactVersionWindow } from "@/lib/artifact-access";
import { getViewUrl } from "@/lib/storage";
import type {
  ClientActivityEvent,
  ClientArtifact,
  ClientAttachment,
  ClientConversation,
  ClientMessage,
  ClientMessageBranch,
  ClientSource,
} from "@/types/chat";
import type { ArtifactType } from "@/lib/message-content";
import { decryptMessageTextSafe } from "@/lib/message-crypto";
import { decryptJsonField } from "@/lib/field-crypto";
import { coerceTitleSource } from "@/lib/title-ownership";
import { resolveModel } from "@/lib/models";
import { estimateCostUsd } from "@/lib/pricing";
import { coerceChatOrigin } from "@/lib/chat-origin";
import { serializeActivity as readActivity } from "@/lib/chat/run-record";

/**
 * Decrypt the stored reasoning parts back into plain strings.
 *
 * `undefined` (not `[]`) for anything that is not a real array of strings —
 * NULL from a message written before the column existed, or from a provider
 * that never sent boundaries. The panel reads that absence as "no steps exist"
 * and shows the collapsed reasoning alone, which is the honest rendering for
 * both cases: the structure was never there to recover.
 */
function serializeReasoningParts(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const parts = raw.filter((p): p is string => typeof p === "string").map((p) => decryptMessageTextSafe(p));
  return parts.length ? parts : undefined;
}

/** Unseal a message's activity before applying the shared field whitelist. */
function serializeActivity(stored: unknown): ClientActivityEvent[] | undefined {
  const raw = decryptJsonField(stored);
  return readActivity(raw);
}

/**
 * The only attachment columns the client shape needs.
 *
 * Notably NOT `extractedText`, which holds up to 200,000 characters of document
 * text per row and is used solely to build model context. Selecting it into a
 * thread load pulled it out of Postgres and discarded it — see
 * ATTACHMENT_CLIENT_SELECT in lib/queries.
 */
export type AttachmentForClient = Pick<
  Attachment,
  "id" | "kind" | "fileName" | "mimeType" | "size" | "storageKey" | "width" | "height"
> &
  // Optional, because half the callers select the columns above by name and
  // adding a required field to that list would break every one of them at
  // once. Absent reads as "not known here", which is the truth.
  Partial<Pick<Attachment, "parserState">>;

export async function serializeAttachment(att: AttachmentForClient): Promise<ClientAttachment> {
  return {
    id: att.id,
    kind: att.kind,
    fileName: att.fileName,
    mimeType: att.mimeType,
    size: att.size,
    url: await getViewUrl(att.storageKey),
    width: att.width,
    height: att.height,
    // How far the indexer has got. The composer reads it to say whether the
    // file can actually be read before you spend a message finding out.
    parserState: att.parserState ?? undefined,
  };
}

/** The lightweight `versions` relation slice serializeMessage understands (see the pager in message-item). */
type MessageVersionMeta = Pick<MessageVersion, "id" | "model" | "createdAt">;

export async function serializeMessage(
  msg: Message & {
    attachments: AttachmentForClient[];
    versions?: MessageVersionMeta[];
    /** Its place among its alternatives, when the reader computed it (src/lib/chat/branches.ts). */
    branch?: ClientMessageBranch | null;
  }
): Promise<ClientMessage> {
  // Prefer the exact cost written at generation time (includes cache writes +
  // tool fees). Recomputing from token counts alone systematically under-bills
  // Anthropic 1h cache and web search — the bug that showed "~$0.0006".
  const model = msg.model ? resolveModel(msg.model) : null;
  const storedMicro = (msg as { costMicroUsd?: number | null }).costMicroUsd;
  const costUsd =
    storedMicro != null && storedMicro > 0
      ? storedMicro / 1_000_000
      : model && (msg.promptTokens != null || msg.completionTokens != null)
        ? estimateCostUsd(model, { input: msg.promptTokens ?? 0, output: msg.completionTokens ?? 0 })
        : undefined;
  return {
    id: msg.id,
    role: msg.role,
    content: decryptMessageTextSafe(msg.content),
    reasoning: msg.reasoning != null ? decryptMessageTextSafe(msg.reasoning) : undefined,
    reasoningParts: serializeReasoningParts(msg.reasoningParts),
    model: msg.model,
    feedback: msg.feedback,
    createdAt: msg.createdAt.toISOString(),
    attachments: await Promise.all(msg.attachments.map(serializeAttachment)),
    sources: (msg.sources as ClientSource[] | null) ?? undefined,
    // A research message's "Researched for" comes from its run, never the stored figure.
    activity: await refreshResearchFacts(serializeActivity(msg.activity), msg.conversationId),
    promptTokens: msg.promptTokens,
    completionTokens: msg.completionTokens,
    // The prompt-cache split, straight off the row. `?? undefined` so a NULL
    // column drops the key from the JSON entirely, which is the same shape the
    // private path's live frame produces — one representation of "unknown" on
    // the wire instead of two. NEVER `?? 0`: rows written before the column
    // existed, and providers that report no cache buckets, are unknown, and a
    // zero here would render every one of them as a total cache miss.
    cacheReadTokens: msg.cacheReadTokens ?? undefined,
    cacheWriteTokens: msg.cacheWriteTokens ?? undefined,
    costUsd,
    // Auto's receipt, when Auto routed this turn. Malformed or absent → none.
    routing: parseRoutingReceipt((msg as { routing?: unknown }).routing) ?? undefined,
    conversationId: msg.conversationId,
    // Prior contents preserved across regenerate/edit-and-resend (oldest first).
    // Metadata only — the client pages content in via GET /api/messages/[id]/versions.
    versions: msg.versions?.length
      ? msg.versions.map((v) => ({ id: v.id, model: v.model, createdAt: v.createdAt.toISOString() }))
      : undefined,
    // The "‹ 2/3 ›" pager across branches. Absent for a message with no alternatives.
    branch: msg.branch ?? undefined,
  };
}

/** Clamp the free-text DB column to the union the client understands. */
function normalizeVersionOrigin(raw: string | null): "generated" | "edit" | "restore" | null {
  return raw === "generated" || raw === "edit" || raw === "restore" ? raw : null;
}

/**
 * What an owner's artifact read includes: the newest window of versions, the
 * newest PENDING suggestion (the re-emit guard) as a label and never its
 * content, and the design editor's working copy.
 *
 * `take: 1` on proposals because only the newest can be applied: writing a
 * suggestion marks every earlier PENDING one for that artifact STALE.
 *
 * Sync does not use this; neither suggestions nor drafts are ever synced.
 */
export const ARTIFACT_CLIENT_INCLUDE = {
  versions: artifactVersionWindow,
  proposals: {
    where: { status: "PENDING" },
    orderBy: { createdAt: "desc" },
    take: 1,
    select: { id: true, baseVersion: true, messageId: true, summary: true, createdAt: true },
  },
  draft: { select: { content: true, updatedAt: true } },
} satisfies Prisma.ArtifactInclude;

/**
 * The same read without the working copy: what the generic REST route answers.
 * The installed Mac and iPhone builds read it, and they must see sealed
 * versions only — a draft is the web editor's, and a "version" that is not a
 * row yet would be cached under a number whose body can still change.
 */
export const ARTIFACT_SEALED_INCLUDE = {
  versions: artifactVersionWindow,
  proposals: ARTIFACT_CLIENT_INCLUDE.proposals,
} satisfies Prisma.ArtifactInclude;

type SerializableSuggestion = Pick<ArtifactProposal, "id" | "baseVersion" | "messageId" | "summary" | "createdAt">;

/**
 * Typed by what it reads, so a narrower select or an older fixture still
 * type-checks; a full row satisfies it unchanged.
 */
type SerializableArtifact = Pick<
  Artifact,
  "id" | "identifier" | "type" | "title" | "language" | "currentVersion" | "messageId" | "createdAt" | "updatedAt"
> &
  Partial<Pick<Artifact, "deletedAt">> & {
    versions: Pick<ArtifactVersion, "version" | "content" | "origin" | "createdAt">[];
    proposals?: SerializableSuggestion[];
    draft?: { content: string; updatedAt: Date } | null;
  };

/**
 * `hasOlderVersions`, `deletedAt`, `pendingSuggestion` and the draft entry are
 * added ONLY WHEN SET, so a live artifact with a short history, nothing
 * waiting and no draft serializes to exactly the object it always did.
 *
 * A draft is presented as the version it will become when sealed
 * (`currentVersion + 1`, marked `draft: true`), because that is what the
 * editor is showing and what a save based on it will find: every write seals
 * the draft first, so the draft becomes exactly that version.
 */
export function serializeArtifact(art: SerializableArtifact): ClientArtifact {
  const sorted = [...art.versions].sort((a, b) => a.version - b.version);
  const head = sorted.find((v) => v.version === art.currentVersion) ?? sorted[sorted.length - 1];
  const out: ClientArtifact = {
    id: art.id,
    identifier: art.identifier,
    type: art.type as ArtifactType,
    title: art.title,
    language: art.language,
    currentVersion: art.currentVersion,
    content: head?.content ?? "",
    versions: sorted.map((v) => ({ version: v.version, content: v.content, origin: normalizeVersionOrigin(v.origin), createdAt: v.createdAt.toISOString() })),
    messageId: art.messageId,
    createdAt: art.createdAt.toISOString(),
    updatedAt: art.updatedAt.toISOString(),
  };
  if (sorted.length > 0 && sorted[0].version > 1) out.hasOlderVersions = true;
  if (art.draft) {
    const working = art.currentVersion + 1;
    out.versions.push({
      version: working,
      content: art.draft.content,
      origin: "edit",
      createdAt: art.draft.updatedAt.toISOString(),
      draft: true,
    });
    out.currentVersion = working;
    out.content = art.draft.content;
  }
  if (art.deletedAt) out.deletedAt = art.deletedAt.toISOString();
  const suggestion = art.proposals?.[0];
  if (suggestion) {
    out.pendingSuggestion = {
      id: suggestion.id,
      baseVersion: suggestion.baseVersion,
      messageId: suggestion.messageId,
      summary: suggestion.summary,
      createdAt: suggestion.createdAt.toISOString(),
    };
  }
  return out;
}

/**
 * Typed by WHAT IT READS, not by the whole row.
 *
 * `listConversations` names an explicit `select` so 200 rows of the sidebar's
 * list do not carry four columns no client looks at into the RSC payload. A
 * `Conversation` parameter would reject that narrower object, and widening the
 * select back to satisfy the type is the tail wagging the dog. A full row still
 * satisfies this, so every other caller is unchanged — and adding a field here
 * without adding it to that select is now a type error rather than a silent
 * `undefined`.
 */
type SerializableConversation = Pick<
  Conversation,
  | "id"
  | "title"
  | "titleSource"
  | "model"
  | "origin"
  | "kind"
  | "codeWorkspaceName"
  | "codeWorkspacePath"
  | "codeWorkspaceKey"
  | "pinned"
  | "folderId"
  | "projectId"
  | "activeConnectors"
  | "memoryOff"
  | "archivedAt"
  | "lastMessageAt"
  | "createdAt"
>;

export function serializeConversation(conv: SerializableConversation): ClientConversation {
  return {
    id: conv.id,
    title: conv.title,
    titleSource: coerceTitleSource(conv.titleSource),
    model: conv.model,
    origin: coerceChatOrigin(conv.origin),
    kind: conv.kind === "code" ? "code" : "chat",
    codeWorkspaceName: conv.codeWorkspaceName ?? null,
    codeWorkspacePath: conv.codeWorkspacePath ?? null,
    codeWorkspaceKey: conv.codeWorkspaceKey ?? null,
    pinned: conv.pinned,
    folderId: conv.folderId,
    projectId: conv.projectId,
    activeConnectors: conv.activeConnectors,
    memoryOff: conv.memoryOff,
    archivedAt: conv.archivedAt?.toISOString() ?? null,
    lastMessageAt: conv.lastMessageAt.toISOString(),
    createdAt: conv.createdAt.toISOString(),
  };
}
