import { isWorkStatus, statusNeedsAttention } from "@/lib/work/domain";
import type { AgentAvatar } from "@/lib/agents/avatar";

/*
 * ACTIVITY: ONE LIST OF WHAT IS LIVE, ACROSS EVERY PRODUCT (audit gap G70).
 *
 * Three things in this product run on their own after the reader asks for them:
 * a Work task (started from a chat or from Work), a Code task (on a Mac or a
 * cloud machine) and a Research run. Each already has a status vocabulary and a
 * screen of its own. What none of them answers is the question a person asks
 * when they come back to the app: "what is going on, and what is waiting on
 * me?". This module is that answer's vocabulary, and nothing else.
 *
 * Pure on purpose: no React, no Prisma, no `window`. The route reads rows and
 * hands them here; the web page, the Mac app and the iPhone app all decode the
 * same `ActivityItem`; and the classification (the one piece of this feature
 * that can be wrong in a way nobody notices) is testable without a database.
 *
 * FOUR STATES, ONE ORDER (docs/design/UI_UX_MOTION_SPEC_2026-10.md §3.4, §7.2):
 *
 *   needs_you  stopped until the reader answers: an approval, a question, a
 *              plan to confirm, a Mac to wake.
 *   running    under way, or queued for a machine.
 *   ready      finished cleanly in the last day, with something to read.
 *   blocked    ended on an error in the last day.
 *
 * Needs you comes first because it is the only group that is the reader's to
 * move. Blocked comes last so it never sits next to Needs you: two "red-ish"
 * groups adjacent is the colour-only confusion the spec was written against.
 *
 * Cancelled work is deliberately absent. The reader stopped it; it is settled,
 * and an overview that keeps showing what you put down is one you garden.
 */

export const ACTIVITY_KINDS = ["work", "code", "research"] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export const ACTIVITY_STATES = ["needs_you", "running", "ready", "blocked"] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

/** What a needs-you (or ready) item is waiting for, so a row can say it in one word. */
export const ACTIVITY_NEEDS = ["approval", "question", "plan", "host", "decision", "review"] as const;
export type ActivityNeed = (typeof ACTIVITY_NEEDS)[number];

/** Finished items stay in the overview this long, then leave it (their own screens keep them). */
export const ACTIVITY_SETTLED_WINDOW_MS = 24 * 60 * 60 * 1000;

export const ACTIVITY_PAGE_DEFAULT = 50;
export const ACTIVITY_PAGE_MAX = 100;

/** One live thing, in the shape every client decodes. Timestamps are ISO strings. */
export interface ActivityItem {
  /** `${kind}:${sourceId}`, stable across polls and unique across kinds. */
  id: string;
  kind: ActivityKind;
  /** The row id in its own table: WorkSession, CodeTask or ResearchRun. */
  sourceId: string;
  title: string;
  state: ActivityState;
  need: ActivityNeed | null;
  /** The source's own status word, for a tooltip and for clients that know it. */
  status: string;
  /** The pending approval's own sentence, when a Work task is waiting on one. */
  needSummary: string | null;
  /** When it started, for "running for 4 min". */
  startedAt: string;
  /** When it last changed. The list's sort key. */
  updatedAt: string;
  /** Where to open it, as an in-app path. */
  href: string;
  conversationId: string | null;
  /** The executing Work run, which is what the stop control addresses. */
  runId: string | null;
  /** Whether an existing endpoint can stop it from the list. */
  canStop: boolean;
  /**
   * The crew member running it, when one is (a Work task or research run an
   * agent owns). Rows draw that agent's 2D face in `agentState` rather than a
   * plain status mark. Null for the reader's own runs and for Code tasks.
   */
  agent: ActivityAgent | null;
}

export interface ActivityAgent {
  id: string;
  name: string;
  /** `{shape, tone, eyes, mark}`, normalised (src/lib/agents/avatar.ts). */
  avatar: AgentAvatar;
  /** The face's state for this item (`AGENT_STATES`). */
  state: "working" | "waiting" | "done" | "blocked";
}

/** The agent face's state for an activity state (docs/design/AGENTS.md §4.2). */
export function agentStateFor(state: ActivityState): ActivityAgent["state"] {
  switch (state) {
    case "needs_you":
      return "waiting";
    case "running":
      return "working";
    case "ready":
      return "done";
    case "blocked":
      return "blocked";
  }
}

