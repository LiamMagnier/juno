/**
 * Composer rules (DESIGN §5.5, §5.6; INTERACTION I-13, I-17; SPEC §3.6):
 * Enter sends (queues while a turn runs), ⌘↵ steers, Shift+Enter is a
 * newline, Send becomes Stop when the draft is empty during a run, Esc Esc
 * within 600 ms stops. Slash and mention triggers. The editable queue.
 *
 * Pure; the component wires keys and timers to these.
 */

export interface ComposerContext {
  /** A turn is running (or waiting on the user). */
  running: boolean;
  /** The draft has text or attachments. */
  hasDraft: boolean;
  /** The instance can inject input into a running turn. */
  canSteer: boolean;
  /** The instance can hold input until the turn ends. */
  canQueue: boolean;
  /** A slash or mention menu is open and owns Enter / arrows. */
  menuOpen?: boolean;
  /** IME composition in progress: Enter confirms the character. */
  composing?: boolean;
}

export interface KeyInput {
  key: string;
  meta?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
}

export type ComposerIntent = "send" | "queue" | "steer" | "newline" | "edit-last-queued" | null;

const mod = (k: KeyInput, mac: boolean) => (mac ? !!k.meta : !!k.ctrl);

/** What a key press in the draft means. Null = let the textarea handle it. */
export function composerKeyIntent(k: KeyInput, ctx: ComposerContext, mac = true): ComposerIntent {
  if (ctx.composing || ctx.menuOpen) return null;
  if (k.key === "Enter") {
    if (k.shift) return "newline";
    if (mod(k, mac)) {
      if (!ctx.hasDraft) return null;
      if (ctx.running && ctx.canSteer) return "steer";
      if (ctx.running) return ctx.canQueue ? "queue" : null;
      return "send";
    }
    if (!ctx.hasDraft) return null;
    if (ctx.running) return ctx.canQueue ? "queue" : ctx.canSteer ? "steer" : null;
    return "send";
  }
  if (k.key === "ArrowUp" && k.alt && !ctx.hasDraft) return "edit-last-queued";
  return null;
}

export type SendButtonMode = "send" | "stop" | "queue" | "disabled";

/** The round button at the end of the footer. */
export function sendButtonMode(ctx: Pick<ComposerContext, "running" | "hasDraft" | "canQueue" | "canSteer">, ready = true): SendButtonMode {
  if (ctx.running && !ctx.hasDraft) return "stop";
  if (!ready) return "disabled";
  if (ctx.running) return ctx.canQueue || ctx.canSteer ? "queue" : "disabled";
  return ctx.hasDraft ? "send" : "disabled";
}

export const ESC_WINDOW_MS = 600;

/**
 * Esc Esc stops a running turn. Returns whether this press stops, and the new
 * armed time (null once used or when not running).
 */
export function escPress(armedAt: number | null, now: number, running: boolean): { stop: boolean; armedAt: number | null } {
  if (!running) return { stop: false, armedAt: null };
  if (armedAt !== null && now - armedAt <= ESC_WINDOW_MS) return { stop: true, armedAt: null };
  return { stop: false, armedAt: now };
}

// ── Slash and mention triggers ─────────────────────────────────────────────

export interface Trigger {
  kind: "slash" | "mention";
  /** Text after the trigger character up to the caret. */
  query: string;
  /** Index of the trigger character. */
  start: number;
}

/**
 * The trigger the caret sits in: `/` at the start of a line, or `@` after
 * whitespace / at the start, with no whitespace between it and the caret.
 */
