import "server-only";

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
  project: { name: string } | null;
}

export function serializeMemoryEntry(row: MemoryEntryRow) {
  const { project, ...entry } = row;
  return {
    ...entry,
    // The project's NAME, not just its id: the memory page has to be able to
    // say "only in Thesis" without a second round-trip per entry.
    projectName: project?.name ?? null,
    expiresAt: entry.expiresAt?.toISOString() ?? null,
    lastUsedAt: entry.lastUsedAt?.toISOString() ?? null,
    lastVerifiedAt: entry.lastVerifiedAt?.toISOString() ?? null,
    createdAt: entry.createdAt.toISOString(),
  };
}
