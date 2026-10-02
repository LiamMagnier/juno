/**
 * THE DRAFT AS DATA: plain text plus the context tokens written into it.
 *
 * The composer's field is a contenteditable (context-composer-field.tsx), but
 * every change that does not come from typing (a send clearing it, a slash
 * skill taking its first word, dictation appending to it, a clarification
 * handing it back, a reload restoring it, a paste of tokens copied from
 * another draft) is a change to this pair. Doing those as string-and-range
 * arithmetic here, rather than as DOM surgery at each call site, is what keeps
 * a token attached to its words through all of them, and what lets
 * tests/context-draft.test.ts check every one without a browser.
 *
 * The rule every function keeps: a token survives only where its range still
 * frames exactly its label. A token is never re-attached by searching for its
 * name, because "Mira" typed as a word is not the agent Mira.
 *
 * Pure and client-safe.
 */
import {
  contextTokenSchema,
  MAX_CONTEXT_TOKENS,
  type ContextToken,
} from "@/lib/chat/context-tokens";

export interface ContextDraft {
  text: string;
  tokens: ContextToken[];
}

/** Whether a token's range frames its label in `text`. */
export function tokenFits(text: string, token: Pick<ContextToken, "label" | "range">): boolean {
  const range = token.range;
  return !!range && range.start >= 0 && range.end <= text.length && text.slice(range.start, range.end) === token.label;
}

/**
 * The tokens that still belong to `text`, in order, with no two covering the
 * same words. What an external replacement of the field's value keeps.
 */
export function tokensForText(text: string, tokens: readonly ContextToken[]): ContextToken[] {
  const placed = tokens
    .filter((token) => tokenFits(text, token))
    .sort((a, b) => a.range!.start - b.range!.start);
  const out: ContextToken[] = [];
  let cursor = 0;
  for (const token of placed) {
    if (token.range!.start < cursor) continue;
    out.push(token);
    cursor = token.range!.end;
  }
  return out.slice(0, MAX_CONTEXT_TOKENS);
}

/** Every range moved by `delta` characters; tokens that fall off the front are dropped. */
export function shiftTokens(tokens: readonly ContextToken[], delta: number): ContextToken[] {
  const out: ContextToken[] = [];
  for (const token of tokens) {
    if (!token.range) continue;
    const start = token.range.start + delta;
    const end = token.range.end + delta;
    if (start < 0) continue;
    out.push({ ...token, range: { start, end } });
  }
  return out;
}

/**
 * The tokens of a draft whose head was taken by a typed `/skill`.
 *
 * `readSkillInvocation` sends only what follows the slug ("/brief Compare
 * [Q3 Forecast.xlsx]" becomes "Compare [Q3 Forecast.xlsx]" under the brief
 * skill), so every range has to move back by the length of the head it lost.
 * The remainder is the draft's tail with its surrounding whitespace trimmed,
 * which pins exactly where it starts.
 */
export function tokensForRemainder(draft: string, remainder: string, tokens: readonly ContextToken[]): ContextToken[] {
  if (!remainder) return [];
  const tail = draft.trimEnd();
  if (!tail.endsWith(remainder)) return [];
  const offset = tail.length - remainder.length;
  return tokensForText(remainder, shiftTokens(tokens, -offset));
}

/**
 * Dictation appended to a draft. The existing text keeps its start (only its
 * trailing whitespace goes), so every token in it keeps its range; the
 * transcript follows after one space.
 */
export function appendToDraft(draft: ContextDraft, addition: string): ContextDraft {
  const base = draft.text.trimEnd();
  const extra = addition.trim();
  const text = base && extra ? `${base} ${extra}` : base || extra;
  return { text, tokens: tokensForText(text, draft.tokens) };
}

// ---------------------------------------------------------------------------
// Clipboard: tokens survive copy, cut and paste inside Alevr
// ---------------------------------------------------------------------------

/** The clipboard type a token-carrying selection is written under (INTERACTION_SPEC C9). */
export const CONTEXT_CLIPBOARD_TYPE = "application/x-juno-tokens+json";

