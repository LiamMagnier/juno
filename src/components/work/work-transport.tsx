"use client";

import type {
  ClientWorkArtifact,
  ClientWorkGrant,
  ClientWorkHost,
  ClientWorkRun,
  ClientWorkSession,
  ClientWorkEvent,
} from "@/lib/work/serializers";
import {
  WORK_CAPABILITIES,
  WORK_PERMISSION_POLICIES,
  type WorkCapability,
  type WorkDegradation,
  type WorkHostState,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";
import type { ClientWorkSchedule } from "@/lib/work/schedule";
import type {
  ClientWorkSkill,
  ClientWorkSkillVersion,
  WorkSkillContract,
} from "@/lib/work/skills";

/*
 * Everything the Work surfaces ask the server for, in one place.
 *
 * Written the way `use-code-session.ts` documents the /api/code/tasks contract:
 * the transport is stated once, at the top, so a route handler and the UI that
 * reads it can be diffed against the same paragraph instead of against each
 * other. The endpoints, exactly as they exist under src/app/api/work:
 *
 *   GET  /api/work/sessions?limit=N        → { sessions: ClientWorkSession[] }
 *   POST /api/work/sessions                { goal, title?, requestedTarget,
 *                                            preferredHostId?, projectId?, model?,
 *                                            reasoningEffort?, attachmentIds?,
 *                                            idempotencyKey? }
 *          201 → { session }               ← a DRAFT. Nothing is dispatched.
 *   GET  /api/work/sessions/[id]           → { session, run }   (run = newest attempt)
 *   POST /api/work/sessions/[id]/runs      { origin?, requiredCapabilities?,
 *                                            requestedTarget?, model?,
 *                                            reasoningEffort?, idempotencyKey? }
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
 *   GET  /api/work/hosts                   → { hosts: ClientWorkHost[] }  ← revoked included
 *   GET  /api/work/hosts/[id]              → { host, grants, pendingCommands,
 *                                              routableCapabilities }
 *   PATCH /api/work/hosts/[id]             { enabled?, allows*?, approvalPolicy?,
 *                                            revoked?: false } → { host, refused }
 *   DELETE /api/work/hosts/[id]            → { host, cancelledCommands }
 *   PATCH /api/work/sessions/[id]          { title?, pinned?, archived? } → { session }
 *   GET  /api/work/schedules?limit=N       → { schedules: ClientWorkSchedule[] }
 *   POST /api/work/schedules               → 201 { schedule }
 *   GET|PATCH|DELETE /api/work/schedules/[id]
 *          PATCH → { schedule, scheduling, runs? }   ← prose about the next fire
 *   POST /api/work/schedules/[id]/run-now  → { run, selection, nextRunAt }
 *   GET  /api/work/schedules/[id]/runs     → { runs: ClientWorkRun[], nextBefore? }
 *   GET  /api/work/skills?limit=N          → { skills: ClientWorkSkill[] }
 *   POST /api/work/skills                  → 201 { skill, version }
 *   GET|PATCH|DELETE /api/work/skills/[id] → { skill, version }
 *   GET|POST /api/work/skills/[id]/versions → { versions } | 201 { skill, version }
 *   GET  /api/work/artifacts?sessionId=…   → { artifacts: ClientWorkArtifact[] }
 *   GET  /api/work/artifacts/[id]          → { artifact, versions, warning?, truncated }
 *   GET  /api/work/artifacts/[id]/download?version=N   ← bytes, not JSON
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
  /**
   * The server's own sentence about this failure, when it wrote one.
   *
   * Null for a fetch that never completed, and for the routes that answer with a
   * bare code and no prose — `requireUser`'s 401 is the common one — so a caller
   * that puts this in front of a reader needs a sentence of its own for that
   * case. It is carried because it is usually the only actionable part of the
   * failure: the dispatch route's 403 says which plan and what to do about it,
   * while `cause` says only "unauthorized", which is true of being signed out
   * too.
   */
  message: string | null;
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
 *
 * The body is read for every status, not only for those two. Reading it after
 * the 401/403 and 404 branches — which is how this was written — meant returning
 * before the one sentence the reader could have acted on had been looked at, and
 * the routes below have grown several: 403 `plan_locked` says "Your plan doesn't
 * include a model that can run a Work task", 503 `no_model_available` says the
 * deployment has none, and both arrived at the composer as an unexplained
 * failure with a Try again button on it.
 */
async function refusal(res: Response): Promise<WorkBlocked | WorkTransportFailure> {
  const data = await body(res);
  const message = text(data, "message");

  if (res.status === 409 || res.status === 429) {
    return {
      kind: "blocked",
      reason: text(data, "error") ?? "unavailable",
      explanation:
        message ?? "Juno cannot run this right now and did not say why. Try again in a moment.",
      missing: capabilitiesFrom(data.missing),
      degradation: degradationsFrom(data.degradation),
    };
  }
  if (res.status === 401 || res.status === 403) {
    return { kind: "failed", cause: "unauthorized", message };
  }
  if (res.status === 404) return { kind: "failed", cause: "not_found", message };
  // A 400 means this client sent something the route would not accept, which
  // no amount of retrying fixes. It is kept distinct from a 5xx so the UI can
  // stop offering a button that cannot work.
  return { kind: "failed", cause: res.status === 400 ? "rejected" : "server", message };
}

async function get<T>(url: string, pick: (data: Record<string, unknown>) => T): Promise<WorkResult<T>> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    // No response, so no sentence: a fetch that never completed has nothing the
    // server said about it, and inventing one here would put words in its mouth.
    return { kind: "failed", cause: "offline", message: null };
  }
  if (!res.ok) return refusal(res);
  return { kind: "ok", value: pick(await body(res)) };
}

