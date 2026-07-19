/**
 * Client-side ledger of generations that may still be finishing server-side
 * after the browser stream dropped (tab close, route change, flaky network).
 *
 * Survives remounts via sessionStorage so reopening a chat can reattach to the
 * answer the server is still writing — ChatGPT/Claude-style background work.
 */

export type PendingGeneration = {
  conversationId: string;
  userMessageId: string | null;
  generationId?: string | null;
  startedAt: number;
};

const STORAGE_KEY = "juno:pending-generations";
/** Drop ledger rows older than this — matches a long reasoning window. */
const MAX_AGE_MS = 45 * 60_000;

function readAll(): PendingGeneration[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PendingGeneration[];
    if (!Array.isArray(parsed)) return [];
    const cutoff = Date.now() - MAX_AGE_MS;
    return parsed.filter(
      (row) =>
        row &&
        typeof row.conversationId === "string" &&
        typeof row.startedAt === "number" &&
        row.startedAt >= cutoff
    );
  } catch {
    return [];
  }
}

function writeAll(rows: PendingGeneration[]) {
  if (typeof window === "undefined") return;
  try {
    if (rows.length === 0) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(rows));
  } catch {
    /* private mode / quota — recovery still works for the live tab */
  }
}

/** Remember that this conversation may still be generating after a drop. */
export function markPendingGeneration(entry: PendingGeneration): void {
  const rows = readAll().filter((r) => r.conversationId !== entry.conversationId);
  rows.push(entry);
  writeAll(rows);
}

/** Clear when the answer arrives or the user starts a new turn. */
export function clearPendingGeneration(conversationId: string): void {
  writeAll(readAll().filter((r) => r.conversationId !== conversationId));
}

export function getPendingGeneration(conversationId: string): PendingGeneration | null {
  return readAll().find((r) => r.conversationId === conversationId) ?? null;
}

export function listPendingGenerations(): PendingGeneration[] {
  return readAll();
}