/** The selection, as the JSON the clipboard carries. Plain text goes alongside it as text/plain. */
export function serializeClipboardDraft(draft: ContextDraft): string {
  return JSON.stringify({ version: 1, text: draft.text, tokens: tokensForText(draft.text, draft.tokens) });
}

/**
 * A pasted selection, or null when it is not one of ours or does not hold up.
 *
 * Clipboard contents are untrusted: they may come from another site, an older
 * build or a hand-edited string. Each token is re-validated by the request
 * schema and must still frame its words; anything else pastes as the plain
 * text beside it. The server re-reads every token's ownership regardless.
 */
export function parseClipboardDraft(raw: string | null | undefined): ContextDraft | null {
  if (!raw || raw.length > 200_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const { text, tokens } = value as { text?: unknown; tokens?: unknown };
  if (typeof text !== "string" || !Array.isArray(tokens)) return null;
  const valid: ContextToken[] = [];
  for (const candidate of tokens.slice(0, MAX_CONTEXT_TOKENS)) {
    const parsed = contextTokenSchema.safeParse(candidate);
    if (parsed.success && parsed.data.range) valid.push(parsed.data);
  }
  return { text, tokens: tokensForText(text, valid) };
}

/**
 * A draft split into what an editor inserts: runs of text and tokens, in
 * order. Concatenating the runs' text gives back `draft.text`.
 */
export function draftRuns(draft: ContextDraft): Array<{ text: string } | { token: ContextToken }> {
  const out: Array<{ text: string } | { token: ContextToken }> = [];
  let cursor = 0;
  for (const token of tokensForText(draft.text, draft.tokens)) {
    if (token.range!.start > cursor) out.push({ text: draft.text.slice(cursor, token.range!.start) });
    out.push({ token });
    cursor = token.range!.end;
  }
  if (cursor < draft.text.length) out.push({ text: draft.text.slice(cursor) });
  return out;
}

// ---------------------------------------------------------------------------
// Drafts kept across a remount (INTERACTION_SPEC C21)
// ---------------------------------------------------------------------------

/**
 * Where a chat's unsent draft lives while the composer is not mounted.
 *
 * In memory first, so moving between the home and a thread, or a branch of
 * the page remounting the composer, gives the draft back with its tokens; and
 * in this tab's sessionStorage, so a reload does too. Never for incognito: the
 * caller does not pass a key there. Storage can be missing, full or blocked,
 * so every access is guarded and the composer works without it.
 */
const memory = new Map<string, ContextDraft>();
const STORAGE_PREFIX = "juno:composer-draft:";
/** A draft older than this is dropped rather than restored (C21 says 30 days for a durable store; a tab is shorter). */
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readComposerDraft(key: string): ContextDraft | null {
  const held = memory.get(key);
  if (held) return held;
  try {
    const raw = storage()?.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const stored = JSON.parse(raw) as { savedAt?: unknown; draft?: unknown };
    if (typeof stored.savedAt !== "number" || Date.now() - stored.savedAt > DRAFT_TTL_MS) return null;
    const draft = parseClipboardDraft(JSON.stringify(stored.draft));
    return draft && draft.text ? draft : null;
  } catch {
    return null;
  }
}

export function writeComposerDraft(key: string, draft: ContextDraft): void {
  if (!draft.text.trim()) {
    clearComposerDraft(key);
    return;
  }
  const clean = { text: draft.text, tokens: tokensForText(draft.text, draft.tokens) };
  memory.set(key, clean);
  try {
    storage()?.setItem(STORAGE_PREFIX + key, JSON.stringify({ savedAt: Date.now(), draft: clean }));
  } catch {
    /* Full or blocked storage keeps the in-memory copy only. */
  }
}

export function clearComposerDraft(key: string): void {
  memory.delete(key);
  try {
    storage()?.removeItem(STORAGE_PREFIX + key);
  } catch {
    /* Nothing to clear when storage is unavailable. */
  }
}
