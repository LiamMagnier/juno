/*
 * Client-side model for the memory page: shared types, the local "edits ledger"
 * (drafted natural-language edits awaiting review), and the summary parser.
 *
 * Facts and the consolidated summary live server-side (Prisma). Drafted edits
 * are review-state only, so they live in localStorage per user — applying one
 * goes through /api/memory/edit/apply, which is the real write.
 */

export interface Memory {
  id: string;
  content: string;
  source: "AUTO" | "MANUAL";
  /** FACT = remembered · SUPPRESSION = "never remember this" (block-list). */
  kind: "FACT" | "SUPPRESSION";
  /** conversationId | "manual" | "edit" — where this entry came from. */
  sourceRef: string | null;
  createdAt: string;
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
// Edits ledger (localStorage)
// ---------------------------------------------------------------------------

const LEDGER_CAP = 20;
const ledgerKey = (userId: string) => `juno.memory.edits.${userId}`;

export function loadEdits(userId: string): MemoryEditRecord[] {
  try {
    const raw = localStorage.getItem(ledgerKey(userId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (e): e is MemoryEditRecord =>
          !!e &&
          typeof e.id === "string" &&
          typeof e.instruction === "string" &&
          ["pending", "applied", "rejected"].includes(e.status) &&
          Array.isArray(e.operations)
      )
      .slice(0, LEDGER_CAP);
  } catch {
    return [];
  }
}

export function saveEdits(userId: string, edits: MemoryEditRecord[]): void {
  try {
    localStorage.setItem(ledgerKey(userId), JSON.stringify(edits.slice(0, LEDGER_CAP)));
  } catch {
    // Storage full/unavailable — the ledger is a convenience, never critical.
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
