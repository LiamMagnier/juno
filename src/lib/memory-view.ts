import "server-only";

import { prisma } from "@/lib/prisma";
import { sensitiveTopicOf } from "@/lib/memory-sensitive";
import { memoryProvenance, memorySourceKind, type ProvenanceConversation } from "@/lib/memory-provenance";

/**
 * The one shape a memory entry takes on the wire.
 *
 * Three routes return memory lists — the page load, the reset/refresh, and the
 * apply-an-edit response the page swaps its state for. When they disagreed the
 * bug was invisible in review and obvious in use: applying an edit replaced a
 * fully-annotated list with rows that had lost their category and provenance,
 * so chips vanished from entries that had not changed.
 */
export const MEMORY_ENTRY_SELECT = {
  id: true,
  content: true,
  source: true,
  kind: true,
  sourceRef: true,
  category: true,
  projectId: true,
  sourceMessageId: true,
  confidence: true,
  status: true,
  reason: true,
  expiresAt: true,
  lastUsedAt: true,
  lastVerifiedAt: true,
  supersededById: true,
  createdAt: true,
  // When the person SAID it, as opposed to when Juno wrote it down — the
  // "when" a memory page has to show (memory-provenance.ts).
  observedAt: true,
  project: { select: { name: true } },
} as const;

/** A row selected with MEMORY_ENTRY_SELECT. */
export interface MemoryEntryRow {
  id: string;
  content: string;
  source: string;
  kind: string;
  sourceRef: string | null;
  category: string | null;
  projectId: string | null;
  sourceMessageId: string | null;
  confidence: number;
  status: string;
  reason: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastVerifiedAt: Date | null;
  supersededById: string | null;
  createdAt: Date;
  observedAt: Date | null;
  project: { name: string } | null;
}

/**
 * The chats the rows came from, by id: `{ id, title }` for one that still
 * exists, `null` for one that has been deleted. One query for a whole list,
 * scoped to the reader — a conversation id in another account resolves to
 * "deleted", never to its title.
 */
export async function loadProvenanceConversations(
  userId: string,
  rows: readonly Pick<MemoryEntryRow, "sourceRef">[]
): Promise<Map<string, { id: string; title: string } | null>> {
  const ids = [
    ...new Set(rows.filter((row) => memorySourceKind(row) === "chat").map((row) => row.sourceRef!.trim())),
  ];
  const found = ids.length
    ? await prisma.conversation.findMany({ where: { userId, id: { in: ids } }, select: { id: true, title: true } })
    : [];
  const byId = new Map(found.map((row) => [row.id, row]));
  return new Map(ids.map((id) => [id, byId.get(id) ?? null]));
}

/**
 * One row on the wire. `conversations` (from loadProvenanceConversations)
 * lets the provenance name the chat a fact came from, or say it is deleted;
 * without it the provenance says "a chat".
 */
export function serializeMemoryEntry(
  row: MemoryEntryRow,
  conversations?: ReadonlyMap<string, { id: string; title: string } | null>
) {
  const { project, ...entry } = row;
  const conversation: ProvenanceConversation =
    conversations && memorySourceKind(row) === "chat" ? conversations.get(row.sourceRef!.trim()) ?? null : undefined;
  return {
    ...entry,
    // Why, when and from where, in one shape — the page, the native app and
    // the export read the same answer (memory-provenance.ts).
    provenance: memoryProvenance(row, { conversation, projectName: project?.name ?? null }),
    observedAt: entry.observedAt?.toISOString() ?? null,
    // Computed, never stored — see the header of memory-sensitive.ts. Sent on
    // every entry so the page can flag a row whatever build wrote it, including
    // the rows that predate the gate entirely.
    sensitive: sensitiveTopicOf(row.content),
    // The project's NAME, not just its id: the memory page has to be able to
    // say "only in Thesis" without a second round-trip per entry.
    projectName: project?.name ?? null,
    expiresAt: entry.expiresAt?.toISOString() ?? null,
    lastUsedAt: entry.lastUsedAt?.toISOString() ?? null,
    lastVerifiedAt: entry.lastVerifiedAt?.toISOString() ?? null,
    createdAt: entry.createdAt.toISOString(),
  };
}
