/**
 * Composer rules (DESIGN §5.5, §5.6; INTERACTION I-13, I-17; SPEC §3.6):
 * Enter sends (queues while a turn runs), ⌘↵ steers, Shift+Enter and
 * Option+Enter are a newline, Send becomes Stop when the draft is empty during a run, Esc Esc
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
    // Shift+Enter and Option/Alt+Enter break the line (src/lib/composer-keys.ts).
    if (k.shift || k.alt) return "newline";
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

/**
 * Who answers a command: `app` ones run here and never spend a turn (Codex,
 * Claude Code and T3 Code all treat /model, /clear and /plan this way);
 * `agent` ones are sent to the agent as the message. The menu groups them
 * under different headings so the difference is visible before Enter.
 */
export type SlashRunner = "app" | "agent";

/*
 * The menu's headings, named so the i18n extractor catalogues them (a
 * `section` property is not one it reads, and the DOM translator only
 * translates catalogued text).
 */
export const SLASH_ACTIONS_LABEL = "Actions";
export const SLASH_AGENT_LABEL = "Sent to the agent";
export const SLASH_SKILLS_LABEL = "Skills";
export const SLASH_AGENTS_LABEL = "Agents";

export interface SlashCommand {
  name: string;
  description: string;
  section: typeof SLASH_ACTIONS_LABEL | typeof SLASH_AGENT_LABEL | typeof SLASH_SKILLS_LABEL | typeof SLASH_AGENTS_LABEL;
  runs: SlashRunner;
  glyph: string;
  /** Inserted as text instead of run (skills and agents become a mention). */
  insert?: string;
  /** Offered on the /code landing, before a session exists. */
  landing?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "model", description: "Choose the model.", section: SLASH_ACTIONS_LABEL, runs: "app", glyph: "layers", landing: true },
  { name: "plan", description: "Switch to Plan. Anything after it is sent as the task.", section: SLASH_ACTIONS_LABEL, runs: "app", glyph: "plan", landing: true },
  { name: "clear", description: "Start a fresh session in this project.", section: SLASH_ACTIONS_LABEL, runs: "app", glyph: "new-chat" },
  { name: "compact", description: "Summarise the oldest turns to free context.", section: SLASH_AGENT_LABEL, runs: "agent", glyph: "fold" },
  { name: "review", description: "Have the reviewer read this thread's changes.", section: SLASH_AGENT_LABEL, runs: "agent", glyph: "review" },
  { name: "init", description: "Write an AGENTS.md from what Alevr learns of this repo.", section: SLASH_AGENT_LABEL, runs: "agent", glyph: "document" },
  { name: "test", description: "Run the project's tests and fix what fails.", section: SLASH_AGENT_LABEL, runs: "agent", glyph: "test" },
  { name: "commit", description: "Commit the changes with a message drawn from the thread.", section: SLASH_AGENT_LABEL, runs: "agent", glyph: "commit" },
  { name: "pr", description: "Open a pull request for this branch.", section: SLASH_AGENT_LABEL, runs: "agent", glyph: "pull-request" },
  { name: "explorer", description: "Ask the explorer to map something read-only.", section: SLASH_AGENTS_LABEL, runs: "agent", glyph: "agent", insert: "@explorer " },
  { name: "reviewer", description: "Ask the reviewer for a second read.", section: SLASH_AGENTS_LABEL, runs: "agent", glyph: "agent", insert: "@reviewer " },
];

/** The commands a composer offers: all of them in a session, the landing's few before one exists. */
export function slashCommandsFor(variant: "session" | "landing"): SlashCommand[] {
  return variant === "landing" ? SLASH_COMMANDS.filter((c) => c.landing) : SLASH_COMMANDS;
}

/** What an app command does when sent. */
export type ClientCommand =
  | { kind: "model" }
  | { kind: "clear"; rest: string }
  | { kind: "plan"; rest: string }
  | { kind: "compact"; rest: string };

const CLIENT_COMMAND = /^\s*\/(model|clear|plan|compact)(?=\s|$)([\s\S]*)$/i;

/**
 * The app command a draft is, or null when it is a message. Only a draft that
 * opens with the command counts: "/plan" inside a sentence, or "/planner", is
 * text. `/compact` is listed because the composer routes it through the
 * thread's compact action (which the "Compact and switch" picker row uses
 * too), even though the engine is what does the summarising.
 */
export function parseClientCommand(text: string): ClientCommand | null {
  const match = CLIENT_COMMAND.exec(text);
  if (!match) return null;
  const rest = match[2].trim();
  switch (match[1].toLowerCase()) {
    case "model":
      return { kind: "model" };
    case "clear":
      return { kind: "clear", rest };
    case "plan":
      return { kind: "plan", rest };
    default:
      return { kind: "compact", rest };
  }
}

/**
 * The message `/compact` sends: the engines read the command themselves.
 * Claude Code takes focus instructions after it (`/compact keep the API
 * notes`); Alevr's engine (agent-core, on a Mac and in the cloud runner) reads
 * only the bare command and would take anything longer as a prompt, so the
 * instructions are dropped for it rather than spending a turn on them.
 */
export function compactMessage(rest: string, takesInstructions = true): string {
  return rest && takesInstructions ? `/compact ${rest}` : "/compact";
}

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