export interface ActivityCounts {
  needs_you: number;
  running: number;
  ready: number;
  blocked: number;
}

export interface ActivityPage {
  items: ActivityItem[];
  counts: ActivityCounts;
  nextCursor: string | null;
}

export interface Classified {
  state: ActivityState;
  need: ActivityNeed | null;
}

/* ── Classification ──────────────────────────────────────────────────────── */

const WORK_RUNNING = new Set(["queued", "preparing", "running", "paused"]);
const WORK_BLOCKED = new Set(["failed", "interrupted", "budget_exceeded", "timed_out"]);

/**
 * A Work task. `needsAttention` is the session's own denormalised flag and wins,
 * as it does in the sidebar (`workRunNeedsYou`): a task can say it needs a
 * person in a status this build does not list.
 */
export function classifyWork(status: string, needsAttention: boolean): Classified | null {
  if (status === "waiting_approval") return { state: "needs_you", need: "approval" };
  if (status === "waiting_input") return { state: "needs_you", need: "question" };
  if (status === "host_offline") return { state: "needs_you", need: "host" };
  if (needsAttention || statusNeedsAttention(status)) return { state: "needs_you", need: "decision" };
  if (WORK_RUNNING.has(status)) return { state: "running", need: null };
  if (status === "completed") return { state: "ready", need: "review" };
  if (WORK_BLOCKED.has(status)) return { state: "blocked", need: null };
  // draft (never dispatched), cancelled (the reader stopped it), or a status a
  // newer deployment wrote that this build cannot name: left out, never guessed.
  return null;
}

/** A Code task (`CodeTask.status`, the six words in `RUN_STATUSES`). */
export function classifyCode(status: string): Classified | null {
  switch (status) {
    case "awaiting_approval":
      return { state: "needs_you", need: "approval" };
    case "queued":
    case "running":
      return { state: "running", need: null };
    case "done":
      return { state: "ready", need: "review" };
    case "failed":
      return { state: "blocked", need: null };
    default:
      return null;
  }
}

const RESEARCH_RUNNING = new Set([
  "accepted",
  "planning",
  "investigating",
  "reviewing",
  "synthesizing",
  "validating_citations",
  "paused",
]);

/** A Research run (`ResearchRun.state`). */
export function classifyResearch(state: string): Classified | null {
  if (state === "awaiting_plan_confirmation") return { state: "needs_you", need: "plan" };
  if (state === "awaiting_user_input") return { state: "needs_you", need: "question" };
  if (RESEARCH_RUNNING.has(state)) return { state: "running", need: null };
  if (state === "completed" || state === "partially_completed") return { state: "ready", need: "review" };
  if (state === "failed") return { state: "blocked", need: null };
  return null;
}

/* ── The status sets each query asks for ─────────────────────────────────── */

/** Statuses that are in the overview at any age: live, or waiting on a person. */
export const WORK_OPEN_STATUSES = ["queued", "preparing", "running", "paused", "waiting_input", "waiting_approval", "host_offline"] as const;
/** Statuses that are in the overview only inside the settled window. */
export const WORK_SETTLED_STATUSES = ["completed", ...WORK_BLOCKED] as const;
export const CODE_OPEN_STATUSES = ["queued", "running", "awaiting_approval"] as const;
export const CODE_SETTLED_STATUSES = ["done", "failed"] as const;
export const RESEARCH_OPEN_STATUSES = [...RESEARCH_RUNNING, "awaiting_plan_confirmation", "awaiting_user_input"] as const;
export const RESEARCH_SETTLED_STATUSES = ["completed", "partially_completed", "failed"] as const;

/** Whether the stop control may be offered: only for something actually under way. */
export function canStop(kind: ActivityKind, status: string): boolean {
  if (kind === "work") return isWorkStatus(status) && WORK_RUNNING.has(status) && status !== "paused";
  if (kind === "code") return status === "queued" || status === "running" || status === "awaiting_approval";
  return RESEARCH_RUNNING.has(status) || status === "awaiting_plan_confirmation" || status === "awaiting_user_input";
}

/* ── Links ───────────────────────────────────────────────────────────────── */

/**
 * Where a row opens. A Work task opens at `/work/<id>`, which already resolves
 * to the chat it was started from (where its approval card and its question
 * render) or to the task's own thread. A Code task opens its session; one with
 * no session (a native client that never mirrored it) opens Code. A Research
 * run opens its own page, which carries the plan card and the report.
 */
