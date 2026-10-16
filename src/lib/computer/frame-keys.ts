/*
 * Where a cloud computer step's frame is stored, and which frames a run's
 * events name — the pure half of src/lib/computer/frames.ts.
 *
 * Kept apart from frames.ts (storage, sharp, server-only) so the paths that
 * only need to find frames in order to delete them — account deletion above
 * all — can do so without loading an image library.
 *
 *   computer-frames/{userId}/{runId}/{ref}.jpg
 */

/** A storage-key and URL segment: letters, digits, `_` and `-`. */
export const FRAME_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

/** A frame reference as events carry it and the route accepts it. */
export function isFrameRef(value: unknown): value is string {
  return typeof value === "string" && FRAME_SEGMENT.test(value);
}

/** The frame reference for a tool call id, as the agent-core tools derive it. */
export function frameRefForCall(callId: string, suffix?: "pre"): string | null {
  const base = callId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 120);
  if (!/[A-Za-z0-9]/.test(base)) return null;
  return suffix ? `${base}-${suffix}` : base;
}

export function frameStorageKey(userId: string, runId: string, ref: string): string {
  if (!FRAME_SEGMENT.test(userId) || !FRAME_SEGMENT.test(runId) || !isFrameRef(ref)) {
    throw new Error("Invalid frame key");
  }
  return `computer-frames/${userId}/${runId}/${ref}.jpg`;
}

/** The facts `deleteRunFrames` needs from the run's events. */
export interface RunFrameEvent {
  kind: string;
  payload: unknown;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Every frame ref a run's events can name: the frame on each `tool_finished`,
 * the pre-action frame on each approval, and — for a frame whose event was
 * never written — the ref every computer call's id derives.
 */
export function frameRefsInEvents(events: readonly RunFrameEvent[]): string[] {
  const refs = new Set<string>();
  for (const event of events) {
    const payload = record(event.payload);
    if (!payload) continue;
    if (event.kind === "tool_finished") {
      const ref = record(payload.frame)?.ref;
      if (isFrameRef(ref)) refs.add(ref);
    }
    if (event.kind === "approval_requested") {
      const ref = record(record(record(payload.request)?.detail)?.frame)?.ref;
      if (isFrameRef(ref)) refs.add(ref);
    }
    if (event.kind === "tool_started" && typeof payload.tool === "string" && payload.tool.startsWith("computer_")) {
      const callId = typeof payload.callId === "string" ? payload.callId : null;
      for (const suffix of [undefined, "pre"] as const) {
        const ref = callId ? frameRefForCall(callId, suffix) : null;
        if (ref) refs.add(ref);
      }
    }
  }
  return [...refs];
}

/** An event and the run it belongs to, for an account-wide sweep. */
export interface AccountFrameEvent extends RunFrameEvent {
  runId: string;
}

/**
 * The events that can name a frame: a computer tool's start and finish, and
 * an approval for one. A Prisma `WorkEvent` filter (the tool name is on the
 * payload), so an account with years of other tool calls does not load them
 * all to find a few screenshots.
 */
export const COMPUTER_FRAME_EVENTS_FILTER = {
  OR: [
    { kind: { in: ["tool_started", "tool_finished"] }, payload: { path: ["tool"], string_starts_with: "computer_" } },
    { kind: "approval_requested", payload: { path: ["request", "tool"], string_starts_with: "computer_" } },
  ],
};

/**
 * Every frame key an account's events name, across all of its runs.
 *
 * Account deletion (src/app/api/account/delete-account.ts) reads these before
 * the user row goes: every WorkRun and WorkEvent cascades with it, after which
 * nothing names the frames, and they are screenshots of whatever was on the
 * agent's screen — a mailbox, a bank page. Erasure has to reach them.
 */
export function accountFrameKeys(userId: string, events: readonly AccountFrameEvent[]): string[] {
  if (!FRAME_SEGMENT.test(userId)) return [];
  const byRun = new Map<string, RunFrameEvent[]>();
  for (const event of events) {
    if (!FRAME_SEGMENT.test(event.runId)) continue;
    const list = byRun.get(event.runId) ?? [];
    list.push(event);
    byRun.set(event.runId, list);
  }
  const keys: string[] = [];
  for (const [runId, runEvents] of byRun) {
    for (const ref of frameRefsInEvents(runEvents)) keys.push(frameStorageKey(userId, runId, ref));
  }
  return keys;
}
