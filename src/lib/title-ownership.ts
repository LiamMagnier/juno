import { truncate } from "@/lib/utils";
import type { TitleSource } from "@/types/chat";

/**
 * How much of the first prompt a placeholder title keeps.
 *
 * WAS 48, AND 48 WAS A SIDEBAR NUMBER. The sidebar row is ~200px wide and
 * CSS-truncates whatever it is given, so the stored length never mattered
 * there — but the same string is the chat column's `<h1>`, which has around a
 * thousand pixels. A new chat therefore opened with its own name visibly giving
 * up mid-word, with most of the band empty beside it, on the one element
 * docs/design/PREMIUM_AUDIT.md §3 rule 15 says a page opens with.
 *
 * The mistake underneath is that the truncation was stored rather than drawn.
 * Where a title has to stop is a fact about the box it is in, and the boxes
 * disagree — so the data keeps a title-sized amount of the prompt and each
 * surface clamps it in CSS at its own width, which all of them already do.
 *
 * 72, not "all of it": this is a TITLE. It rides the document title, share
 * cards and exports, and a whole paragraph in those is a different bug. At the
 * interface face 72 characters is ~560px, inside the 40rem clamp the header
 * already puts on it, so the h1 shows the whole thing and anything longer
 * still ends cleanly.
 */
export const PROMPT_TITLE_MAX = 72;

/**
 * Every length a placeholder has been minted at, newest first.
 *
 * `isPromptPlaceholderTitle` is what lets the auto-titler REPLACE a placeholder
 * — a title it does not recognise is treated as one somebody chose, and is left
 * alone forever. So changing the length without teaching the recogniser the old
 * one would permanently freeze the title of every conversation created before
 * the change, which is a silent, unreportable failure: those chats would simply
 * never get named.
 */
const PLACEHOLDER_LENGTHS = [PROMPT_TITLE_MAX, 48] as const;

/** The placeholder title for a conversation named after its first prompt. */
export function promptPlaceholderTitle(prompt: string, fallback = "New chat"): string {
  return truncate(prompt.trim() ? prompt : fallback, PROMPT_TITLE_MAX);
}

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
  const compactPrompt = compact(firstUserText);
  // Both spellings at every length the product has minted. The ASCII "..." form
  // predates the ellipsis one and is still in the database.
  for (const max of PLACEHOLDER_LENGTHS) {
    if (normalizedTitle === normalize(placeholderFromPrompt(firstUserText, max))) return true;
    const ellipsis =
      compactPrompt.length > max ? compactPrompt.slice(0, max - 1).trimEnd() + "\u2026" : compactPrompt;
    if (normalizedTitle === normalize(ellipsis)) return true;
  }
  return false;
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
