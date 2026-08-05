"use client";

import type {
  ClientWorkHost,
  ClientWorkRun,
  ClientWorkSession,
  ClientWorkEvent,
} from "@/lib/work/serializers";
import {
  WORK_CAPABILITIES,
  type WorkCapability,
  type WorkDegradation,
  type WorkHostState,
} from "@/lib/work/domain";

/*
 * Everything the Work surfaces ask the server for, in one place.
 *
 * Written the way `use-code-session.ts` documents the /api/code/tasks contract:
 * the transport is stated once, at the top, so a route handler and the UI that
 * reads it can be diffed against the same paragraph instead of against each
 * other. The endpoints, exactly as they exist under src/app/api/work:
 *
 *   GET  /api/work/sessions?limit=N        → { sessions: ClientWorkSession[] }
 *   POST /api/work/sessions                { goal, requestedTarget, preferredHostId?,
 *                                            model?, idempotencyKey? }
 *          201 → { session }               ← a DRAFT. Nothing is dispatched.
 *   GET  /api/work/sessions/[id]           → { session, run }   (run = newest attempt)
 *   POST /api/work/sessions/[id]/runs      { origin?, requiredCapabilities?,
 *                                            requestedTarget?, model?, idempotencyKey? }
 *          201 → { run, selection }
 *          409 → { error: "no_executor_available" | "session_already_running",
 *                  message, missing?, degradation? }
 *          429 → { error: "run_cap_exceeded" | "dispatch_in_flight", message }
 *   GET  /api/work/sessions/[id]/events?runId=<id>&after=<seq>   (SSE)
 *          data: { type: "snapshot" | "events" | "done", session, run, events }
 *   POST /api/work/sessions/[id]/answer    { questionId, text, idempotencyKey? }
 *          409 → { error: "run_not_waiting_input", message, status }
 *   POST /api/work/runs/[runId]/control    { action: "pause" | "resume" | "cancel" }
 *          409 → { error, message, status }
 *   POST /api/work/approvals/[id]/decision { decision, actionDigest, reason? }
 *          409 → { error, message }
 *   GET  /api/work/hosts                   → { hosts: ClientWorkHost[] }
 *
 * Three rules the whole file is built around.
 *
 * First, creating a task and running it are two requests, and the split is the
 * server's, not a convenience here. `POST /sessions` writes a draft precisely so
 * that composing costs nothing and holds no executor; `POST /sessions/[id]/runs`
 * is the only thing that dispatches, and it is the only thing that can refuse.
 * A UI that treats "start" as one call has nowhere to put that refusal.
 *
 * Second, a 409 or a 429 is not an error to be swallowed. It is the answer to
 * "can anything actually run this", and it carries the sentence that answers it.
 * `WorkBlocked` is that answer given a type, and every caller that can receive
 * one is required by the return type to handle it — which is what stops a queued
 * task with no executor rendering as a spinner nobody ever resolves.
 *
 * Third, every reader here is tolerant. Event payloads are JSON written by an
 * executor that may be a deployment ahead of this bundle, so a field that is
 * missing or the wrong type yields null rather than throwing — one unreadable
 * event must not take the whole timeline down with it.
 */

/**
 * Cross-surface refresh, the same way Code does it with `CODE_SYNC_EVENT`.
 *
 * The sidebar mounts once in the persistent shell, so it cannot learn that a
 * task was just started, answered or stopped from its own poll interval alone —
 * that is up to thirty seconds of a status dot saying the wrong thing right
 * after the user acted. Anything that changes a session dispatches this.
 */
export const WORK_SYNC_EVENT = "juno:work-sync";

/** How often a mounted Work surface re-reads sessions and hosts while visible. */
export const WORK_POLL_MS = 30_000;

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

/**
 * The server's refusal to start or continue work, with the reason attached.
 *
 * `explanation` is never optional. A refusal a surface cannot explain renders
 * as a disabled button with nothing beside it, which tells the user that
 * something is wrong and nothing about what — the one outcome worse than the
 * refusal itself.
 */
export interface WorkBlocked {
  kind: "blocked";
  /** Machine-readable cause, e.g. `no_executor_available`, `run_cap_exceeded`. */
  reason: string;
  explanation: string;
  /** Required capabilities the refusal says nothing can serve. */
  missing: WorkCapability[];
  degradation: WorkDegradation[];
}

