/**
 * Turns and step rows (DESIGN §5.1, §5.4): how a flat list of normalized
 * `TurnItem`s becomes the thread the reader sees.
 *
 * - A turn opens with a sent user message and holds everything until the next
 *   one (steered messages stay inside the turn they steered).
 * - A settled turn folds to "Worked for 4m 12s"; the final answer and the
 *   changed-files receipt stay visible below the fold (never hide the answer).
 * - A turn with an error or an unresolved request cannot fold.
 * - Four work-log detail levels decide how much of a settled turn shows.
 *
 * Pure: no React, no clock (pass `now`).
 */
import type {
  AssistantMessageItem,
  CheckpointItem,
  FileChangeEntry,
  SessionState,
  TurnItem,
  UserMessageItem,
} from "@/lib/code-v2/contracts";

/** How much of a settled turn's work log shows (the "Work log" setting, ⌘⇧L cycles). */
export const DETAIL_LEVELS = ["quiet", "summary", "steps", "full"] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

export const DETAIL_LEVEL_LABELS: Record<DetailLevel, { label: string; description: string }> = {
  quiet: { label: "Answers only", description: "Only what you asked and what came back." },
  summary: { label: "Folded", description: "Each turn folds to how long it worked." },
  steps: { label: "Steps", description: "Every read, edit and command, one line each." },
  full: { label: "Everything", description: "Steps with thinking and command output." },
};

export function nextDetailLevel(level: DetailLevel): DetailLevel {
  return DETAIL_LEVELS[(DETAIL_LEVELS.indexOf(level) + 1) % DETAIL_LEVELS.length];
}

export type TurnStatus = "running" | "waiting" | "done" | "error" | "interrupted" | "limited";

export interface Turn {
  id: string;
  ordinal: number;
  user?: UserMessageItem;
  /** Everything after the opening message, in order (steers included). */
  items: TurnItem[];
  /** The closing assistant message (orchestrator's, not a subagent's), once settled or last. */
  answer?: AssistantMessageItem;
  status: TurnStatus;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** Files this turn changed, newest entry per path, counts summed across edits. */
  changes: FileChangeEntry[];
  checkpoint?: CheckpointItem;
  /** Settled, no error, nothing pending: may fold. */
  canFold: boolean;
}

function isRequestPending(item: TurnItem): boolean {
  return (
    (item.kind === "approval_request" && item.status === "pending") ||
    (item.kind === "user_input_request" && item.status === "pending") ||
    (item.kind === "plan" && item.awaitingApproval === true)
  );
}

function isLive(item: TurnItem): boolean {
  switch (item.kind) {
    case "assistant_message":
    case "reasoning":
      return item.streaming;
    case "command_execution":
    case "file_change":
    case "search":
    case "web_search":
    case "computer_action":
      return item.status === "running" || item.status === "pending";
    case "subagent":
      return item.status === "running" || item.status === "waiting";
    default:
      return false;
  }
}

function startsTurn(item: TurnItem): item is UserMessageItem {
  return item.kind === "user_message" && item.delivery !== "steer";
}

/** Aggregate file changes: one entry per path, counts summed. */
export function aggregateChanges(items: readonly TurnItem[]): FileChangeEntry[] {
  const byPath = new Map<string, FileChangeEntry>();
  for (const item of items) {
    if (item.kind !== "file_change" || item.status === "declined" || item.status === "failed") continue;
    for (const c of item.changes) {
      const prev = byPath.get(c.path);
      if (!prev) {
        byPath.set(c.path, { ...c });
      } else {
        byPath.set(c.path, {
          ...prev,
          change: prev.change === "add" ? "add" : c.change,
          diff: [prev.diff, c.diff].filter(Boolean).join("\n") || undefined,
          additions: (prev.additions ?? 0) + (c.additions ?? 0),
          deletions: (prev.deletions ?? 0) + (c.deletions ?? 0),
        });
      }
    }
  }
  return [...byPath.values()];
}

export interface GroupTurnsOptions {
  /** Session state: the last turn is running/waiting/limited while it says so. */
  state?: SessionState;
  activeTurnId?: string;
}

