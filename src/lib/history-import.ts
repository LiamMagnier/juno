/*
 * Parsers for ChatGPT and Claude data-export ZIPs. Both providers ship a
 * conversations.json inside the archive, but the shapes differ completely:
 *
 *  - ChatGPT: each conversation is a mapping TREE of nodes; the canonical
 *    thread is the `current_node` parent chain (regenerated branches hang off
 *    dead siblings). Timestamps are epoch seconds.
 *  - Claude: each conversation is a flat chat_messages[] with human/assistant
 *    senders and ISO timestamps.
 *
 * This module only normalizes to ImportedConversation — the API route
 * (src/app/api/import/route.ts) owns dedupe, encryption, and persistence.
 */

export type ImportFormat = "chatgpt" | "claude";

export interface ImportedMessage {
  role: "user" | "assistant";
  content: string;
  createdAt: Date;
}

export interface ImportedConversation {
  title: string;
  createdAt: Date;
  messages: ImportedMessage[];
}

export interface ParsedHistoryExport {
  format: ImportFormat;
  conversations: ImportedConversation[];
  /** Conversations dropped by the parser (empty threads + overflow past the cap). */
  skipped: number;
}

/** Errors safe to show verbatim to the uploader (bad ZIP contents, not bugs). */
export class HistoryImportError extends Error {}

export const MAX_IMPORT_CONVERSATIONS = 500;
export const MAX_IMPORT_MESSAGE_CHARS = 100_000;
const MAX_TITLE_CHARS = 200; // matches the conversation PATCH schema

// ---------------------------------------------------------------------------
// ZIP-level detection
// ---------------------------------------------------------------------------

/**
 * Path of the conversations.json entry, or null. Both exports keep it at the
 * root, but some unzip-and-rezip flows nest everything one folder deep, so
 * match by basename and prefer the shallowest hit.
 */
export function findConversationsEntry(zipEntries: string[]): string | null {
  const hits = zipEntries
    .filter((path) => !path.endsWith("/") && path.split("/").pop() === "conversations.json")
    .sort((a, b) => a.split("/").length - b.split("/").length);
  return hits[0] ?? null;
}

/**
 * Best-effort provider detection from entry names alone: ChatGPT archives ship
 * chat.html / user.json, Claude archives ship projects.json / users.json.
 * Only a hint — parseHistoryExport sniffs the actual JSON shape, which wins.
 */
export function detectFormat(zipEntries: string[]): ImportFormat | null {
  if (!findConversationsEntry(zipEntries)) return null;
  const names = new Set(zipEntries.map((path) => path.split("/").pop() ?? path));
  if (names.has("chat.html") || names.has("user.json") || names.has("message_feedback.json")) return "chatgpt";
  if (names.has("projects.json") || names.has("users.json")) return "claude";
  return null;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return (title || "Imported chat").slice(0, MAX_TITLE_CHARS);
}

function clampContent(text: string): string {
  return text.length > MAX_IMPORT_MESSAGE_CHARS ? text.slice(0, MAX_IMPORT_MESSAGE_CHARS) : text;
}

/** Epoch seconds (ChatGPT) → Date, rejecting junk like 0 or negative values. */
function dateFromEpochSeconds(value: unknown): Date | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1000) : null;
}