/** A request that failed for a reason the user can only respond to by retrying. */
export interface WorkTransportFailure {
  kind: "failed";
  /** `offline` when the fetch itself never completed, `server` otherwise. */
  cause: "offline" | "server" | "not_found" | "unauthorized" | "rejected";
}

export type WorkResult<T> = { kind: "ok"; value: T } | WorkBlocked | WorkTransportFailure;

// ---------------------------------------------------------------------------
// Reading untyped bodies
// ---------------------------------------------------------------------------

/** Reads a JSON body without letting a non-JSON error page reach the caller. */
async function body(res: Response): Promise<Record<string, unknown>> {
  try {
    const parsed: unknown = await res.json();
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function text(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function list<T>(raw: unknown): T[] {
  return Array.isArray(raw) ? (raw as T[]) : [];
}

/** Degradations from an untyped field, dropping any entry with no sentence. */
export function degradationsFrom(raw: unknown): WorkDegradation[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const explanation = text(record, "explanation");
    const kind = text(record, "kind");
    if (!explanation || !kind) return [];
    const subject = text(record, "subject");
    return [
      {
        kind: kind as WorkDegradation["kind"],
        explanation,
        ...(subject === null ? {} : { subject }),
      },
    ];
  });
}

const CAPABILITY_NAMES = new Set<string>(WORK_CAPABILITIES);

function capabilitiesFrom(raw: unknown): WorkCapability[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is WorkCapability => typeof entry === "string" && CAPABILITY_NAMES.has(entry)
  );
}

/**
 * Turns a non-OK response into the typed refusal or failure behind it.
 *
 * 409 and 429 are singled out because they are the only statuses that carry a
 * decision the user can act on, and every route in this surface writes a
 * `message` on them addressed to the user. Everything else is a retry, a
 * sign-in or a dead link, and conflating them costs the user a "try again"
 * button on a page that will never succeed.
 *
 * The sentence is read from `message` rather than invented here. The dispatch
 * route passes `TargetSelection.explanation` through untouched precisely so that
 * the words naming the user's own Mac and its state reach them unaltered.
 */
async function refusal(res: Response): Promise<WorkBlocked | WorkTransportFailure> {
  if (res.status === 401 || res.status === 403) return { kind: "failed", cause: "unauthorized" };
  if (res.status === 404) return { kind: "failed", cause: "not_found" };
  if (res.status !== 409 && res.status !== 429) {
    // A 400 means this client sent something the route would not accept, which
    // no amount of retrying fixes. It is kept distinct from a 5xx so the UI can
    // stop offering a button that cannot work.
    return { kind: "failed", cause: res.status === 400 ? "rejected" : "server" };
  }
  const data = await body(res);
  return {
    kind: "blocked",
    reason: text(data, "error") ?? "unavailable",
    explanation:
      text(data, "message") ??
      "Juno cannot run this right now and did not say why. Try again in a moment.",
    missing: capabilitiesFrom(data.missing),
    degradation: degradationsFrom(data.degradation),
  };
}

async function get<T>(url: string, pick: (data: Record<string, unknown>) => T): Promise<WorkResult<T>> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    return { kind: "failed", cause: "offline" };
  }
  if (!res.ok) return refusal(res);
  return { kind: "ok", value: pick(await body(res)) };
}

async function post<T>(
  url: string,
  payload: unknown,
  pick: (data: Record<string, unknown>) => T
): Promise<WorkResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    return { kind: "failed", cause: "offline" };
  }
  if (!res.ok) return refusal(res);
  return { kind: "ok", value: pick(await body(res)) };
}

/**
 * An idempotency key for a dispatch the user may well repeat.
 *
 * Both `POST /sessions` and `POST /sessions/[id]/runs` treat a repeated key as a
 * replay rather than a second row, and the case they exist for is the ordinary
 * one: a tap on a flaky connection whose response never arrived. Minting the key
 * per attempt — not per keystroke — is what makes "press it again" safe.
 */
