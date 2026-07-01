import type { TitleSource } from "@/types/chat";

const CHAT_DEFAULTS = new Set(["", "new chat", "untitled", "untitled chat", "new project"]);
const PROJECT_DEFAULTS = new Set(["", "new project", "untitled", "untitled project"]);

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
  return value === "ai" || value === "manual" || value === "default" ? value : "default";
}

export function isDefaultChatTitle(title: string | null | undefined): boolean {
  return CHAT_DEFAULTS.has(normalize(title));
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
