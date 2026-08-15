import { NextResponse } from "next/server";
import type { CodeDevice, CodeTask, CodeTaskEvent, Prisma } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import { env } from "@/lib/env";
import { encryptMessageText } from "@/lib/message-crypto";
import { getCurrentUser, type SessionUser } from "@/lib/session";
import { readTaskToken, verifyTaskToken } from "@/lib/cloud-code-token";
import { verifyGithubActionsOidc } from "@/lib/github-oidc";
import type { ClientActivityEvent } from "@/types/chat";

export { appendTaskEvents, type TaskEventInput } from "@/lib/code-task-events";

export const ONLINE_WINDOW_MS = 120_000;

export const TASK_STATUSES = ["queued", "running", "awaiting_approval", "done", "failed", "cancelled"] as const;

export const TERMINAL_TASK_STATUSES = ["done", "failed", "cancelled"] as const;

export function isTerminalTaskStatus(status: string): boolean {
  return (TERMINAL_TASK_STATUSES as readonly string[]).includes(status);
}

export const EVENT_KINDS = [
  "status",
  "user",
  "text",
  "tool",
  "file_change",
  "approval_request",
  "approval_response",
  "cancel_request",
  "error",
  "done",
  // Subagent lifecycle snapshots ({ agent: SubagentPublicState }) from
  // multi-agent runs — the web UI renders live agent cards from these.
  "agent",
  /*
   * ONE-CLICK ROLLBACK — four kinds, and the first of them is why the other
   * three are safe to offer.
   *
   * `rollback_ready` ({ paths?: string[] }) is a HOST CAPABILITY ANNOUNCEMENT,
   * posted once by a host that can actually act on the three verbs below. It
   * exists because presence is not capability — the same distinction
   * `CodeDevice.servesQueuedTasks` was added for, and for the same reason: a
   * host being online said nothing about whether it would honour the work sent
   * to it, and reading one as the other put controls in front of people that
   * nothing was ever going to execute. Every host in the field today announces
   * nothing, so the web shows no rollback controls at all, which is the correct
   * behaviour for a host that cannot honour them.
   *
   * `accept_change` / `reject_change` / `undo_change` are the CONTROL verbs
   * (web → host; see CONTROL_KINDS in code-task-events.ts) and they are named
   * after what runner/agent-core's CheckpointStore can genuinely do, not after
   * a review workflow it cannot:
   *   accept_change { requestId, path }  → keepFile:    pin one file so no
   *                                        later undo reverts it.
   *   reject_change { requestId, path }  → revertFile:  put ONE file back to
   *                                        the state it had before the agent
   *                                        first wrote it.
   *   undo_change   { requestId }        → undoLastTurn: rewind every file the
   *                                        last file-changing turn touched.
   * There is deliberately no "reject everything since turn N": the checkpoint
   * index truncates on rewind, so only the last turn is soundly poppable.
   *
   * `rollback_result` ({ requestId, verb, status, paths?, message? }) closes
   * the loop. `status` is "applied" | "unsupported" | "failed" — "unsupported"
   * being the honest answer for a file with no snapshot behind it (anything
   * bash wrote is outside the snapshot net). The web must not show a rollback
   * as done until this arrives: the control channel is fire-and-forget, so an
   * enqueued verb is a request, never an outcome.
   */
  "rollback_ready",
  "accept_change",
  "reject_change",
  "undo_change",
  "rollback_result",
] as const;

/** The rollback verbs a client may ask for, and the only values the rollback
 *  route accepts. Kept beside EVENT_KINDS because they are a SUBSET of it —
 *  every verb is also an event kind, since enqueuing one IS appending it. */
export const ROLLBACK_VERBS = ["accept_change", "reject_change", "undo_change"] as const;
export type RollbackVerb = (typeof ROLLBACK_VERBS)[number];

/** Verbs that name one file and are meaningless without it. `undo_change` acts
 *  on a whole turn and takes none. */
export const ROLLBACK_VERBS_NEEDING_PATH: readonly RollbackVerb[] = ["accept_change", "reject_change"];

export async function requireUser(): Promise<
  { user: SessionUser; error: null } | { user: null; error: NextResponse }