export function detectTrigger(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const match = /(^|[\s(])([@/])([^\s@/]*)$/.exec(before);
  if (!match) {
    // Paths inside a mention: "@src/cart/" keeps the mention open.
    const path = /(^|\s)@([\w.\-/]*)$/.exec(before);
    if (path) return { kind: "mention", query: path[2], start: before.length - path[2].length - 1 };
    return null;
  }
  const char = match[2];
  const start = before.length - match[3].length - 1;
  if (char === "/") {
    const lineStart = before.lastIndexOf("\n", start - 1) + 1;
    if (before.slice(lineStart, start).trim() !== "") return null;
    return { kind: "slash", query: match[3], start };
  }
  return { kind: "mention", query: match[3], start };
}

/** Replace the trigger text with `insert` and return the new text and caret. */
export function applyTrigger(text: string, caret: number, trigger: Trigger, insert: string): { text: string; caret: number } {
  const next = text.slice(0, trigger.start) + insert + text.slice(caret);
  return { text: next, caret: trigger.start + insert.length };
}

export interface SlashCommand {
  name: string;
  description: string;
  section: "Commands" | "Skills" | "Agents";
  glyph: string;
  /** Inserted as text instead of run (skills and agents become a mention). */
  insert?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "plan", description: "Plan first; nothing changes until you approve the plan.", section: "Commands", glyph: "plan" },
  { name: "compact", description: "Summarise the oldest turns to free context.", section: "Commands", glyph: "fold" },
  { name: "review", description: "Have the reviewer read this thread's changes.", section: "Commands", glyph: "review" },
  { name: "init", description: "Write an AGENTS.md from what Alevr learns of this repo.", section: "Commands", glyph: "document" },
  { name: "test", description: "Run the project's tests and fix what fails.", section: "Commands", glyph: "test" },
  { name: "commit", description: "Commit the changes with a message drawn from the thread.", section: "Commands", glyph: "commit" },
  { name: "pr", description: "Open a pull request for this branch.", section: "Commands", glyph: "pull-request" },
  { name: "model", description: "Choose the model.", section: "Commands", glyph: "layers" },
  { name: "clear", description: "Start a fresh thread in this project.", section: "Commands", glyph: "new-chat" },
  { name: "explorer", description: "Ask the explorer to map something read-only.", section: "Agents", glyph: "agent", insert: "@explorer " },
  { name: "reviewer", description: "Ask the reviewer for a second read.", section: "Agents", glyph: "agent", insert: "@reviewer " },
];

/** Fuzzy-ish filter: prefix matches first, then substring, in list order. */
export function filterByQuery<T>(items: readonly T[], query: string, key: (t: T) => string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const prefix: T[] = [];
  const contains: T[] = [];
  for (const item of items) {
    const k = key(item).toLowerCase();
    if (k.startsWith(q)) prefix.push(item);
    else if (k.includes(q)) contains.push(item);
  }
  return [...prefix, ...contains];
}

/** File mention candidates: basename prefix first, then path substring. */
export function rankFiles(paths: readonly string[], query: string, limit = 8): string[] {
  const q = query.trim().toLowerCase();
  if (!q) return paths.slice(0, limit);
  const scored: { p: string; s: number }[] = [];
  for (const p of paths) {
    const lower = p.toLowerCase();
    const base = lower.slice(lower.lastIndexOf("/") + 1);
    let s = -1;
    if (base.startsWith(q)) s = 0;
    else if (base.includes(q)) s = 1;
    else if (lower.includes(q)) s = 2;
    if (s >= 0) scored.push({ p, s });
  }
  return scored
    .sort((a, b) => a.s - b.s || a.p.length - b.p.length || a.p.localeCompare(b.p))
    .slice(0, limit)
    .map((x) => x.p);
}

// ── Queue ───────────────────────────────────────────────────────────────────

export interface QueueRow {
  id: string;
  text: string;
}

export type QueueAction =
  | { type: "add"; row: QueueRow }
  | { type: "edit"; id: string; text: string }
  | { type: "remove"; id: string }
  | { type: "move"; id: string; to: number }
  | { type: "take"; id: string }
  | { type: "reset"; rows: QueueRow[] };

export function queueReducer(rows: QueueRow[], action: QueueAction): QueueRow[] {
  switch (action.type) {
    case "add":
      return action.row.text.trim() ? [...rows, action.row] : rows;
    case "edit":
      return action.text.trim() ? rows.map((r) => (r.id === action.id ? { ...r, text: action.text } : r)) : rows.filter((r) => r.id !== action.id);
    case "remove":
    case "take":
      return rows.filter((r) => r.id !== action.id);
    case "move": {
      const from = rows.findIndex((r) => r.id === action.id);
      if (from < 0) return rows;
      const to = Math.max(0, Math.min(rows.length - 1, action.to));
      const next = [...rows];
      const [row] = next.splice(from, 1);
      next.splice(to, 0, row);
      return next;
    }
    case "reset":
      return action.rows;
  }
}

/** Rows shown and the "+n more" count (up to 3 rows, DESIGN §5.5). */
export function visibleQueue(rows: readonly QueueRow[], expanded = false): { rows: QueueRow[]; more: number } {
  if (expanded || rows.length <= 3) return { rows: [...rows], more: 0 };
  return { rows: rows.slice(0, 3), more: rows.length - 3 };
}

export function placeholderFor(running: boolean): string {
  return running ? "Queue a follow-up, or ⌘↵ to steer" : "Ask for a change, @ to mention a file, / for commands";
}