export function workIdempotencyKey(): string {
  return `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ---------------------------------------------------------------------------
// Sessions, runs and hosts
// ---------------------------------------------------------------------------

export function fetchWorkSessions(limit = 40): Promise<WorkResult<ClientWorkSession[]>> {
  return get(`/api/work/sessions?limit=${limit}`, (data) => list<ClientWorkSession>(data.sessions));
}

export function fetchWorkHosts(): Promise<WorkResult<ClientWorkHost[]>> {
  return get("/api/work/hosts", (data) => list<ClientWorkHost>(data.hosts));
}

export interface CreateWorkSessionInput {
  goal: string;
  requestedTarget: "automatic" | "cloud" | "local";
  preferredHostId: string | null;
  idempotencyKey: string;
}

/** Writes the draft. Nothing runs until `startWorkRun` is called against it. */
export function createWorkSession(
  input: CreateWorkSessionInput
): Promise<WorkResult<ClientWorkSession>> {
  return post(
    "/api/work/sessions",
    {
      goal: input.goal,
      requestedTarget: input.requestedTarget,
      ...(input.preferredHostId === null ? {} : { preferredHostId: input.preferredHostId }),
      idempotencyKey: input.idempotencyKey,
    },
    (data) => data.session as ClientWorkSession
  );
}

/** What the server decided about where this attempt will run, and what it costs. */
export interface WorkRunSelection {
  target: "cloud" | "local" | null;
  hostId: string | null;
  explanation: string;
  missing: WorkCapability[];
  degradation: WorkDegradation[];
}

export interface StartWorkRunInput {
  /** `manual` for a first dispatch, `retry` for another attempt at the same goal. */
  origin: "manual" | "retry" | "resume" | "fork";
  requiredCapabilities: readonly WorkCapability[];
  /** Overrides the session's own target for this attempt only. */
  requestedTarget?: "automatic" | "cloud" | "local";
  idempotencyKey: string;
}

export interface StartedWorkRun {
  run: ClientWorkRun;
  /** Absent when this build cannot read the server's selection block. */
  selection: WorkRunSelection | null;
}

/**
 * Dispatches an attempt.
 *
 * This is the call that can come back `blocked`, and the reason the whole
 * `WorkResult` type exists. `no_executor_available` means `selectTarget` found
 * nothing that can serve the task and the server refused rather than queueing
 * it — which is the only moment anything in the system is in a position to tell
 * the user that nothing is going to happen.
 */
export function startWorkRun(
  sessionId: string,
  input: StartWorkRunInput
): Promise<WorkResult<StartedWorkRun>> {
  return post(
    `/api/work/sessions/${sessionId}/runs`,
    {
      origin: input.origin,
      requiredCapabilities: [...input.requiredCapabilities],
      ...(input.requestedTarget === undefined ? {} : { requestedTarget: input.requestedTarget }),
      idempotencyKey: input.idempotencyKey,
    },
    (data) => {
      const raw =
        data.selection !== null && typeof data.selection === "object" && !Array.isArray(data.selection)
          ? (data.selection as Record<string, unknown>)
          : null;
      return {
        run: data.run as ClientWorkRun,
        selection:
          raw === null
            ? null
            : {
                target:
                  raw.target === "cloud" || raw.target === "local"
                    ? raw.target
                    : null,
                hostId: text(raw, "hostId"),
                explanation: text(raw, "explanation") ?? "",
                missing: capabilitiesFrom(raw.missing),
                degradation: degradationsFrom(raw.degradation),
              },
      };
    }
  );
}

/** Everything the thread view needs on first paint, before the stream opens. */
export interface WorkThreadSnapshot {
  session: ClientWorkSession;
  /** The newest attempt, or null for a session still in `draft`. */
  run: ClientWorkRun | null;
}

export function fetchWorkThread(sessionId: string): Promise<WorkResult<WorkThreadSnapshot>> {
  return get(`/api/work/sessions/${sessionId}`, (data) => ({
    session: data.session as ClientWorkSession,
    run: (data.run as ClientWorkRun | null) ?? null,
  }));
}

/**
 * Answers a question the run asked.
 *
 * `questionId` is required by the route and is not optional here either. Without
 * it a late answer — typed before the run moved on — is applied to whatever the
 * run is asking now. There is deliberately no general "send a message" call:
 * the Work event vocabulary has no user-message kind, and inventing one on the
 * client would put words into a transcript that the executor never receives.
 */
export function answerWorkQuestion(
  sessionId: string,
  questionId: string,
  answer: string
): Promise<WorkResult<null>> {
  return post(`/api/work/sessions/${sessionId}/answer`, { questionId, text: answer }, () => null);
}

export type WorkControlAction = "pause" | "resume" | "cancel";

/**
 * Pauses, resumes or cancels one attempt.
 *
 * Keyed on the RUN, not the session, because that is what the route takes and
 * what the guarantee is about: the conditional update it performs is evaluated
 * against one run's committed row, so a cancel racing the run's own failure
 * cannot rewrite why the run ended.
 */
export function controlWorkRun(
  runId: string,
  action: WorkControlAction
): Promise<WorkResult<ClientWorkRun>> {
  return post(`/api/work/runs/${runId}/control`, { action }, (data) => data.run as ClientWorkRun);
}

export type WorkApprovalDecisionInput = "allowed" | "allowed_always" | "denied";

/**
 * Answers one approval.
 *
 * `actionDigest` travels back with the decision on purpose: it is the proof that
 * the card the user read is the row being authorised. The server verifies it
 * (see `verifyApproval` in src/lib/work/digests.ts) and refuses a decision whose
 * digest does not match, so a card re-rendered from a stale event cannot approve
 * an action the user never saw.
 */
export function decideWorkApproval(
  approvalId: string,
  actionDigest: string,
  decision: WorkApprovalDecisionInput,
  reason?: string
): Promise<WorkResult<null>> {
  return post(
    `/api/work/approvals/${approvalId}/decision`,
    { decision, actionDigest, ...(reason === undefined ? {} : { reason }) },
    () => null
  );
}

// ---------------------------------------------------------------------------
// The event stream
// ---------------------------------------------------------------------------

/**
 * A frame of the session event stream, as the route writes it.
 *
 * `snapshot` arrives on connect AND again whenever a newer attempt takes over,
 * and the two cases mean different things to a reader — see `WorkStreamCursor`.
 */
export type WorkStreamFrame =
  | { type: "snapshot"; session: ClientWorkSession; run: ClientWorkRun | null; events: ClientWorkEvent[] }
  | { type: "events"; session: ClientWorkSession; run: ClientWorkRun | null; events: ClientWorkEvent[] }
  | { type: "done"; session: ClientWorkSession; run: ClientWorkRun | null };

/**
 * Where to resume from: both halves, always.
 *
 * `seq` is unique per RUN, not per session, so a cursor is only meaningful
 * beside the run it was taken from. Sending the seq alone would have the server
 * ignore it — it compares `runId` before honouring `after` — and every reconnect
 * would replay the whole run from zero, which floods the timeline and makes each
 * reconnect more expensive than the last.
 */
export interface WorkStreamCursor {
  runId: string | null;
  after: number;
}

/** Backoff bounds for the resume loop, matching the Code session hook's. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 15_000;

/** Minimal SSE reader: `data:` frames only, `:` heartbeats ignored. */
async function readFrames(
  stream: ReadableStream<Uint8Array>,
  onFrame: (frame: WorkStreamFrame) => void
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index: number;
    while ((index = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 2);
      if (!frame.startsWith("data:")) continue;
      try {
        onFrame(JSON.parse(frame.slice(5).trim()) as WorkStreamFrame);
      } catch {
        // A malformed frame is one lost event, not a lost session.
      }
    }
  }
}

export interface WorkStreamHandlers {
  onFrame: (frame: WorkStreamFrame) => void;
  /** Called when the stream will not be retried, with the reason it stopped. */
  onStopped: (outcome: WorkTransportFailure | WorkBlocked | { kind: "finished" }) => void;
  /** Read fresh on every reconnect, never captured once. */
  cursor: () => WorkStreamCursor;
}

/**
 * Follows one session's events, resuming from the caller's cursor after a drop.
 *
 * The stream is deliberately not left running for ever: the route closes it
 * after a four-minute window, and that close arrives here as a clean end of
 * body with no `done` frame. Reconnecting is therefore the normal path rather
 * than the error path, which is why a plain end-of-stream loops without
 * counting against the backoff.
 *
 * A refusal ends the loop rather than retrying it. The server answers 409 when
 * nothing can execute the run, and retrying that on a timer is how a task with
 * no possible executor becomes a spinner that never resolves.
 */
export function subscribeToWorkEvents(sessionId: string, handlers: WorkStreamHandlers): () => void {
  const controller = new AbortController();

  void (async () => {
    let attempt = 0;
    while (!controller.signal.aborted) {
      let clean = false;
      try {
        const { runId, after } = handlers.cursor();
        const query = new URLSearchParams({ after: String(after) });
        if (runId !== null) query.set("runId", runId);
        const res = await fetch(`/api/work/sessions/${sessionId}/events?${query.toString()}`, {
          signal: controller.signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) {
          const outcome = await refusal(res);
          // Only a transient server fault is worth another attempt; a refusal, a
          // missing session and a signed-out user are all permanent here.
          if (outcome.kind === "failed" && outcome.cause === "server") throw new Error("retry");
          handlers.onStopped(outcome);
          return;
        }
        let finished = false;
        await readFrames(res.body, (frame) => {
          if (frame.type === "done") finished = true;
          handlers.onFrame(frame);
        });
        if (finished) {
          handlers.onStopped({ kind: "finished" });
          return;
        }
        // The window expired with the run still going. Reconnect immediately and
        // reset the backoff: making the user wait fifteen seconds for a stream
        // the server closed on schedule would look exactly like a fault.
        clean = true;
        attempt = 0;
      } catch {
        if (controller.signal.aborted) return;
      }
      if (controller.signal.aborted) return;
      if (!clean) {
        attempt += 1;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(RECONNECT_BASE_MS * attempt, RECONNECT_MAX_MS))
        );
      }
    }
  })();

  return () => controller.abort();
}

// ---------------------------------------------------------------------------
// Reading host capability
// ---------------------------------------------------------------------------

/**
 * What a Mac can actually do right now, as opposed to what it once advertised.
 *
 * `serializeHost` passes the advertised list and the five permission toggles
 * through separately and deliberately never folds them into one boolean,
 * because presence and permission are different facts. Folding them is this
 * function's job, and it is written as an intersection rather than a union for
 * the reason that serialiser's comment gives: a Mac that is online, signed in
 * and has file work switched off must not be offered for file work.
 */
export function hostCapabilities(host: ClientWorkHost): WorkCapability[] {
  if (!host.enabled) return [];
  const advertised = capabilitiesFrom(host.capabilities);
  const permitted: Partial<Record<WorkCapability, boolean>> = {
    local_files: host.allowsFileWork,
    local_browser: host.allowsBrowser,
    local_computer_use: host.allowsComputerUse,
    // Driving an app through its accessibility tree is screen control by
    // another name, so it rides the same switch. There is no separate toggle,
    // and inventing one here would let a Mac with screen control refused drive
    // an app anyway.
    local_apps: host.allowsComputerUse,
    local_shell: host.allowsShell,
    background_continuation: host.allowsBackground,
  };
  return advertised.filter((capability) => permitted[capability] !== false);
}

/** Capabilities a Mac advertises but has switched off — the reason it is degraded. */
export function hostWithheldCapabilities(host: ClientWorkHost): WorkCapability[] {
  const advertised = capabilitiesFrom(host.capabilities);
  const granted = new Set(hostCapabilities(host));
  return advertised.filter((capability) => !granted.has(capability));
}

/** Whether a host is in a state that can accept a run at all. */
export function hostIsReachable(host: ClientWorkHost): boolean {
  return (
    host.enabled && host.revokedAt === null && (host.state === "online" || host.state === "idle")
  );
}

/**
 * The one sentence that explains a host's state, or null when it is simply fine.
 *
 * Ordered most-final first: a revoked Mac is not "offline", and telling a user
 * their Mac is asleep when they actually revoked its access sends them to wake
 * a machine that would refuse the work anyway.
 */
export function hostUnavailableReason(host: ClientWorkHost): string | null {
  if (host.revokedAt !== null) return "Access to this Mac was revoked.";
  if (!host.enabled) return "Juno Work is switched off on this Mac.";
  if (host.state === "offline") return "This Mac has not checked in for several minutes.";
  if (host.state === "stale") return "This Mac stopped checking in a minute ago.";
  return null;
}

export const HOST_STATE_LABEL: Record<WorkHostState, string> = {
  online: "Working",
  idle: "Ready",
  stale: "Not responding",
  offline: "Offline",
};