/** Group items into turns. Items before the first user message form turn 0 (system notices, resumes). */
export function groupTurns(items: readonly TurnItem[], options: GroupTurnsOptions = {}): Turn[] {
  const groups: { user?: UserMessageItem; items: TurnItem[] }[] = [];
  for (const item of items) {
    if (startsTurn(item) || groups.length === 0) {
      groups.push(startsTurn(item) ? { user: item, items: [] } : { items: [item] });
      continue;
    }
    // A message from another conversation that started its own turn opens a
    // new group, with no user message: it is not the person speaking.
    if (item.kind === "conversation_message" && item.direction !== "sent" && item.turnId) {
      const current = groups[groups.length - 1];
      const currentTurn = current.user?.turnId ?? current.items.find((i) => i.turnId)?.turnId;
      if (currentTurn !== item.turnId) {
        groups.push({ items: [item] });
        continue;
      }
    }
    groups[groups.length - 1].items.push(item);
  }

  return groups.map((g, index) => {
    const last = index === groups.length - 1;
    const all = g.user ? [g.user, ...g.items] : g.items;
    const id = g.user?.turnId ?? g.user?.id ?? g.items[0]?.turnId ?? g.items[0]?.id ?? `turn-${index}`;
    const pending = g.items.some(isRequestPending);
    const live = g.items.some(isLive);
    const hasError = g.items.some((i) => i.kind === "error");
    const interrupt = [...g.items].reverse().find((i) => i.kind === "interrupt");
    let status: TurnStatus = "done";
    if (last && options.state === "limited") status = "limited";
    else if (pending) status = "waiting";
    else if (last && (options.state === "running" || options.state === "waiting" || live)) status = "running";
    else if (interrupt && interrupt.kind === "interrupt" && interrupt.reason === "limit") status = "limited";
    else if (hasError) status = "error";
    else if (interrupt) status = "interrupted";

    const orchestratorMessages = g.items.filter(
      (i): i is AssistantMessageItem => i.kind === "assistant_message" && !i.agentId,
    );
    const lastAnswer = orchestratorMessages[orchestratorMessages.length - 1];
    // The answer is the last orchestrator message when nothing but receipts follow it.
    const afterAnswer = lastAnswer ? g.items.slice(g.items.indexOf(lastAnswer) + 1) : [];
    const closing = lastAnswer && afterAnswer.every((i) => i.kind === "checkpoint" || i.kind === "system_notice") ? lastAnswer : undefined;

    const startedAt = all[0]?.createdAt ?? new Date(0).toISOString();
    const settled = status !== "running" && status !== "waiting";
    const endedAt = settled ? all[all.length - 1]?.createdAt : undefined;
    const durationMs = endedAt ? Math.max(0, Date.parse(endedAt) - Date.parse(startedAt)) : undefined;
    const checkpoint = [...g.items].reverse().find((i): i is CheckpointItem => i.kind === "checkpoint");

    return {
      id,
      ordinal: index,
      user: g.user,
      items: g.items,
      answer: closing,
      status,
      startedAt,
      endedAt,
      durationMs,
      changes: aggregateChanges(g.items),
      checkpoint,
      canFold: settled && status !== "error" && !pending && g.items.length > (closing ? 1 : 0),
    };
  });
}

/** What of a turn's body shows at a detail level, given whether the reader unfolded it. */
export interface TurnVisibility {
  /** The "Worked for …" header line. */
  header: boolean;
  steps: boolean;
  /** Reasoning summaries and command output tails. */
  detail: boolean;
}

export function turnVisibility(turn: Turn, level: DetailLevel, unfolded: boolean | undefined): TurnVisibility {
  const live = !turn.canFold;
  if (live) return { header: false, steps: true, detail: level === "full" };
  if (unfolded === true) return { header: true, steps: true, detail: level === "full" || level === "steps" };
  if (unfolded === false) return { header: true, steps: false, detail: false };
  switch (level) {
    case "quiet":
      return { header: false, steps: false, detail: false };
    case "summary":
      return { header: true, steps: false, detail: false };
    case "steps":
      return { header: true, steps: true, detail: false };
    case "full":
      return { header: true, steps: true, detail: true };
  }
}

