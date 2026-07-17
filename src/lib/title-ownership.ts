import type { TitleSource } from "@/types/chat";

const CHAT_DEFAULTS = new Set(["", "new chat", "untitled", "untitled chat", "new project"]);
const PROJECT_DEFAULTS = new Set(["", "new project", "untitled", "untitled project"]);

/** Placeholder title for a fresh kind:"code" session. Code sessions are not
 *  chats, so the schema's "New chat" default read wrong in the sidebar — but
 *  the row must still be titled at create (the column is NOT NULL), so this is
 *  a real value the auto-titler is expected to replace. */
export const DEFAULT_CODE_SESSION_TITLE = "New session";
// "new chat" stays in the set: sessions created before the code default landed
// carry the schema default, and their first prompt must still be able to name
// them. Both are placeholders — neither was ever chosen by a user.
const CODE_SESSION_DEFAULTS = new Set(["", "new session", "new chat", "untitled", "untitled session"]);

function normalize(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function compact(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function placeholderFromPrompt(prompt: string, max = 48): string {
  const text = compact(prompt);
  return text.length > max ? text.slice(0, max - 1).trimEnd() + "..." : text;
}

export function coerceTitleSource(value: unknown): TitleSource {
  // "imported" (history import) behaves like "manual": the title came from the
  // source product and the auto-titler must never rename it.
  if (value === "imported") return "manual";
  return value === "ai" || value === "manual" || value === "default" ? value : "default";
}

export function isDefaultChatTitle(title: string | null | undefined): boolean {
  return CHAT_DEFAULTS.has(normalize(title));
}

/** True when a code session still carries an auto-assigned placeholder title,
 *  i.e. the first prompt may name it. Pair with titleSource === "default" so a
 *  user who deliberately renamed a session to "New session" keeps it. */
export function isDefaultCodeSessionTitle(title: string | null | undefined): boolean {
  return CODE_SESSION_DEFAULTS.has(normalize(title));
}

export function isPromptPlaceholderTitle(title: string | null | undefined, firstUserText: string | null | undefined): boolean {
  if (!title || !firstUserText?.trim()) return false;
  const normalizedTitle = normalize(title);
  const asciiPlaceholder = normalize(placeholderFromPrompt(firstUserText));
  const compactPrompt = compact(firstUserText);
  const ellipsisPlaceholder =
    compactPrompt.length > 48 ? normalize(compactPrompt.slice(0, 47).trimEnd() + "\u2026") : normalize(compactPrompt);
  return normalizedTitle === asciiPlaceholder || normalizedTitle === ellipsisPlaceholder;
}

export function canAutoRenameChatTitle(opts: {
  title: string | null | undefined;
  titleSource: unknown;
  firstUserText?: string | null;
}): boolean {
  const source = coerceTitleSource(opts.titleSource);
  if (source === "manual") return false;
  if (source === "ai") return true;
  return isDefaultChatTitle(opts.title) || isPromptPlaceholderTitle(opts.title, opts.firstUserText) || source === "default";
}

export function canAutoRenameProjectName(opts: { name: string | null | undefined; nameSource: unknown }): boolean {
  const source = coerceTitleSource(opts.nameSource);
  if (source === "manual") return false;
  if (source === "ai") return true;
  return PROJECT_DEFAULTS.has(normalize(opts.name)) || source === "default";
}
