/*
 * Client-side model for the memory page: shared types, the client for the
 * server-synced edits ledger, and the summary parser.
 *
 * Facts and the consolidated summary live server-side (Prisma), and since
 * Memory v3 so does the edits ledger (/api/memory/edits) — it began life in
 * localStorage, which meant the review queue silently diverged across devices
 * and an applied edit's Undo existed only on the machine that applied it.
 * What remains local is a one-time migration of any stranded ledger.
 */

export interface Memory {
  id: string;
  content: string;
  source: "AUTO" | "MANUAL";
  /** FACT = remembered · SUPPRESSION = "never remember this" (block-list). */
  kind: "FACT" | "SUPPRESSION";
  /** conversationId | "manual" | "edit" | "forget" — where this entry came from. */
  sourceRef: string | null;
  createdAt: string;
  // --- Memory v2. Widened rather than narrowed on purpose: `category` and
  // `status` arrive as plain strings because a row written by an older build
  // has no category at all, and a row written by a NEWER one could carry a
  // value this bundle has never heard of. The page renders both as unknown
  // instead of crashing on a value it cannot name.
  category: string | null;
  projectId: string | null;
  /** Resolved server-side so a scope chip needs no second request. */
  projectName: string | null;
  /** The message this was learned from, when it is known. */
  sourceMessageId: string | null;
  confidence: number;
  status: string;
  /** Why the entry last changed, in words. */
  reason: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  lastVerifiedAt: string | null;
  supersededById: string | null;
}

export interface SummaryData {
  content: string;
  updatedAt: string;
  entryCount: number;
}

export type Operation =
  | { op: "add"; content: string; suppress?: boolean }
  | { op: "update"; id: string; before: string; content: string }
  | { op: "remove"; id: string; before: string };

export type EditStatus = "pending" | "applied" | "rejected";

export interface MemoryEditRecord {
  id: string;
  /** The user's instruction, verbatim. */
  instruction: string;
  /** One-line description of the change, written by the model. */
  summary?: string;
  /** Why the instruction was rejected (refusal or stale facts). */
  note?: string;
  operations: Operation[];
  /** Present once applied — the operations that undo this edit. */
  inverse?: Operation[];
  status: EditStatus;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Edits ledger (server-synced)
// ---------------------------------------------------------------------------

/** One cap, shared with the API routes, so client and server cannot disagree
 *  about how much history the ledger keeps. */
export const MEMORY_EDIT_LEDGER_CAP = 20;

/** A record about to be created — `clientId` is the idempotency key, so a
 *  retried create resolves to the same server row rather than a duplicate. */
export interface MemoryEditDraft {
  clientId: string;
  instruction: string;
  summary?: string;
  note?: string;
  status: EditStatus;
  operations: Operation[];
  inverse?: Operation[];
  /** Preserved on the one-time localStorage import; omitted for live edits. */
  createdAt?: string;
}

/** Every ledger call answers with the canonical capped list, newest first —
 *  one source of truth, no client-side merge to get wrong. */
async function ledgerRequest(input: RequestInfo, init?: RequestInit): Promise<MemoryEditRecord[]> {
  const res = await fetch(input, init);
  if (!res.ok) throw new Error("The edit history couldn’t be synced.");
  const data = await res.json().catch(() => ({}));
  return Array.isArray(data.edits) ? data.edits : [];
}

export function fetchEdits(): Promise<MemoryEditRecord[]> {
  return ledgerRequest("/api/memory/edits");
}

export function createEdits(drafts: MemoryEditDraft[]): Promise<MemoryEditRecord[]> {
  return ledgerRequest("/api/memory/edits", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ edits: drafts }),
  });
}

export function updateEdit(
  id: string,
  patch: { status?: EditStatus; note?: string; operations?: Operation[]; inverse?: Operation[] | null }
): Promise<MemoryEditRecord[]> {
  return ledgerRequest(`/api/memory/edits/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

export function deleteEditRecord(id: string): Promise<MemoryEditRecord[]> {
  return ledgerRequest(`/api/memory/edits/${id}`, { method: "DELETE" });
}

const legacyLedgerKey = (userId: string) => `juno.memory.edits.${userId}`;

/**
 * One-time migration of the localStorage-era ledger: push any stranded records
 * to the server, then clear the key. The key is only removed after the POST
 * succeeded — a failed sync keeps the local copy for the next visit, and the
 * server's (userId, clientId) uniqueness makes the retry idempotent.
 */
export async function migrateLegacyEdits(userId: string): Promise<void> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(legacyLedgerKey(userId));
  } catch {
    return; // storage unavailable — nothing to migrate
  }
  if (!raw) return;

  let stranded: MemoryEditRecord[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      stranded = parsed
        .filter(
          (e): e is MemoryEditRecord =>
            !!e &&
            typeof e.id === "string" &&
            typeof e.instruction === "string" &&
            ["pending", "applied", "rejected"].includes(e.status) &&
            Array.isArray(e.operations)
        )
        .slice(0, MEMORY_EDIT_LEDGER_CAP);
    }
  } catch {
    // Unreadable ledger — clear it below rather than re-parsing it forever.
  }

  if (stranded.length > 0) {
    await createEdits(
      stranded.map((edit) => ({
        // The old local id becomes the idempotency key, so importing from two
        // tabs (or after a mid-import crash) cannot duplicate a record.
        clientId: edit.id,
        instruction: edit.instruction,
        summary: edit.summary,
        note: edit.note,
        status: edit.status,
        operations: edit.operations,
        inverse: edit.inverse,
        createdAt: edit.createdAt,
      }))
    );
  }
  try {
    localStorage.removeItem(legacyLedgerKey(userId));
  } catch {
    // Best effort — a surviving key just re-runs the idempotent import.
  }
}

export function newEditId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `edit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Summary parsing — the consolidated summary is Markdown with "## " sections.
// ---------------------------------------------------------------------------

export interface SummarySection {
  title: string;
  body: string;
}

export function parseSummarySections(markdown: string): SummarySection[] {
  const sections: { title: string; body: string[] }[] = [];
  const preamble: string[] = [];
  let current: { title: string; body: string[] } | null = null;

  for (const line of markdown.split("\n")) {
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = { title: heading[1].replace(/[*_`#]/g, "").trim(), body: [] };
      sections.push(current);
    } else if (current) {
      current.body.push(line);
    } else {
      preamble.push(line);
    }
  }

  const out: SummarySection[] = [];
  const pre = preamble.join("\n").trim();
  if (pre) out.push({ title: "About you", body: pre });
  for (const s of sections) {
    const body = s.body.join("\n").trim();
    if (body) out.push({ title: s.title, body });
  }
  return out;
}