/** Items shown as step rows (the answer, the opening message and receipts render on their own). */
export function stepItems(turn: Turn): TurnItem[] {
  return turn.items.filter((i) => i !== turn.answer && i.kind !== "checkpoint");
}

/** "4m 12s", "18s", "0:41" for a running clock (`clock` true), "1h 3m". */
export function formatDuration(ms: number, clock = false): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (clock) {
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, "0")}`;
  }
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** The turn header sentence. */
export function turnHeader(turn: Turn, now = Date.now()): string {
  if (turn.status === "running") return `Working for ${formatDuration(now - Date.parse(turn.startedAt))}`;
  if (turn.status === "waiting") return "Waiting for you";
  if (turn.status === "limited") return "Paused: plan limit";
  if (turn.status === "interrupted") return `Stopped after ${formatDuration(turn.durationMs ?? 0)}`;
  return `Worked for ${formatDuration(turn.durationMs ?? 0)}`;
}

// ── Step rows ───────────────────────────────────────────────────────────────

export type StepTone = "quiet" | "running" | "error" | "needs";

export interface StepRow {
  id: string;
  /** A name from the web icon set (src/components/ui/juno-icons). */
  glyph: string;
  verb: string;
  object?: string;
  /** Render `object` in mono (paths, commands, queries). */
  mono: boolean;
  /** Muted trailing text ("11 results", "18s"). */
  meta?: string;
  additions?: number;
  deletions?: number;
  tone: StepTone;
  /** Up to three trailing output lines (command rows). */
  tail?: string[];
  /** Longer text revealed at the "full" detail level (reasoning). */
  detail?: string;
}

function lastLines(text: string | undefined, n: number): string[] | undefined {
  if (!text) return undefined;
  const lines = text.replace(/\r/g, "").split("\n").filter((l) => l.trim().length > 0);
  return lines.length ? lines.slice(-n) : undefined;
}

function changeVerb(c: FileChangeEntry, running: boolean): string {
  if (running) return "Editing";
  switch (c.change) {
    case "add":
      return "Created";
    case "delete":
      return "Deleted";
    case "rename":
      return "Renamed";
    default:
      return "Edited";
  }
}

/** The one-line view of an item, or null for kinds that render as their own block. */
export function describeItem(item: TurnItem, now = Date.now()): StepRow | null {
  const running = isLive(item);
  const elapsed = (ms?: number) => (ms !== undefined ? formatDuration(ms) : undefined);
  switch (item.kind) {
    case "reasoning": {
      return {
        id: item.id,
        glyph: "thought",
        verb: item.streaming ? "Thinking" : "Thought",
        mono: false,
        tone: item.streaming ? "running" : "quiet",
        detail: item.text,
      };
    }
    case "plan": {
      const n = item.steps?.length ?? 0;
      return {
        id: item.id,
        glyph: "plan",
        verb: "Planned",
        object: n ? `${n} ${n === 1 ? "task" : "tasks"}` : undefined,
        mono: false,
        tone: item.awaitingApproval ? "needs" : "quiet",
        detail: item.text,
      };
    }
    case "todo_list": {
      const done = item.todos.filter((t) => t.status === "completed").length;
      return { id: item.id, glyph: "list", verb: "Tasks", object: `${done} of ${item.todos.length} done`, mono: false, tone: "quiet" };
    }
    case "file_change": {
      const first = item.changes[0];
      const adds = item.changes.reduce((s, c) => s + (c.additions ?? 0), 0);
      const dels = item.changes.reduce((s, c) => s + (c.deletions ?? 0), 0);
      const more = item.changes.length > 1 ? ` and ${item.changes.length - 1} more` : "";
      return {
        id: item.id,
        glyph: "edit",
        verb: item.status === "declined" ? "Declined edit" : item.status === "failed" ? "Edit failed" : first ? changeVerb(first, running) : "Edited",
        object: first ? `${first.path}${more}` : undefined,
        mono: true,
        additions: adds,
        deletions: dels,
        tone: running ? "running" : item.status === "failed" ? "error" : "quiet",
      };
    }
    case "command_execution": {
      const failed = item.status === "failed" || (item.exitCode !== undefined && item.exitCode !== 0);
      const at = Date.parse(item.createdAt);
      return {
        id: item.id,
        glyph: "terminal",
        verb: running ? "Running" : failed ? `Failed (exit ${item.exitCode ?? 1})` : item.background ? "Started" : "Ran",
        object: item.command,
        mono: true,
        meta: running ? formatDuration(now - at, true) : elapsed(item.durationMs),
        tone: running ? "running" : failed ? "error" : "quiet",
        tail: lastLines(item.output, 3),
      };
    }
    case "search":
      if (item.scope === "files" && item.matches === undefined) {
        return { id: item.id, glyph: "document", verb: running ? "Reading" : "Read", object: item.query, mono: true, tone: running ? "running" : "quiet" };
      }
      return {
        id: item.id,
        glyph: "text-search",
        verb: running ? "Searching" : "Searched",
        object: item.query,
        mono: true,
        meta: item.matches !== undefined ? `${item.matches} ${item.matches === 1 ? "result" : "results"}` : undefined,
        tone: running ? "running" : "quiet",
      };
    case "web_search":
      return {
        id: item.id,
        glyph: "globe",
        verb: running ? "Searching the web" : "Searched the web",
        object: item.query,
        mono: false,
        meta: item.results ? `${item.results.length} results` : undefined,
        tone: running ? "running" : "quiet",
      };
    case "approval_request": {
      if (item.status === "pending") return null; // the composer takeover shows it
      const verb =
        item.decision === "accept" ? "Allowed" : item.decision === "acceptForSession" ? "Allowed for this session" : item.decision === "cancel" ? "Denied and stopped" : item.status === "expired" ? "Expired" : "Denied";
      return { id: item.id, glyph: item.decision?.startsWith("accept") ? "check" : "ban", verb, object: item.summary, mono: false, tone: "quiet" };
    }
    case "user_input_request":
      if (item.status === "pending") return null;
      return { id: item.id, glyph: "chat-question", verb: item.status === "answered" ? "Answered" : "Skipped", object: item.questions[0]?.prompt, mono: false, tone: "quiet" };
    case "interrupt":
      return {
        id: item.id,
        glyph: item.reason === "limit" ? "pause-circle" : "stop-circle",
        verb: item.reason === "user" ? "Stopped by you" : item.reason === "limit" ? "Paused: plan limit" : item.reason === "budget" ? "Stopped at the budget" : "Stopped",
        object: item.message,
        mono: false,
        tone: "quiet",
      };
    case "handoff":
      return { id: item.id, glyph: "arrow-right", verb: "Handed off to", object: item.to.model, mono: false, tone: "quiet" };
    case "error":
      return { id: item.id, glyph: "error-circle", verb: item.message, mono: false, tone: "error" };
    case "computer_action":
      return {
        id: item.id,
        glyph: "computer",
        verb: running ? "Using the computer" : "Used the computer",
        object: item.summary ?? item.target,
        mono: false,
        tone: running ? "running" : item.status === "failed" ? "error" : "quiet",
      };
    case "user_message":
    case "assistant_message":
    case "checkpoint":
    case "compaction":
    case "system_notice":
    case "subagent":
    case "conversation_message":
      return null;
  }
}

/** Turn navigator rail marks: one per turn with a user message. */
export interface TurnMark {
  id: string;
  ordinal: number;
  label: string;
  status: TurnStatus;
  changed: number;
}

export function turnMarks(turns: readonly Turn[]): TurnMark[] {
  return turns
    .filter((t) => t.user)
    .map((t) => ({
      id: t.id,
      ordinal: t.ordinal,
      label: (t.user?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 80) || "Attachment",
      status: t.status,
      changed: t.changes.length,
    }));
}

/** Group consecutive subagent items of a turn (one fan-out = one tree). */
export function subagentGroups(items: readonly TurnItem[]): TurnItem[][] {
  const groups: TurnItem[][] = [];
  let current: TurnItem[] | null = null;
  for (const item of items) {
    if (item.kind === "subagent") {
      if (!current) {
        current = [];
        groups.push(current);
      }
      current.push(item);
    } else {
      current = null;
    }
  }
  return groups;
}