/**
 * Every request with a body, in one place.
 *
 * POST, PATCH and DELETE differ here by one word, and writing three near-copies
 * of the same twelve lines is how one of them ends up without the try/catch that
 * turns a dropped connection into an `offline` outcome rather than an unhandled
 * rejection. DELETE carries no body in this surface, which is why `payload` is
 * allowed to be absent rather than sent as `null` — a JSON `null` body is a
 * different request from no body at all, and `req.json()` in the route handlers
 * reads the second as a parse failure.
 */
async function send<T>(
  method: "POST" | "PATCH" | "DELETE",
  url: string,
  payload: unknown,
  pick: (data: Record<string, unknown>) => T
): Promise<WorkResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      ...(payload === undefined
        ? {}
        : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }),
    });
  } catch {
    return { kind: "failed", cause: "offline", message: null };
  }
  if (!res.ok) return refusal(res);
  return { kind: "ok", value: pick(await body(res)) };
}

function post<T>(
  url: string,
  payload: unknown,
  pick: (data: Record<string, unknown>) => T
): Promise<WorkResult<T>> {
  return send("POST", url, payload, pick);
}

function patch<T>(
  url: string,
  payload: unknown,
  pick: (data: Record<string, unknown>) => T
): Promise<WorkResult<T>> {
  return send("PATCH", url, payload, pick);
}

