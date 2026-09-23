import "server-only";
import type {
  Attachment,
  Artifact,
  ArtifactVersion,
  Conversation,
  Message,
  MessageVersion,
} from "@prisma/client";
import { getViewUrl } from "@/lib/storage";
import type {
  ClientActivityEvent,
  ClientArtifact,
  ClientAttachment,
  ClientConversation,
  ClientMessage,
  ClientSource,
} from "@/types/chat";
import type { ArtifactType } from "@/lib/message-content";
import { decryptMessageTextSafe } from "@/lib/message-crypto";
import { decryptJsonField } from "@/lib/field-crypto";
import { coerceTitleSource } from "@/lib/title-ownership";
import { resolveModel } from "@/lib/models";
import { estimateCostUsd } from "@/lib/pricing";
import { coerceChatOrigin } from "@/lib/chat-origin";
import { serializeActivity } from "@/lib/chat/run-record";

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

/**
 * Rebuild the activity log from the `Message.activity` JSON column.
 *
 * The column is encrypted at rest (src/lib/field-crypto.ts), so the JSON is
 * unsealed FIRST and the field whitelist runs on the recovered structure. Rows
 * written before the backfill have no envelope and come back from
 * `decryptJsonField` unchanged, which is why this needed no version check; a
 * row that cannot be decrypted comes back as null — the same "no activity"
 * rendering a message written before the column existed already gets.
 *
 * The whitelist itself — every field, every typed payload of the chat rework,
 * and the read-time rewrites — is `serializeActivity` in
 * `src/lib/chat/run-record.ts`, which is pure so a test can import it. That is
 * where a new `ClientActivityEvent` field must be read, or it streams live and
 * vanishes on reload.
 */
function serializeStoredActivity(stored: unknown): ClientActivityEvent[] | undefined {
  const raw = decryptJsonField(stored);
  return serializeActivity(raw);
}

export { serializeActivity };

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
  msg: Message & { attachments: AttachmentForClient[]; versions?: MessageVersionMeta[] }
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
    activity: serializeStoredActivity(msg.activity),
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
    conversationId: msg.conversationId,
    // Prior contents preserved across regenerate/edit-and-resend (oldest first).
    // Metadata only — the client pages content in via GET /api/messages/[id]/versions.
    versions: msg.versions?.length
      ? msg.versions.map((v) => ({ id: v.id, model: v.model, createdAt: v.createdAt.toISOString() }))
      : undefined,
  };
}

/** Clamp the free-text DB column to the union the client understands. */
function normalizeVersionOrigin(raw: string | null): "generated" | "edit" | "restore" | null {
  return raw === "generated" || raw === "edit" || raw === "restore" ? raw : null;
}

export function serializeArtifact(art: Artifact & { versions: ArtifactVersion[] }): ClientArtifact {
  const sorted = [...art.versions].sort((a, b) => a.version - b.version);
  const latest = sorted[sorted.length - 1];
  return {
    id: art.id,
    identifier: art.identifier,
    type: art.type as ArtifactType,
    title: art.title,
    language: art.language,
    currentVersion: art.currentVersion,
    content: latest?.content ?? "",
    versions: sorted.map((v) => ({ version: v.version, content: v.content, origin: normalizeVersionOrigin(v.origin), createdAt: v.createdAt.toISOString() })),
    messageId: art.messageId,
    createdAt: art.createdAt.toISOString(),
    updatedAt: art.updatedAt.toISOString(),
  };
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
    archivedAt: conv.archivedAt?.toISOString() ?? null,
    lastMessageAt: conv.lastMessageAt.toISOString(),
    createdAt: conv.createdAt.toISOString(),
  };
}