/** ISO string (Claude) → Date, rejecting unparseable values. */
function dateFromIso(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Fill missing message dates and force a strictly-increasing sequence so the
 * thread renders in import order (messages are sorted by createdAt on read,
 * and equal timestamps would make the ordering nondeterministic).
 */
function normalizeMessageDates(
  conversationCreatedAt: Date,
  messages: { role: "user" | "assistant"; content: string; createdAt: Date | null }[],
): ImportedMessage[] {
  let previous = conversationCreatedAt.getTime();
  return messages.map((message) => {
    const raw = message.createdAt?.getTime();
    const time = raw != null && raw > previous ? raw : previous + 1000;
    previous = time;
    return { role: message.role, content: message.content, createdAt: new Date(time) };
  });
}

// ---------------------------------------------------------------------------
// ChatGPT (mapping tree)
// ---------------------------------------------------------------------------

/** Visible text of one ChatGPT node: string parts joined, tool payloads ignored. */
function chatGptMessageText(message: Record<string, unknown>): string {
  const content = message.content;
  if (!isRecord(content)) return "";
  if (Array.isArray(content.parts)) {
    // Non-string parts are image/file pointers — nothing importable in them.
    return content.parts.filter((part): part is string => typeof part === "string").join("\n\n").trim();
  }
  // content_type "code" and friends carry a bare text field.
  return typeof content.text === "string" ? content.text.trim() : "";
}

function parseChatGptConversation(item: Record<string, unknown>): ImportedConversation | null {
  const mapping = item.mapping;
  if (!isRecord(mapping)) return null;

  // Canonical thread = current_node's parent chain, root-first. The seen-set
  // guards against cyclic parent pointers in a hand-edited export.
  const chain: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  let nodeId = typeof item.current_node === "string" ? item.current_node : null;
  while (nodeId && !seen.has(nodeId)) {
    seen.add(nodeId);
    const node = mapping[nodeId];
    if (!isRecord(node)) break;
    chain.push(node);
    nodeId = typeof node.parent === "string" ? node.parent : null;
  }
  chain.reverse();

  const raw: { role: "user" | "assistant"; content: string; createdAt: Date | null }[] = [];
  for (const node of chain) {
    const message = node.message;
    if (!isRecord(message)) continue;
    const author = isRecord(message.author) ? message.author : null;
    const role = author?.role;
    if (role !== "user" && role !== "assistant") continue; // drops system + tool
    // recipient !== "all" means the model was talking to a tool (python, browser…).
    if (typeof message.recipient === "string" && message.recipient !== "all") continue;
    const text = chatGptMessageText(message);
    if (!text) continue;
    raw.push({ role, content: clampContent(text), createdAt: dateFromEpochSeconds(message.create_time) });
  }
  if (raw.length === 0) return null;

  const createdAt =
    dateFromEpochSeconds(item.create_time) ?? raw.find((m) => m.createdAt)?.createdAt ?? new Date();
  return { title: cleanTitle(item.title), createdAt, messages: normalizeMessageDates(createdAt, raw) };
}

// ---------------------------------------------------------------------------
// Claude (flat chat_messages)
// ---------------------------------------------------------------------------

/** Visible text of one Claude message: top-level text, else the text content blocks. */
function claudeMessageText(message: Record<string, unknown>): string {
  if (typeof message.text === "string" && message.text.trim()) return message.text.trim();
  if (Array.isArray(message.content)) {
    return message.content
      .filter((block): block is Record<string, unknown> => isRecord(block) && block.type === "text")
      .map((block) => (typeof block.text === "string" ? block.text : ""))
      .filter(Boolean)
      .join("\n\n")
      .trim();
  }
  return "";
}

function parseClaudeConversation(item: Record<string, unknown>): ImportedConversation | null {
  if (!Array.isArray(item.chat_messages)) return null;

  const raw: { role: "user" | "assistant"; content: string; createdAt: Date | null }[] = [];
  for (const entry of item.chat_messages) {
    if (!isRecord(entry)) continue;
    const role = entry.sender === "human" ? "user" : entry.sender === "assistant" ? "assistant" : null;
    if (!role) continue;
    const text = claudeMessageText(entry);
    if (!text) continue;
    raw.push({ role, content: clampContent(text), createdAt: dateFromIso(entry.created_at) });
  }
  if (raw.length === 0) return null;

  const createdAt = dateFromIso(item.created_at) ?? raw.find((m) => m.createdAt)?.createdAt ?? new Date();
  return { title: cleanTitle(item.name), createdAt, messages: normalizeMessageDates(createdAt, raw) };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Parse the raw text of conversations.json into normalized conversations.
 * The format is sniffed from the JSON shape (`mapping` vs `chat_messages`),
 * falling back to `formatHint` from detectFormat for empty/ambiguous files.
 * Throws HistoryImportError with an uploader-facing message on junk input.
 */
export function parseHistoryExport(raw: string, formatHint: ImportFormat | null = null): ParsedHistoryExport {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new HistoryImportError("conversations.json in this ZIP isn't valid JSON — re-download the export and try again.");
  }
  if (!Array.isArray(data)) {
    throw new HistoryImportError("conversations.json doesn't look like a ChatGPT or Claude export.");
  }

  const sample = data.find(isRecord);
  const format: ImportFormat | null = sample
    ? "mapping" in sample
      ? "chatgpt"
      : "chat_messages" in sample
        ? "claude"
        : null
    : formatHint;
  if (!format) {
    throw new HistoryImportError("conversations.json doesn't look like a ChatGPT or Claude export.");
  }

  const parse = format === "chatgpt" ? parseChatGptConversation : parseClaudeConversation;
  const conversations: ImportedConversation[] = [];
  let skipped = 0;
  for (const item of data) {
    const parsed = isRecord(item) ? parse(item) : null;
    if (!parsed) {
      skipped += 1;
      continue;
    }
    if (conversations.length >= MAX_IMPORT_CONVERSATIONS) {
      skipped += 1;
      continue;
    }
    conversations.push(parsed);
  }
  return { format, conversations, skipped };
}
