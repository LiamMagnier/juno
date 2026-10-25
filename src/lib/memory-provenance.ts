import { PRODUCT_NAME } from "@/lib/brand/names";
import { MEMORY_STATUS_META, isMemoryStatus, memoryCategoryLabel } from "@/lib/memory-categories";
import { sensitiveTopicLabel, sensitiveTopicOf } from "@/lib/memory-sensitive";
import { topicOfStatement } from "@/lib/memory-topics";

/**
 * WHY, WHEN AND FROM WHERE — the answer to "how do you know that?", for one
 * remembered fact, in one shape every surface can show.
 *
 * The columns have existed since Memory v2 (sourceRef, sourceMessageId,
 * observedAt, reason, supersededById), but each surface assembled its own
 * reading of them, and the readings disagreed: the memory page dated every
 * fact by `createdAt` — when Juno WROTE it down — so a fact re-read out of a
 * year-old chat said "learned today", and nothing named the chat it came from,
 * only "From a chat". This module is the one reading:
 *
 *   source   where it came from — a chat (named, or "a chat you've since
 *            deleted"), the memory page, an edit you asked for, another device,
 *            an import — with a link to the exact message when that is known.
 *   when     when you SAID it (observedAt), when Juno wrote it down, when you
 *            last confirmed it, when it was last used in an answer, and when
 *            it stops being true.
 *   scope    every chat, or only one project's.
 *   status   in use or not, and the reason it last changed, in words.
 *   basis    stated or inferred, so the reader knows how much to trust it.
 *   why      all of it as one sentence.
 *
 * And the HISTORY of a fact: what it replaced and what replaced it, walked
 * through `supersededById` — the trail supersession keeps instead of deleting
 * the older belief.
 *
 * Pure: no Prisma, no session. The route supplies the conversation's title
 * (or that it no longer exists) and the project's name.
 */

export type MemorySourceKind = "chat" | "manual" | "edit" | "native" | "import" | "forget" | "unknown";

/** The minimum of a stored entry provenance needs. */
export interface ProvenanceEntry {
  id: string;
  content: string;
  source: string;
  kind: string;
  sourceRef: string | null;
  sourceMessageId: string | null;
  category: string | null;
  projectId: string | null;
  confidence: number;
  status: string;
  reason: string | null;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  lastVerifiedAt: Date | null;
  supersededById: string | null;
  createdAt: Date;
  observedAt?: Date | null;
}

/** sourceRef values that are words, not a conversation id. */
const WORD_SOURCES: Record<string, Exclude<MemorySourceKind, "chat" | "unknown">> = {
  manual: "manual",
  edit: "edit",
  native: "native",
  import: "import",
  forget: "forget",
};

export function memorySourceKind(entry: Pick<ProvenanceEntry, "sourceRef">): MemorySourceKind {
  const ref = entry.sourceRef?.trim();
  if (!ref) return "unknown";
  return WORD_SOURCES[ref] ?? "chat";
}

/**
 * What the route knows about the chat a fact came from:
 *   { id, title } — it exists and belongs to the reader;
 *   null          — it was looked up and is gone (deleted);
 *   undefined     — not looked up (a list that did not resolve titles).
 */
export type ProvenanceConversation = { id: string; title: string } | null | undefined;

export interface MemoryProvenance {
  source: {
    kind: MemorySourceKind;
    /** One short phrase: "From “Moving”", "You added this", "From a chat you've since deleted". */
    label: string;
    conversationId: string | null;
    conversationTitle: string | null;
    /** True when the chat it came from has been deleted. The fact stays yours; the link cannot. */
    conversationDeleted: boolean;
    messageId: string | null;
    /** Where to read it in context, when that still exists. */
    href: string | null;
  };
  when: {
    /** When you said it — the source message's time, or when Juno wrote it down for rows older than that column. */
    saidAt: string;
    /** When Juno wrote it down. */
    recordedAt: string;
    /** When you last said it again, if later than the first time. */
    lastConfirmedAt: string | null;
    /** When an answer last used it. */
    lastUsedAt: string | null;
    /** When it stops being true (temporary facts). */
    expiresAt: string | null;
  };
  scope: { kind: "account" | "project"; projectId: string | null; label: string };
  status: { value: string; label: string; inUse: boolean; reason: string | null };
  basis: { stated: boolean; confidence: number; label: string };
  category: { value: string | null; label: string };
  /** The sensitive topic it falls under, recomputed from the text; null when none. */
  sensitive: { topic: string; label: string } | null;
  /** For a block-list row that excludes a whole topic: the topic. */
  excludedTopic: string | null;
  /** All of the above as one sentence. */
  why: string;
}