> {
  const user = await getCurrentUser();
  if (!user) {
    return { user: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  return { user, error: null };
}

// A cloud-code task bearer looks like `Bearer cct_<payload>.<sig>`. Matching the
// prefix lets us route it to task-token auth instead of native-bearer auth,
// which would otherwise 401 a perfectly valid task token.
const CCT_BEARER_RE = /^Bearer (cct_[A-Za-z0-9._-]+)$/;
// The runner-context handoff authenticates with a GitHub Actions OIDC JWT carried
// as a plain `Bearer <jwt>` (three dot-separated base64url segments). We hand the
// raw token to the OIDC verifier, so any non-JWT bearer (including a cct_ token)
// simply fails verification.
const BEARER_RE = /^Bearer (.+)$/;

export type TaskAuthResult =
  | { user: SessionUser; viaTaskToken: boolean; error: null }
  | { user: null; viaTaskToken: false; error: NextResponse };

/**
 * Authorize a request against ONE specific task. Succeeds either:
 *  - via a normal user session / native bearer (requireUser — UNCHANGED), or
 *  - via a valid Cloud Code task bearer ("Authorization: Bearer cct_…") whose
 *    audience is EXACTLY this taskId — so the GitHub Actions runner can drive
 *    the task it was dispatched for and nothing else.
 *
 * Task-token requests resolve to the task's owner (loaded from the DB) so the
 * routes' existing ownership-scoped queries (`where: { id, userId }`) keep
 * working untouched. The cct_ branch is tried first: a task bearer must never
 * fall through to native-bearer auth. `viaTaskToken` lets a route tighten
 * behavior (e.g. runner-context is task-token-ONLY).
 */
export async function requireTaskAuth(taskId: string, req: Request): Promise<TaskAuthResult> {
  const authorization = req.headers.get("authorization");
  const match = authorization ? CCT_BEARER_RE.exec(authorization) : null;
  if (match) {
    const unauthorized = {
      user: null,
      viaTaskToken: false as const,
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    };
    if (!verifyTaskToken(match[1], taskId)) return unauthorized;
    // Intentional cross-user lookup: the verified task token IS the authorization,
    // so we resolve the owner by bare id (the ownership guard requires a userId
    // filter it can't have here) via the unguarded client.
    const task = await prismaUnguarded.codeTask.findUnique({ where: { id: taskId }, select: { userId: true } });
    if (!task) return unauthorized;
    return { user: { id: task.userId }, viaTaskToken: true, error: null };
  }
  const { user, error } = await requireUser();
  if (!user) return { user: null, viaTaskToken: false, error };
  return { user, viaTaskToken: false, error: null };
}

/**
 * Resolve a Cloud Code task bearer to its task WITHOUT binding to a known
 * taskId — for surfaces that have no taskId in their path (the provider proxy).
 * Returns null when the Authorization header is absent, not a task token, or
 * invalid/expired. The token's own embedded audience selects the task, so it
 * can only ever resolve to that one task's owner. `status` lets the proxy refuse
 * calls for a task that has already finished (a terminal task must not keep
 * spending plan budget through a replayed runner).
 */
export async function taskTokenAuth(
  req: Request,
): Promise<{ user: SessionUser; taskId: string; status: string } | null> {
  const authorization = req.headers.get("authorization");
  const match = authorization ? CCT_BEARER_RE.exec(authorization) : null;
  if (!match) return null;
  const taskId = readTaskToken(match[1]);
  if (!taskId) return null;
  // Unguarded by design — the token's verified audience selects the task and
  // authorizes resolving its owner (see requireTaskAuth).
  const task = await prismaUnguarded.codeTask.findUnique({
    where: { id: taskId },
    select: { userId: true, status: true },
  });
  return task ? { user: { id: task.userId }, taskId, status: task.status } : null;
}

/**
 * Authorize the runner-context handoff for ONE task via a GitHub Actions OIDC
 * token ("Authorization: Bearer <oidc-jwt>"). The runner proves its identity
 * with a GitHub-SIGNED JWT it fetches at runtime (audience "juno-cloud-code") —
 * NO credential rides the public workflow_dispatch inputs, so nothing sensitive
 * is ever echoed into the public Actions log. verifyGithubActionsOidc checks the
 * RS256 signature (GitHub JWKS), issuer, audience, expiry, the repository
 * allowlist (env.cloudCodeRepo), and that the token was minted by OUR
 * code-runner.yml workflow. The taskId comes from the request path; only the
 * backend can workflow_dispatch a runner for a given taskId (GITHUB_DISPATCH_TOKEN),
 * so binding the verified runner to that taskId is safe.
 *
 * Distinct from requireTaskAuth on purpose: runner-context is the SINGLE place
 * the OIDC handoff is redeemed. A cct_ task token is NOT accepted here (it fails
 * JWT verification). A browser user SESSION is refused with 403 — this endpoint's
 * response carries the user's decrypted clone token, which must never reach a
 * browser. Resolves to the task's owner (unguarded lookup) so the route's
 * ownership-scoped queries work.
 */
export async function requireOidcRunnerAuth(
  taskId: string,
  req: Request,
): Promise<{ user: SessionUser; error: null } | { user: null; error: NextResponse }> {
  const unauthorized = {
    user: null,
    error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
  };
  const authorization = req.headers.get("authorization");
  const match = authorization ? BEARER_RE.exec(authorization) : null;
  if (!match) {
    // No bearer. If the caller nonetheless holds a valid user session (a browser
    // hitting this runner-only endpoint), refuse with 403 rather than 401 — the
    // response would carry the user's decrypted clone token. Otherwise it's
    // simply unauthenticated → 401.
    const sessionUser = await getCurrentUser();
    if (sessionUser) {
      return { user: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
    }
    return unauthorized;
  }
  const result = await verifyGithubActionsOidc(match[1], { repository: env.cloudCodeRepo });
  if (!result.ok) {
    console.warn(`[cloud-code] runner-context OIDC rejected: ${result.reason}`);
    // Surface the coarse, secret-free reason: it can't help forge a valid token
    // (that needs a real run of OUR workflow) and it makes runner failures
    // diagnosable without server-log access.
    return {
      user: null,
      error: NextResponse.json({ error: "Unauthorized", reason: result.reason }, { status: 401 }),
    };
  }
  // OIDC passed → this is a trusted runner of our workflow. A missing task is a
  // genuine 404 (not 401): conflating the two hid whether auth or the task was
  // the problem, and a trusted runner is never a task-existence oracle for an
  // attacker (who can't pass OIDC at all).
  const task = await prismaUnguarded.codeTask.findUnique({ where: { id: taskId }, select: { userId: true } });
  if (!task) return { user: null, error: NextResponse.json({ error: "Not found" }, { status: 404 }) };
  return { user: { id: task.userId }, error: null };
}

export function serializeDevice(device: CodeDevice, online?: boolean) {
  const base = {
    id: device.id,
    name: device.name,
    platform: device.platform,
    appVersion: device.appVersion,
    protocolVersion: device.protocolVersion,
    workspaces: device.workspaces,
    sessionCount: device.sessionCount,
    activeCount: device.activeCount,
    // Presence and capability are different facts. A client that reads
    // `online` as "can run my work" is the bug this field exists to end: the
    // Mac is online and signed in, and it still claims nothing.
    servesQueuedTasks: device.servesQueuedTasks,
    lastSeenAt: device.lastSeenAt.toISOString(),
  };
  return online === undefined ? base : { ...base, online };
}

export function serializeTask(task: CodeTask) {
  return {
    id: task.id,
    deviceId: task.deviceId,
    workspacePath: task.workspacePath,
    workspaceName: task.workspaceName,
    workspaceKey: task.workspaceKey,
    title: task.title,
    prompt: task.prompt,
    status: task.status,
    lastSeq: task.lastSeq,
    conversationId: task.conversationId,
    parentSessionId: task.parentSessionId,
    createsNewSession: task.createsNewSession,
    origin: task.origin,
    // Cloud Juno Code: "device" (default) runs on a registered host; "cloud"
    // runs on a GitHub Actions runner against repoOwner/repoName and opens a PR.
    target: task.target,
    repoOwner: task.repoOwner,
    repoName: task.repoName,
    baseRef: task.baseRef,
    prUrl: task.prUrl,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

export function serializeTaskEvent(event: CodeTaskEvent) {
  return {
    seq: event.seq,
    kind: event.kind,
    payload: event.payload,
    createdAt: event.createdAt.toISOString(),
  };
}

/** Deterministic Message id for the assistant turn a linked task produced —
 *  one task, one message, so repeated terminal posts upsert instead of piling
 *  up duplicates, and the web client can address the row without a join. */
export function codeTaskMessageId(taskId: string): string {
  return `codetask_${taskId}`;
}

type EventPayload = Record<string, unknown>;

const payloadStr = (payload: Prisma.JsonValue, key: string): string | null => {
  const value = (payload as EventPayload | null)?.[key];
  return typeof value === "string" ? value : null;
};
const payloadNum = (payload: Prisma.JsonValue, key: string): number | null => {
  const value = (payload as EventPayload | null)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/*
 * THE UNIFIED DIFF A `file_change` EVENT MAY CARRY, AND WHAT IT COSTS.
 *
 * `ClientActivityEvent` is the CHAT vocabulary — every surface that renders a
 * transcript reads it, and a patch is meaningful to exactly one of them. So the
 * diff rides as an extra key on the write row rather than widening the shared
 * shape: a reader that does not know the key sees precisely the row it saw
 * before, which is the same absent-tolerance the producer side has.
 *
 * KNOWN GAP, and it is one line to close: `serializeActivity` in
 * src/lib/serializers.ts rebuilds activity rows from a FIELD WHITELIST, so a
 * `patch` written here is stored but dropped on read-back until `patch` is
 * added to that whitelist. It is written anyway because the alternative is
 * discarding hunks that the events table already holds and that this is the
 * only pass to ever fold them; the live surface reads its diffs from the task
 * stream directly (see use-code-session.ts) and does not depend on this.
 *
 * The two caps below exist because `Message.activity` is a JSON column that is
 * loaded whole on every thread read. A fifty-file run at the cloud runner's
 * 40 KB-per-file cap is a two-megabyte row, and an activity log that outweighs
 * the conversation it annotates makes every history load slower for a diff
 * almost nobody scrolls to. A patch that does not fit is dropped ENTIRE rather
 * than sliced: a truncated-but-unlabelled hunk reads as the whole change.
 */
type WriteActivityEvent = ClientActivityEvent & { patch?: string };
const MAX_PERSISTED_PATCH_CHARS = 16_000;
const MAX_PERSISTED_PATCH_BUDGET = 120_000;

/**
 * Persist the outcome of a conversation-linked task as a normal ASSISTANT
 * Message, so the code session's history reloads exactly like chat history.
 * Idempotent (deterministic id + upsert) and a no-op for unlinked tasks or
 * tasks that are still running. Call after any status write that can be
 * terminal; failures must never break the host's event ack, so callers wrap
 * this in try/catch (it also swallows a vanished conversation itself).
 */
export async function persistCodeTaskOutcome(task: CodeTask): Promise<void> {
  if (!task.conversationId || !isTerminalTaskStatus(task.status)) return;
  const conversation = await prisma.conversation.findFirst({
    where: { id: task.conversationId, userId: task.userId },
    select: { id: true },
  });
  if (!conversation) return; // deleted independently of the task — nothing to write to

  const events = await prisma.codeTaskEvent.findMany({
    where: { taskId: task.id },
    orderBy: { seq: "asc" },
  });

  const textParts: string[] = [];
  const activity: WriteActivityEvent[] = [];
  const agentSnapshots = new Map<string, { event: CodeTaskEvent; agent: Record<string, unknown> }>();
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let errorMessage: string | null = null;
  let patchBudget = MAX_PERSISTED_PATCH_BUDGET;
  const push = (event: CodeTaskEvent, entry: Omit<WriteActivityEvent, "id" | "createdAt">) =>
    activity.push({ id: `evt-${event.seq}`, createdAt: event.createdAt.toISOString(), ...entry });

  for (const event of events) {
    switch (event.kind) {
      case "text": {
        const text = payloadStr(event.payload, "text");
        if (text) textParts.push(text);
        break;
      }
      case "tool": {
        const summary = payloadStr(event.payload, "summary") ?? payloadStr(event.payload, "name");
        if (summary) push(event, { kind: "tool", title: summary, detail: payloadStr(event.payload, "detail") ?? undefined });
        break;
      }
      case "file_change": {
        const path = payloadStr(event.payload, "path");
        if (!path) break;
        const changeKind = payloadStr(event.payload, "changeKind") ?? "edit";
        const added = payloadNum(event.payload, "added") ?? 0;
        const removed = payloadNum(event.payload, "removed") ?? 0;
        // `patch` is the documented key; `diff` is the one the deployed cloud
        // runner writes (scripts/cloud-code-runner.mjs). Both, or the hunks the
        // only producer that sends any would be thrown away here.
        const patch = payloadStr(event.payload, "patch") ?? payloadStr(event.payload, "diff");
        const keep = patch && patch.length <= MAX_PERSISTED_PATCH_CHARS && patch.length <= patchBudget ? patch : null;
        if (keep) patchBudget -= keep.length;
        push(event, {
          kind: "write",
          title: `${changeKind} ${path}`,
          detail: `+${added} −${removed}`,
          ...(keep ? { patch: keep } : {}),
        });
        break;
      }
      case "approval_request": {
        const summary = payloadStr(event.payload, "summary");
        if (summary) push(event, { kind: "warning", title: "Approval requested", detail: summary });
        break;
      }
      case "error": {
        errorMessage = payloadStr(event.payload, "message") ?? errorMessage;
        break;
      }
      case "done": {
        promptTokens = payloadNum(event.payload, "promptTokens") ?? promptTokens;
        completionTokens = payloadNum(event.payload, "completionTokens") ?? completionTokens;
        break;
      }
      case "rollback_result": {
        /*
         * The OUTCOME is transcript; the request is not.
         *
         * `accept_change`/`reject_change`/`undo_change` are asks that may never
         * have been acted on — a host can vanish between the ask and the answer
         * — so persisting them would leave a reloaded transcript claiming a file
         * was reverted on the strength of somebody having clicked. This row is
         * the host's own report, and it is the one thing here that a reader
         * coming back tomorrow can rely on. It sits beside the `write` rows it
         * contradicts, which is the whole point: a file listed as edited and
         * then listed as reverted has to read that way in history too.
         */
        const status = payloadStr(event.payload, "status");
        const paths = Array.isArray((event.payload as EventPayload | null)?.paths)
          ? ((event.payload as EventPayload).paths as unknown[]).filter(
              (entry): entry is string => typeof entry === "string",
            )
          : [];
        push(event, {
          kind: status === "applied" ? "done" : "warning",
          title:
            status === "applied"
              ? paths.length === 1
                ? `Rolled back ${paths[0]}`
                : `Rolled back ${paths.length} files`
              : status === "unsupported"
                ? "Nothing to roll back"
                : "Rollback failed",
          detail: payloadStr(event.payload, "message") ?? undefined,
        });
        break;
      }
      case "agent": {
        // Keep only each agent's LATEST snapshot; folded below after the loop.
        const agent = (event.payload as Record<string, unknown> | null)?.agent as
          | Record<string, unknown>
          | undefined;
        if (agent && typeof agent.id === "string") {
          agentSnapshots.set(agent.id, { event, agent });
        }
        break;
      }
      default:
        // status/user/approval_response/cancel_request carry no transcript
        // content, and neither do the rollback ASKS — see `rollback_result`
        // above for why only the host's answer is persisted.
        break;
    }
  }

  // One activity line per delegated agent (its final state) so the persisted
  // transcript records who did what.
  for (const { event, agent } of agentSnapshots.values()) {
    const role = typeof agent.role === "string" ? agent.role : "agent";
    const title = typeof agent.title === "string" ? agent.title : "";
    const status = typeof agent.status === "string" ? agent.status : "";
    const summary = typeof agent.summary === "string" ? agent.summary : undefined;
    push(event, {
      kind: "tool",
      title: `Agent ${role}${title ? ` · ${title}` : ""} — ${status}`,
      detail: summary ? summary.slice(0, 500) : undefined,
    });
  }

  if (task.status === "failed") {
    activity.push({
      id: "evt-outcome",
      kind: "warning",
      title: "Task failed",
      detail: errorMessage ?? undefined,
      createdAt: task.updatedAt.toISOString(),
    });
  } else if (task.status === "cancelled") {
    activity.push({ id: "evt-outcome", kind: "warning", title: "Stopped by user", createdAt: task.updatedAt.toISOString() });
  }

  const base = {
    content: encryptMessageText(textParts.join("")),
    model: null,
    promptTokens,
    completionTokens,
    activity: activity as unknown as Prisma.InputJsonValue,
  };
  await prisma.message.upsert({
    where: { id: codeTaskMessageId(task.id) },
    create: { id: codeTaskMessageId(task.id), conversationId: conversation.id, role: "ASSISTANT", ...base },
    update: base,
  });
  await prisma.conversation.updateMany({
    where: { id: conversation.id, userId: task.userId },
    data: { lastMessageAt: new Date() },
  });
}
