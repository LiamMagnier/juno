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
import { coerceTitleSource } from "@/lib/title-ownership";
import { resolveModel } from "@/lib/models";
import { estimateCostUsd } from "@/lib/pricing";
import { coerceChatOrigin } from "@/lib/chat-origin";

const ACTIVITY_KINDS = new Set<ClientActivityEvent["kind"]>([
  "context",
  "model",
  "reasoning",
  "search",
  "visit",
  "write",
  "usage",
  "done",
  "warning",
  "tool",
]);

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

function serializeActivity(raw: unknown): ClientActivityEvent[] | undefined {
  if (!Array.isArray(raw)) return undefined;

  const events = raw.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const kind = typeof record.kind === "string" && ACTIVITY_KINDS.has(record.kind as ClientActivityEvent["kind"]) ? record.kind : "";
    const title = typeof record.title === "string" ? record.title : "";
    const createdAt = typeof record.createdAt === "string" ? record.createdAt : "";
    if (!id || !kind || !title || !createdAt) return [];

    return [
      {
        id,
        kind: kind as ClientActivityEvent["kind"],
        title,
        detail: typeof record.detail === "string" ? record.detail : undefined,
        url: typeof record.url === "string" ? record.url : undefined,
        createdAt,
      },
    ];
  });

  return events.length ? events : undefined;
}

export async function serializeAttachment(att: Attachment): Promise<ClientAttachment> {
  return {
    id: att.id,
    kind: att.kind,
    fileName: att.fileName,
    mimeType: att.mimeType,
    size: att.size,
    url: await getViewUrl(att.storageKey),
    width: att.width,
    height: att.height,
  };
}

/** The lightweight `versions` relation slice serializeMessage understands (see the pager in message-item). */
type MessageVersionMeta = Pick<MessageVersion, "id" | "model" | "createdAt">;

export async function serializeMessage(
  msg: Message & { attachments: Attachment[]; versions?: MessageVersionMeta[] }
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
    activity: serializeActivity(msg.activity),
    promptTokens: msg.promptTokens,
    completionTokens: msg.completionTokens,
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

export function serializeConversation(conv: Conversation): ClientConversation {
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
