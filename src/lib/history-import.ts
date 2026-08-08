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

export type ImportFormat = "chatgpt" | "claude" | "gemini";

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
  const candidateNames = new Set(["conversations.json", "My Activity.json", "my_activity.json", "gemini.json"]);
  const hits = zipEntries
    .filter((path) => !path.endsWith("/") && candidateNames.has(path.split("/").pop() ?? ""))
    .sort((a, b) => {
      const rank = (path: string) => (path.split("/").pop() === "conversations.json" ? 0 : 1);
      return rank(a) - rank(b) || a.split("/").length - b.split("/").length;
    });
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
  if ([...names].some((name) => /gemini|my activity/i.test(name))) return "gemini";
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
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** ISO string (Claude) → Date, rejecting unparseable values. */
function dateFromIso(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Gemini/Takeout exports use a mixture of ISO strings and epoch values. */
function dateFromFlexible(...values: unknown[]): Date | null {
  for (const value of values) {
    if (typeof value === "number" && value > 100_000_000_000) {
      const milliseconds = new Date(value);
      if (!Number.isNaN(milliseconds.getTime())) return milliseconds;
    }
    const epoch = dateFromEpochSeconds(value);
    if (epoch) return epoch;
    const iso = dateFromIso(value);
    if (iso) return iso;
  }
  return null;
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
// Gemini / Google Takeout (shape-tolerant)
// ---------------------------------------------------------------------------

function textFromGeminiContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    return value.map(textFromGeminiContent).filter(Boolean).join("\n\n").trim();
  }
  if (!isRecord(value)) return "";
  for (const key of ["text", "content", "parts", "value"]) {
    const text = textFromGeminiContent(value[key]);
    if (text) return text;
  }
  return "";
}

function geminiRole(value: Record<string, unknown>): "user" | "assistant" | null {
  const author = isRecord(value.author) ? value.author : null;
  const raw = String(value.role ?? value.sender ?? value.authorRole ?? author?.role ?? "").toLowerCase();
  if (["user", "human", "person"].includes(raw)) return "user";
  if (["assistant", "model", "gemini", "bard", "system"].includes(raw)) return raw === "system" ? null : "assistant";
  return null;
}

function parseGeminiConversation(item: Record<string, unknown>): ImportedConversation | null {
  const conversation = isRecord(item.conversation) ? item.conversation : item;
  const messages =
    (Array.isArray(conversation.messages) && conversation.messages) ||
    (Array.isArray(conversation.turns) && conversation.turns) ||
    (Array.isArray(item.messages) && item.messages) ||
    (Array.isArray(item.turns) && item.turns) ||
    [];
  if (messages.length === 0) return null;

  const raw: { role: "user" | "assistant"; content: string; createdAt: Date | null }[] = [];
  for (const entry of messages) {
    if (!isRecord(entry)) continue;
    const role = geminiRole(entry);
    if (!role) continue;
    const text = textFromGeminiContent(entry.content ?? entry.parts ?? entry.text ?? entry.message);
    if (!text) continue;
    raw.push({
      role,
      content: clampContent(text),
      createdAt: dateFromFlexible(entry.createTime, entry.createdAt, entry.created_at, entry.time, entry.timestamp),
    });
  }
  if (raw.length === 0) return null;

  const createdAt =
    dateFromFlexible(
      conversation.createTime,
      conversation.createdAt,
      conversation.created_at,
      item.createTime,
      item.createdAt,
      item.created_at,
      item.time,
    ) ?? raw.find((message) => message.createdAt)?.createdAt ?? new Date();
  const title = cleanTitle(conversation.title ?? conversation.name ?? item.title ?? item.name);
  return { title, createdAt, messages: normalizeMessageDates(createdAt, raw) };
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
  const items = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.conversations)
      ? data.conversations
      : isRecord(data) && Array.isArray(data.chats)
        ? data.chats
        : null;
  if (!items) throw new HistoryImportError("This file doesn't look like a ChatGPT, Claude, or Gemini export.");

  const sample = items.find(isRecord);
  const sniffedFormat: ImportFormat | null = sample
    ? "mapping" in sample
      ? "chatgpt"
        : "chat_messages" in sample
          ? "claude"
          : "messages" in sample || "turns" in sample || "conversation" in sample
            ? "gemini"
        : null
    : null;
  const format: ImportFormat | null = sniffedFormat ?? formatHint;
  if (!format) {
    throw new HistoryImportError("This file doesn't look like a ChatGPT, Claude, or Gemini export.");
  }

  const parse = format === "chatgpt" ? parseChatGptConversation : format === "claude" ? parseClaudeConversation : parseGeminiConversation;
  const conversations: ImportedConversation[] = [];
  let skipped = 0;
  for (const item of items) {
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