export function activityHref(kind: ActivityKind, sourceId: string, conversationId: string | null): string {
  if (kind === "work") return `/work/${encodeURIComponent(sourceId)}`;
  if (kind === "code") return conversationId ? `/code/${encodeURIComponent(conversationId)}` : "/code";
  return `/research/${encodeURIComponent(sourceId)}`;
}

/* ── Order, cursor and counts ────────────────────────────────────────────── */

const KIND_RANK: Record<ActivityKind, number> = { work: 0, code: 1, research: 2 };
const STATE_RANK: Record<ActivityState, number> = { needs_you: 0, running: 1, ready: 2, blocked: 3 };

export function stateRank(state: ActivityState): number {
  return STATE_RANK[state];
}

/** The page order: newest change first, then kind, then id, so it is total. */
export function compareActivity(a: Pick<ActivityItem, "updatedAt" | "kind" | "sourceId">, b: Pick<ActivityItem, "updatedAt" | "kind" | "sourceId">): number {
  const at = Date.parse(a.updatedAt);
  const bt = Date.parse(b.updatedAt);
  if (at !== bt) return bt - at;
  if (a.kind !== b.kind) return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  return a.sourceId < b.sourceId ? 1 : a.sourceId > b.sourceId ? -1 : 0;
}

export interface ActivityCursor {
  /** The last emitted item's change time, in ms. */
  t: number;
  kind: ActivityKind;
  id: string;
}

/*
 * The cursor is opaque base64url over `[t, kind, id]`. Ids are cuids, so the
 * payload is ASCII and `btoa`/`atob` (present in Node and every browser) are
 * enough; this module stays importable from a client bundle.
 */
export function encodeCursor(item: Pick<ActivityItem, "updatedAt" | "kind" | "sourceId">): string {
  const payload = JSON.stringify([Date.parse(item.updatedAt), item.kind, item.sourceId]);
  return btoa(payload).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Null for anything that is not a cursor this build wrote. */
export function decodeCursor(raw: string | null | undefined): ActivityCursor | null {
  if (!raw || raw.length > 512 || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const parsed: unknown = JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/")));
    if (!Array.isArray(parsed) || parsed.length !== 3) return null;
    const [t, kind, id] = parsed;
    if (typeof t !== "number" || !Number.isFinite(t)) return null;
    if (typeof kind !== "string" || !(ACTIVITY_KINDS as readonly string[]).includes(kind)) return null;
    if (typeof id !== "string" || id.length === 0 || id.length > 128) return null;
    return { t, kind: kind as ActivityKind, id };
  } catch {
    return null;
  }
}

/**
 * The keyset condition for one kind after a cursor, as plain data the store
 * turns into a `where` clause. Kinds ranked before the cursor's were already
 * emitted at the cursor's instant; kinds after it were not.
 */
export function afterCursor(kind: ActivityKind, cursor: ActivityCursor): { before: Date; atOrBefore: boolean; idBelow: string | null } {
  const at = new Date(cursor.t);
  if (KIND_RANK[kind] < KIND_RANK[cursor.kind]) return { before: at, atOrBefore: false, idBelow: null };
  if (kind === cursor.kind) return { before: at, atOrBefore: false, idBelow: cursor.id };
  return { before: at, atOrBefore: true, idBelow: null };
}

export interface ActivityGroup {
  state: ActivityState;
  items: ActivityItem[];
}

/**
 * The page's sections: the four states in reading order, each holding its items
 * in page order, empty groups left out. `only` narrows to one state (a filter).
 */
export function groupActivity(items: readonly ActivityItem[], only: ActivityState | null = null): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  for (const state of ACTIVITY_STATES) {
    if (only && state !== only) continue;
    const inState = items.filter((item) => item.state === state);
    if (inState.length > 0) groups.push({ state, items: inState });
  }
  return groups;
}

export function emptyCounts(): ActivityCounts {
  return { needs_you: 0, running: 0, ready: 0, blocked: 0 };
}

export function parseLimit(raw: string | null): number | null {
  if (raw === null) return ACTIVITY_PAGE_DEFAULT;
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  if (n < 1 || n > ACTIVITY_PAGE_MAX) return null;
  return n;
}

/** A title that always says something, clipped for a row. */
export function activityTitle(raw: string | null | undefined, fallback: string): string {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (text.length === 0) return fallback;
  return text.length > 140 ? `${text.slice(0, 139).trimEnd()}…` : text;
}