/** Inferred, not told: the same threshold the memory page uses for its "Inferred" mark. */
export const INFERRED_BELOW = 0.6;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "3 Oct 2026", in UTC — deterministic on the server; the ISO fields are there for the client to localise. */
export function provenanceDate(date: Date): string {
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function quoteTitle(title: string): string {
  const clean = title.replace(/\s+/g, " ").trim() || "Untitled chat";
  return `“${clean.length > 60 ? `${clean.slice(0, 59).trimEnd()}…` : clean}”`;
}

export function memoryProvenance(
  entry: ProvenanceEntry,
  ctx: { conversation?: ProvenanceConversation; projectName?: string | null; now?: Date } = {}
): MemoryProvenance {
  const now = ctx.now ?? new Date();
  const kind = memorySourceKind(entry);
  const saidAt = entry.observedAt ?? entry.createdAt;
  const confirmed =
    entry.lastVerifiedAt && entry.lastVerifiedAt.getTime() - saidAt.getTime() > 60_000 ? entry.lastVerifiedAt : null;
  const stated = entry.source === "MANUAL" || entry.confidence >= INFERRED_BELOW;

  // ---- source -------------------------------------------------------------
  const conversationId = kind === "chat" ? entry.sourceRef : null;
  const conversation = kind === "chat" ? ctx.conversation : undefined;
  const conversationDeleted = kind === "chat" && conversation === null;
  const conversationTitle = conversation ? conversation.title : null;
  const href =
    conversationId && !conversationDeleted
      ? `/chat/${conversationId}${entry.sourceMessageId ? `?m=${encodeURIComponent(entry.sourceMessageId)}` : ""}`
      : null;
  const sourceLabel = (() => {
    switch (kind) {
      case "manual":
        return "You added this";
      case "edit":
        return "From an edit you asked for";
      case "native":
        return "You added this on another device";
      case "import":
        return "Imported from another assistant";
      case "forget":
        return "From something you asked to forget";
      case "chat":
        if (conversationDeleted) return "From a chat you’ve since deleted";
        return conversationTitle !== null ? `From ${quoteTitle(conversationTitle)}` : "From a chat";
      default:
        return entry.source === "MANUAL" ? `You told ${PRODUCT_NAME}` : "From your chats";
    }
  })();

  // ---- scope, status, basis -----------------------------------------------
  const scope =
    entry.projectId === null
      ? { kind: "account" as const, projectId: null, label: "Every chat" }
      : { kind: "project" as const, projectId: entry.projectId, label: `Only in ${ctx.projectName ?? "one project"}` };
  const expired = entry.expiresAt !== null && entry.expiresAt.getTime() <= now.getTime();
  const statusValue = entry.status === "active" && expired ? "expired" : entry.status;
  const statusLabel = isMemoryStatus(statusValue) ? MEMORY_STATUS_META[statusValue].label : "Unknown";
  const inUse = entry.kind === "FACT" && statusValue === "active";
  const topic = sensitiveTopicOf(entry.content);
  const excludedTopic = entry.kind === "SUPPRESSION" ? topicOfStatement(entry.content) : null;

  // ---- why ----------------------------------------------------------------
  const on = provenanceDate(saidAt);
  const where =
    kind === "chat"
      ? conversationDeleted
        ? "in a chat you’ve since deleted"
        : conversationTitle !== null
          ? `in ${quoteTitle(conversationTitle)}`
          : "in a chat"
      : null;
  const parts: string[] = [];
  if (entry.kind === "SUPPRESSION") {
    parts.push(
      excludedTopic
        ? `You asked ${PRODUCT_NAME} on ${on} never to remember anything about “${excludedTopic}”.`
        : `You asked ${PRODUCT_NAME} to forget this on ${on}, so it is never learned again.`
    );
  } else {
    switch (kind) {
      case "manual":
        parts.push(`You added this yourself on ${on}.`);
        break;
      case "edit":
        parts.push(`It comes from an edit you asked for on ${on}.`);
        break;
      case "native":
        parts.push(`You added this on another device on ${on}.`);
        break;
      case "import":
        parts.push(`It was imported from another assistant on ${on}.`);
        break;
      case "chat":
        parts.push(
          entry.source === "MANUAL"
            ? `You said this ${where} on ${on}, and confirmed it yourself.`
            : stated
              ? `You said this ${where} on ${on}.`
              : `${PRODUCT_NAME} inferred this ${where} on ${on} — you didn’t say it outright.`
        );
        break;
      default:
        parts.push(
          entry.source === "MANUAL" ? `You told ${PRODUCT_NAME} this on ${on}.` : `${PRODUCT_NAME} learned this from your chats on ${on}.`
        );
    }
    if (confirmed) parts.push(`You said it again on ${provenanceDate(confirmed)}.`);
    parts.push(scope.kind === "account" ? "It can be used in any chat." : `It is only used in ${ctx.projectName ?? "its project"}.`);
    if (!inUse) parts.push(entry.reason ?? (isMemoryStatus(statusValue) ? MEMORY_STATUS_META[statusValue].description : "It is not used."));
    else if (entry.expiresAt) parts.push(`It stops being used after ${provenanceDate(entry.expiresAt)}.`);
  }

  return {
    source: {
      kind,
      label: sourceLabel,
      conversationId,
      conversationTitle,
      conversationDeleted,
      messageId: kind === "chat" ? entry.sourceMessageId : null,
      href,
    },
    when: {
      saidAt: saidAt.toISOString(),
      recordedAt: entry.createdAt.toISOString(),
      lastConfirmedAt: iso(confirmed),
      lastUsedAt: iso(entry.lastUsedAt),
      expiresAt: iso(entry.expiresAt),
    },
    scope,
    status: { value: statusValue, label: statusLabel, inUse, reason: entry.reason },
    basis: {
      stated,
      confidence: entry.confidence,
      label: entry.source === "MANUAL" ? "You said it" : stated ? "Stated in a chat" : "Inferred",
    },
    category: { value: entry.category, label: memoryCategoryLabel(entry.category) },
    sensitive: topic ? { topic, label: sensitiveTopicLabel(topic) } : null,
    excludedTopic,
    why: parts.join(" "),
  };
}

// ---------------------------------------------------------------------------
// History — what a fact replaced, and what replaced it
// ---------------------------------------------------------------------------

export interface HistoryEntry {
  id: string;
  content: string;
  status: string;
  reason: string | null;
  source: string;
  kind: string;
  supersededById: string | null;
  createdAt: Date;
  observedAt?: Date | null;
}

export interface MemoryHistoryStep {
  id: string;
  content: string;
  status: string;
  reason: string | null;
  source: string;
  saidAt: string;
  recordedAt: string;
}

export interface MemoryHistory {
  /** Older beliefs this one replaced (directly or through others), oldest first. */
  earlier: MemoryHistoryStep[];
  entry: MemoryHistoryStep;
  /** What replaced this one, in order, ending at whatever replaced it last. */
  later: MemoryHistoryStep[];
  /** The belief that stands today on this chain, or null when nothing does (forgotten, expired, deleted). */
  current: MemoryHistoryStep | null;
}

/** How many steps either way a history follows — a chain is a handful of moves, never hundreds. */
export const HISTORY_LIMIT = 25;

function step(entry: HistoryEntry): MemoryHistoryStep {
  return {
    id: entry.id,
    content: entry.content,
    status: entry.status,
    reason: entry.reason,
    source: entry.source,
    saidAt: (entry.observedAt ?? entry.createdAt).toISOString(),
    recordedAt: entry.createdAt.toISOString(),
  };
}

/**
 * The supersession trail through one fact. Null when `id` is not among
 * `entries` (the caller has already checked ownership; `entries` are the
 * reader's own rows).
 *
 * Forward: follow `supersededById` until it ends, guarding against a cycle a
 * hand-edited row could create. Backward: every row that names this one (or
 * one of its predecessors) as its replacement — a merge can retire several
 * rows into one, so this is a tree walked breadth first and flattened by when
 * each was said.
 */
export function memoryHistory(entries: readonly HistoryEntry[], id: string): MemoryHistory | null {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const self = byId.get(id);
  if (!self) return null;

  const later: HistoryEntry[] = [];
  const seen = new Set<string>([self.id]);
  let cursor = self.supersededById ? byId.get(self.supersededById) : undefined;
  while (cursor && !seen.has(cursor.id) && later.length < HISTORY_LIMIT) {
    seen.add(cursor.id);
    later.push(cursor);
    cursor = cursor.supersededById ? byId.get(cursor.supersededById) : undefined;
  }

  const replacedBy = new Map<string, HistoryEntry[]>();
  for (const entry of entries) {
    if (!entry.supersededById) continue;
    const list = replacedBy.get(entry.supersededById) ?? [];
    list.push(entry);
    replacedBy.set(entry.supersededById, list);
  }
  const earlier: HistoryEntry[] = [];
  const frontier = [self.id];
  const visited = new Set<string>([self.id, ...later.map((entry) => entry.id)]);
  while (frontier.length > 0 && earlier.length < HISTORY_LIMIT) {
    const next = frontier.shift()!;
    for (const older of replacedBy.get(next) ?? []) {
      if (visited.has(older.id)) continue;
      visited.add(older.id);
      earlier.push(older);
      frontier.push(older.id);
      if (earlier.length >= HISTORY_LIMIT) break;
    }
  }
  const saidAt = (entry: HistoryEntry) => (entry.observedAt ?? entry.createdAt).getTime();
  earlier.sort((a, b) => saidAt(a) - saidAt(b) || a.createdAt.getTime() - b.createdAt.getTime());

  const last = later.length > 0 ? later[later.length - 1] : self;
  return {
    earlier: earlier.map(step),
    entry: step(self),
    later: later.map(step),
    current: last.kind === "FACT" && last.status === "active" ? step(last) : null,
  };
}
