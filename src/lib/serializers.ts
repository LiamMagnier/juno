import "server-only";
import type {
  Attachment,
  Artifact,
  ArtifactVersion,
  Conversation,
  Message,
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
import { coerceTitleSource } from "@/lib/title-ownership";

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
]);

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

export async function serializeMessage(msg: Message & { attachments: Attachment[] }): Promise<ClientMessage> {
  return {
    id: msg.id,
    role: msg.role,
    content: msg.content,
    reasoning: msg.reasoning ?? undefined,
    model: msg.model,
    feedback: msg.feedback,
    createdAt: msg.createdAt.toISOString(),
    attachments: await Promise.all(msg.attachments.map(serializeAttachment)),
    sources: (msg.sources as ClientSource[] | null) ?? undefined,
    activity: serializeActivity(msg.activity),
  };
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
    versions: sorted.map((v) => ({ version: v.version, content: v.content, createdAt: v.createdAt.toISOString() })),
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
    pinned: conv.pinned,
    folderId: conv.folderId,
    projectId: conv.projectId,
    lastMessageAt: conv.lastMessageAt.toISOString(),
    createdAt: conv.createdAt.toISOString(),
  };
}