function remove<T>(url: string, pick: (data: Record<string, unknown>) => T): Promise<WorkResult<T>> {
  return send("DELETE", url, undefined, pick);
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

/** One Mac and the folders it has been given, by display name and never by path. */
export interface WorkHostDetail {
  host: ClientWorkHost;
  grants: ClientWorkGrant[];
  /**
   * Commands queued or claimed at this Mac and not yet expired.
   *
   * A different number from `activeRunCount`: a run is the unit of work, a
   * command is one instruction in flight to the host, and a Mac that has gone
   * quiet accumulates the second without the first. Both are shown, because
   * "nothing is running but four instructions are waiting" is exactly the state
   * somebody about to revoke a Mac needs to see before they do.
   */
  pendingCommands: number;
  /** The manifest's capability keys, narrowed to the ones this relay can route. */
  routableCapabilities: WorkCapability[];
}

export function fetchWorkHost(hostId: string): Promise<WorkResult<WorkHostDetail>> {
  return get(`/api/work/hosts/${hostId}`, (data) => ({
    host: data.host as ClientWorkHost,
    grants: list<ClientWorkGrant>(data.grants),
    // Tolerant, like every other reader here: a build of this page talking to an
    // older deployment gets a body with neither key, and a settings screen that
    // threw on that would be unreachable rather than merely less informative.
    pendingCommands: typeof data.pendingCommands === "number" ? data.pendingCommands : 0,
    routableCapabilities: capabilitiesFrom(data.routableCapabilities),
  }));
}

/**
 * The switches on one Mac, as `hostPatchSchema` accepts them.
 *
 * Notably absent: `allowedApps`, `blockedApps`, `allowedDomains` and the
 * capability manifest. The route refuses all four on purpose — the manifest is
 * the host's to report through register/heartbeat, and the three lists are not
 * in the patch schema at all — so they are read-only on this surface and the
 * settings page says so in words rather than by greying a control out.
 *
 * `revoked` is `false`-only and un-revokes. Revoking is DELETE, which is where
 * the audit trail expects to find it.
 */
export interface PatchWorkHostInput {
  enabled?: boolean;
  allowsFileWork?: boolean;
  allowsBrowser?: boolean;
  allowsComputerUse?: boolean;
  allowsShell?: boolean;
  allowsBackground?: boolean;
  approvalPolicy?: WorkPermissionPolicy;
  revoked?: false;
}

export type WorkHostToggleKey = keyof Omit<PatchWorkHostInput, "approvalPolicy" | "revoked">;

export interface PatchedWorkHost {
  host: ClientWorkHost;
  /**
   * Switches the request asked to turn on that the Mac has not advertised.
   *
   * Carried rather than discarded because the route carries it: switching a
   * capability off always works, switching one on needs the Mac to have offered
   * it, and a control that snapped back with nothing beside it would be read as
   * a bug in this page rather than as the escalation boundary it is.
   */
  refused: WorkHostToggleKey[];
}

const HOST_TOGGLE_NAMES = new Set<string>([
  "enabled",
  "allowsFileWork",
  "allowsBrowser",
  "allowsComputerUse",
  "allowsShell",
  "allowsBackground",
]);

export function patchWorkHost(
  hostId: string,
  input: PatchWorkHostInput
): Promise<WorkResult<PatchedWorkHost>> {
  return patch(`/api/work/hosts/${hostId}`, { ...input }, (data) => ({
    host: data.host as ClientWorkHost,
    refused: (Array.isArray(data.refused) ? data.refused : []).filter(
      (key): key is WorkHostToggleKey => typeof key === "string" && HOST_TOGGLE_NAMES.has(key)
    ),
  }));
}

export interface RevokedWorkHost {
  host: ClientWorkHost;
  /**
   * Commands that were pending or claimed and have just been cancelled.
   *
   * The route retires the queue in the same breath as it sets `revokedAt`, so
   * this is the count of instructions that will now never reach the Mac. It is
   * the number the confirmation's aftermath should state: "revoked" alone does
   * not tell somebody that four things they asked for have stopped.
   */
  cancelledCommands: number;
}

export function revokeWorkHost(hostId: string): Promise<WorkResult<RevokedWorkHost>> {
  return remove(`/api/work/hosts/${hostId}`, (data) => ({
    host: data.host as ClientWorkHost,
    cancelledCommands: typeof data.cancelledCommands === "number" ? data.cancelledCommands : 0,
  }));
}

export interface CreateWorkSessionInput {
  goal: string;
  requestedTarget: "automatic" | "cloud" | "local";
  preferredHostId: string | null;
  /** The Project this task belongs to, so its files and instructions apply. */
  projectId?: string | null;
  /** A catalog id, or the Auto sentinel for "you choose when you dispatch". */
  model?: string | null;
  /**
   * `minimal` … `max`, or `null` for Instant.
   *
   * Absent and null are different requests and the route reads them that way:
   * absent leaves whatever the session carries alone, and null is the reader
   * asking for no extra reasoning at all — the only way to turn a tier back
   * off once one has been set.
   */
  reasoningEffort?: string | null;
  /** Already-uploaded attachments the run should be handed. */
  attachmentIds?: readonly string[];
  /**
   * The connected apps this task may reach, by provider id.
   *
   * Absent and `[]` are different requests, and unlike every other optional
   * field here the empty one is the common answer: the composer starts every
   * switch off, so a reader who turns none on is stating that this task reaches
   * no connector, and the route stores that as the answer it is. Absent is a
   * caller that has no control for this at all, and leaves the task behaving as
   * tasks did before the control existed. Sent whenever the composer showed the
   * control, therefore, and not only when something is in it.
   */
  connectorIds?: readonly string[];
  idempotencyKey: string;
}

/**
 * Writes the draft. Nothing runs until `startWorkRun` is called against it.
 *
 * Optional fields are spread in rather than assigned, so a composer with
 * nothing to say about one stays silent about it: an absent `model` leaves the
 * account default in place, while an explicit null would be a caller stating
 * that this session has no model — the exact state `scripts/work-runner.ts`
 * throws on before the first token.
 *
 * `reasoningEffort` is the one field where null is a sentence rather than a
 * silence, so it is tested against `undefined` and not for truthiness. Instant
 * IS null, and dropping it would leave the one tier a reader can pick that the
 * server never hears about.
 */
export function createWorkSession(
  input: CreateWorkSessionInput
): Promise<WorkResult<ClientWorkSession>> {
  return post(
    "/api/work/sessions",
    {
      goal: input.goal,
      requestedTarget: input.requestedTarget,
      ...(input.preferredHostId === null ? {} : { preferredHostId: input.preferredHostId }),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      ...(input.attachmentIds && input.attachmentIds.length > 0
        ? { attachmentIds: [...input.attachmentIds] }
        : {}),
      // Tested against `undefined` rather than for emptiness, like
      // `reasoningEffort` and unlike `attachmentIds`: an empty connector list is
      // a sentence — this task reaches nothing — and dropping it would turn the
      // reader's answer back into silence.
      ...(input.connectorIds === undefined ? {} : { connectorIds: [...input.connectorIds] }),
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
  /**
   * What this attempt must be able to do — and, now, optional.
   *
   * The composer used to send a list the user had assembled from a checklist of
   * Juno's own capability names. It no longer sends anything: the server infers
   * the requirements from the goal (`inferCapabilities`, src/lib/work/inference.ts),
   * which is both a better list and the same list the local preview was drawn
   * from. Omitting the key entirely is what asks for that; sending `[]` would
   * be a caller asserting the task needs nothing, which reads as "cloud" and
   * would quietly override the inference.
   *
   * A caller that genuinely knows still passes one, and one does: the task
   * detail page carries the previous attempt's requirements into a retry, so
   * the retry is judged against the bar the first attempt was.
   */
  requiredCapabilities?: readonly WorkCapability[];
  /** Overrides the session's own target for this attempt only. */
  requestedTarget?: "automatic" | "cloud" | "local";
  /** Overrides the session's model for this attempt only. */
  model?: string | null;
  /** Absent, a tier, or null for Instant — read the way `CreateWorkSessionInput` describes. */
  reasoningEffort?: string | null;
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
      ...(input.requiredCapabilities === undefined
        ? {}
        : { requiredCapabilities: [...input.requiredCapabilities] }),
      ...(input.requestedTarget === undefined ? {} : { requestedTarget: input.requestedTarget }),
      ...(input.model ? { model: input.model } : {}),
      ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
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
 * run is asking now, which is why steering below is a separate call rather than
 * this one with the id left off.
 */
export function answerWorkQuestion(
  sessionId: string,
  questionId: string,
  answer: string
): Promise<WorkResult<null>> {
  return post(`/api/work/sessions/${sessionId}/answer`, { questionId, text: answer }, () => null);
}

/** What the route did with an instruction that was not an answer. */
export interface WorkSteerOutcome {
  /**
   * Whether the run this was recorded against will read it.
   *
   * True for a cloud run, where the executor drains unconsumed instructions
   * between turns and puts them in front of the model; false for one running on
   * a Mac, where the host app is handed its instructions when a run starts and
   * has no such reader yet. Carried rather than assumed because the surface that
   * shows it has to say something different in each case, and because assuming
   * the true one is how a UI comes to report a delivery that did not happen.
   */
  delivered: boolean;
  explanation: string;
}

/**
 * Sends an instruction that is not an answer to anything.
 *
 * Same route as the answer, different body, and deliberately a different
 * function: the two are different requests with different preconditions — an
 * answer needs a run that is waiting for one, and a steer needs a run that is
 * not — and one function taking an optional id would have every caller re-derive
 * which of the two it was making.
 */
export function steerWorkRun(
  sessionId: string,
  instruction: string
): Promise<WorkResult<WorkSteerOutcome>> {
  return post(`/api/work/sessions/${sessionId}/answer`, { text: instruction }, (data) => ({
    delivered: data.delivered === true,
    explanation: text(data, "explanation") ?? "Recorded on this task.",
  }));
}

/**
 * Renames, pins or archives a session.
 *
 * Each field is optional and an absent one is left alone, so the row's menu can
 * send the one thing the user touched. Sending all three would have a pin
 * re-assert a title, which is enough to make `titleSource` manual on a session
 * the user never renamed and stop the auto-titler for good.
 */
export interface PatchWorkSessionInput {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
}

export function patchWorkSession(
  sessionId: string,
  input: PatchWorkSessionInput
): Promise<WorkResult<ClientWorkSession>> {
  return patch(
    `/api/work/sessions/${sessionId}`,
    {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.pinned === undefined ? {} : { pinned: input.pinned }),
      ...(input.archived === undefined ? {} : { archived: input.archived }),
    },
    (data) => data.session as ClientWorkSession
  );
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/**
 * One trigger as a form holds it.
 *
 * `config` is an untyped object on purpose: the shape depends entirely on
 * `kind`, and the two parsers on the server — `parseTimeTrigger` and
 * `parseTriggerConfig` — are the definition of what each kind accepts. A zod
 * union restated here would be a second, less specific copy that disagrees with
 * the scheduler the first time a field is added on that side.
 */
export interface WorkTriggerDraft {
  kind: string;
  config: Record<string, unknown>;
  enabled: boolean;
  dedupeWindowSec?: number;
}

export interface WorkScheduleInput {
  name: string;
  instructions: string;
  timezone: string;
  target: "cloud" | "local" | "automatic";
  hostId: string | null;
  enabled: boolean;
  triggers: readonly WorkTriggerDraft[];
  unattendedPolicy: string;
  hostOfflinePolicy: string;
  missedRunPolicy: string;
  notifyPolicy: string;
  maxConcurrentRuns: number;
}

function scheduleBody(input: WorkScheduleInput): Record<string, unknown> {
  return {
    name: input.name,
    instructions: input.instructions,
    timezone: input.timezone,
    target: input.target,
    // Null is a real instruction on PATCH — "this schedule is no longer pinned
    // to one Mac" — and the create route reads an absent key the same way, so
    // the same body serves both.
    hostId: input.hostId,
    enabled: input.enabled,
    triggers: input.triggers.map((trigger) => ({
      kind: trigger.kind,
      config: trigger.config,
      enabled: trigger.enabled,
      ...(trigger.dedupeWindowSec === undefined ? {} : { dedupeWindowSec: trigger.dedupeWindowSec }),
    })),
    unattendedPolicy: input.unattendedPolicy,
    hostOfflinePolicy: input.hostOfflinePolicy,
    missedRunPolicy: input.missedRunPolicy,
    notifyPolicy: input.notifyPolicy,
    maxConcurrentRuns: input.maxConcurrentRuns,
  };
}

export function fetchWorkSchedules(limit = 50): Promise<WorkResult<ClientWorkSchedule[]>> {
  return get(`/api/work/schedules?limit=${limit}`, (data) =>
    list<ClientWorkSchedule>(data.schedules)
  );
}

export function fetchWorkSchedule(id: string): Promise<WorkResult<ClientWorkSchedule>> {
  return get(`/api/work/schedules/${id}`, (data) => data.schedule as ClientWorkSchedule);
}

export function createWorkSchedule(
  input: WorkScheduleInput
): Promise<WorkResult<ClientWorkSchedule>> {
  return post("/api/work/schedules", scheduleBody(input), (data) => data.schedule as ClientWorkSchedule);
}

/**
 * What a save changed, in the server's own words.
 *
 * `scheduling` is the sentence the PATCH route writes about whether the next
 * fire moved, and `runs` is what pausing did to the fires already queued. Both
 * are shown rather than summarised here: a pause that cancelled two queued runs
 * and left one under way is a fact the user has to be told, and it is not
 * derivable from the schedule row that comes back beside it.
 */
export interface SavedWorkSchedule {
  schedule: ClientWorkSchedule;
  scheduling: string | null;
  runs: string | null;
}

export function patchWorkSchedule(
  id: string,
  input: Partial<WorkScheduleInput>
): Promise<WorkResult<SavedWorkSchedule>> {
  const full =
    input.name !== undefined &&
    input.instructions !== undefined &&
    input.timezone !== undefined &&
    input.target !== undefined &&
    input.triggers !== undefined;
  return patch(
    `/api/work/schedules/${id}`,
    // A full edit sends the whole object, which is what the route is written
    // for — it compares the submitted trigger set against the stored one and
    // only moves the next fire when the clock kinds really changed. A partial
    // patch (the pause button) sends only what it touched.
    full
      ? scheduleBody(input as WorkScheduleInput)
      : {
          ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
          ...(input.name === undefined ? {} : { name: input.name }),
        },
    (data) => ({
      schedule: data.schedule as ClientWorkSchedule,
      scheduling: text(data, "scheduling"),
      runs:
        data.runs !== null && typeof data.runs === "object" && !Array.isArray(data.runs)
          ? text(data.runs as Record<string, unknown>, "explanation")
          : null,
    })
  );
}

export function deleteWorkSchedule(id: string): Promise<WorkResult<string | null>> {
  return remove(`/api/work/schedules/${id}`, (data) =>
    data.runs !== null && typeof data.runs === "object" && !Array.isArray(data.runs)
      ? text(data.runs as Record<string, unknown>, "explanation")
      : null
  );
}

/**
 * Fires a schedule once without moving it.
 *
 * The key is minted per press rather than per component, for the reason
 * `workIdempotencyKey` gives: the route replays a repeated key instead of
 * starting a second run, which is what makes "press it again" safe on a
 * connection that dropped the first response.
 */
export function runWorkScheduleNow(id: string): Promise<WorkResult<ClientWorkRun>> {
  return post(
    `/api/work/schedules/${id}/run-now`,
    { idempotencyKey: workIdempotencyKey() },
    (data) => data.run as ClientWorkRun
  );
}

export function fetchWorkScheduleRuns(id: string, limit = 10): Promise<WorkResult<ClientWorkRun[]>> {
  return get(`/api/work/schedules/${id}/runs?limit=${limit}`, (data) => list<ClientWorkRun>(data.runs));
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export function fetchWorkSkills(limit = 100): Promise<WorkResult<ClientWorkSkill[]>> {
  return get(`/api/work/skills?limit=${limit}`, (data) => list<ClientWorkSkill>(data.skills));
}

export interface WorkSkillDetail {
  skill: ClientWorkSkill;
  /** Null when `currentVersion` names a row that is not there. Never a substitute. */
  version: ClientWorkSkillVersion | null;
}

export function fetchWorkSkill(id: string): Promise<WorkResult<WorkSkillDetail>> {
  return get(`/api/work/skills/${id}`, (data) => ({
    skill: data.skill as ClientWorkSkill,
    version: (data.version as ClientWorkSkillVersion | null) ?? null,
  }));
}

export interface CreateWorkSkillInput {
  name: string;
  description: string;
  instructions: string;
  /**
   * Where it came from, which decides its starting trust and is therefore not
   * defaulted. `authored` starts `user_authored`; `imported` starts untrusted,
   * so the planner cannot reach for instructions the user has not read.
   */
  origin: "authored" | "imported";
}

export function createWorkSkill(input: CreateWorkSkillInput): Promise<WorkResult<ClientWorkSkill>> {
  return post(
    "/api/work/skills",
    {
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      origin: input.origin,
      // Never on by default. Automatic selection is the planner reaching for a
      // set of instructions unprompted, and that is a decision the author makes
      // afterwards, deliberately, once the skill exists and can be read back.
      autoSelect: false,
    },
    (data) => data.skill as ClientWorkSkill
  );
}

export interface PatchWorkSkillInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  autoSelect?: boolean;
  /** `verified` is absent from the vocabulary a client may set, on purpose. */
  trust?: "untrusted" | "user_authored";
}

export function patchWorkSkill(
  id: string,
  input: PatchWorkSkillInput
): Promise<WorkResult<ClientWorkSkill>> {
  return patch(`/api/work/skills/${id}`, { ...input }, (data) => data.skill as ClientWorkSkill);
}

export function deleteWorkSkill(id: string): Promise<WorkResult<null>> {
  return remove(`/api/work/skills/${id}`, () => null);
}

export function fetchWorkSkillVersions(
  id: string
): Promise<WorkResult<ClientWorkSkillVersion[]>> {
  return get(`/api/work/skills/${id}/versions`, (data) =>
    list<ClientWorkSkillVersion>(data.versions)
  );
}

/**
 * Mints a version: either new instructions, or a restore of an older one.
 *
 * The route refuses a body carrying both and refuses one carrying neither, so
 * the union is expressed here rather than as two optional fields a caller could
 * fill in together.
 */
export type MintWorkSkillVersionInput =
  | { instructions: string; contract?: WorkSkillContract }
  | { restoreVersion: number };

export function mintWorkSkillVersion(
  id: string,
  input: MintWorkSkillVersionInput
): Promise<WorkResult<ClientWorkSkillVersion>> {
  return post(`/api/work/skills/${id}/versions`, input, (data) => data.version as ClientWorkSkillVersion);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

/**
 * One source a version cites.
 *
 * Declared structurally rather than imported from `@/lib/work/deliverables`,
 * which reaches for `node:crypto` and has no business anywhere near a browser
 * bundle. The reader below drops an entry it cannot make sense of: a citation
 * rendered from a half-understood row is worse than an absent one, because a
 * reviewer would go and check it.
 */
export interface WorkProvenanceEntry {
  /** `web_page`, `connector_record`, `file`, `user_input`, `computed`. */
  kind: string;
  label: string;
  url: string | null;
}

function provenanceFrom(raw: unknown): WorkProvenanceEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const kind = text(record, "kind");
    const label = text(record, "label");
    if (kind === null || label === null) return [];
    return [{ kind, label, url: text(record, "url") }];
  });
}

/** One stored version of a deliverable, as `/artifacts/[id]` describes it. */
export interface WorkArtifactVersion {
  version: number;
  byteSize: number;
  /** SHA-256 of the bytes. The download route re-checks it before serving. */
  contentHash: string;
  /** `generated`, `uploaded`, and whatever a later build adds. */
  origin: string;
  runId: string | null;
  /** Whether the validator re-opened this version's bytes successfully. */
  validated: boolean;
  provenance: WorkProvenanceEntry[];
  createdAt: string;
}

export interface WorkArtifactDetail {
  artifact: ClientWorkArtifact;
  versions: WorkArtifactVersion[];
  /** The server's sentence when the current version was never re-opened. */
  warning: string | null;
}

/**
 * Whether a stored verdict says a version's bytes were re-opened.
 *
 * Rebuilt from the JSON rather than trusted as a shape, exactly as the download
 * route does it: the column is written by whichever build produced the version,
 * and anything that is not an explicit `ok: true` resolves to "not validated" —
 * the direction that warns rather than the one that reassures.
 */
function versionValidated(raw: unknown): boolean {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return false;
  return (raw as Record<string, unknown>).ok === true;
}

export function fetchWorkArtifacts(sessionId: string): Promise<WorkResult<ClientWorkArtifact[]>> {
  return get(`/api/work/artifacts?sessionId=${encodeURIComponent(sessionId)}`, (data) =>
    list<ClientWorkArtifact>(data.artifacts)
  );
}

export function fetchWorkArtifact(id: string): Promise<WorkResult<WorkArtifactDetail>> {
  return get(`/api/work/artifacts/${id}`, (data) => ({
    artifact: data.artifact as ClientWorkArtifact,
    versions: list<Record<string, unknown>>(data.versions).map((version) => ({
      version: typeof version.version === "number" ? version.version : 0,
      byteSize: typeof version.byteSize === "number" ? version.byteSize : 0,
      contentHash: text(version, "contentHash") ?? "",
      origin: text(version, "origin") ?? "generated",
      runId: text(version, "runId"),
      validated: versionValidated(version.validation),
      provenance: provenanceFrom(version.provenance),
      createdAt: text(version, "createdAt") ?? "",
    })),
    warning: text(data, "warning"),
  }));
}

/**
 * Where the bytes are.
 *
 * A plain link rather than a fetch-and-blob: the route sets
 * `Content-Disposition: attachment` and verifies the SHA-256 before a byte goes
 * out, so the browser's own download is already the right behaviour, and
 * pulling a 100 MB deck into memory to hand it straight back would only add a
 * way to run out of it.
 */
export function workArtifactDownloadUrl(artifactId: string, version?: number): string {
  return version === undefined
    ? `/api/work/artifacts/${artifactId}/download`
    : `/api/work/artifacts/${artifactId}/download?version=${version}`;
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

/**
 * The ceiling: the switches the Mac itself last said it can offer.
 *
 * `WorkHost.capabilities` holds the advertisement verbatim and `serializeHost`
 * passes it through, so this is a read of what the machine claimed rather than
 * of what is currently in force — the boolean columns hold the second, after the
 * owner has narrowed it. The settings screen needs both: a switch that is off
 * because the Mac cannot do it and a switch that is off because somebody turned
 * it off are the same pixel and completely different sentences.
 *
 * Read here rather than imported from `@/lib/work/relay`, whose
 * `parseAdvertisement` is the server's copy of this. That module is Prisma-free
 * but pulls zod, which nothing in the client bundle does today, and this file
 * already keeps its own tolerant `capabilitiesFrom` beside the relay's
 * `advertisedCapabilityKeys` for the same reason.
 *
 * An unreadable manifest yields every switch false, which is the safe way to be
 * wrong: the reader is told the Mac has not offered a capability it may in fact
 * have, and can switch it on from the Mac. The other way round would draw a live
 * switch for a capability the route will refuse.
 */
export function hostAdvertisedToggles(host: ClientWorkHost): Record<WorkHostToggleKey, boolean> {
  const manifest = host.capabilities;
  const toggles =
    manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as { toggles?: unknown }).toggles
      : undefined;
  const read = (key: WorkHostToggleKey): boolean =>
    toggles !== null &&
    typeof toggles === "object" &&
    !Array.isArray(toggles) &&
    (toggles as Record<string, unknown>)[key] === true;
  return {
    enabled: read("enabled"),
    allowsFileWork: read("allowsFileWork"),
    allowsBrowser: read("allowsBrowser"),
    allowsComputerUse: read("allowsComputerUse"),
    allowsShell: read("allowsShell"),
    allowsBackground: read("allowsBackground"),
  };
}

/**
 * The loosest approval policy the Mac has offered, or null when it said nothing.
 *
 * The same asymmetry as the toggles in three values instead of two: the owner
 * may pick any policy at least as strict as this, and asking for a looser one
 * lands on the Mac's. Null means the manifest carried no readable policy, and
 * the caller should offer no ceiling at all rather than guess at one —
 * `conservative`, which the server substitutes when it cannot read the
 * advertisement, would grey out two of the three segments on the strength of a
 * field that was simply missing.
 */
export function hostAdvertisedPolicy(host: ClientWorkHost): WorkPermissionPolicy | null {
  const manifest = host.capabilities;
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return null;
  const policy = (manifest as { approvalPolicy?: unknown }).approvalPolicy;
  return typeof policy === "string" && (WORK_PERMISSION_POLICIES as readonly string[]).includes(policy)
    ? (policy as WorkPermissionPolicy)
    : null;
}

/**
 * One of the host's allow/block lists as a list of strings.
 *
 * The three columns are JSON and the Mac writes them, so this reads what is
 * there and drops what it cannot render — a list that arrived as an object, or
 * with a number in it, produces the entries it does have rather than nothing.
 * These are display-only on the web: `hostPatchSchema` does not accept them.
 */
export function hostNameList(raw: ClientWorkHost["allowedApps"]): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
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
