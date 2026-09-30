import { NextResponse } from "next/server";
import { prismaUnguarded } from "@/lib/prisma";
import { env } from "@/lib/env";
import { getCurrentUser, type SessionUser } from "@/lib/session";
import { readTaskToken, verifyTaskToken } from "@/lib/cloud-code-token";
import { verifyGithubActionsOidc } from "@/lib/github-oidc";

export {
  appendTaskEvents,
  countChangedFiles,
  readPendingControls,
  type TaskEventInput,
} from "@/lib/code-task-events";

// The task wire lives in its own dependency-free module so scripts and tests
// can import it without next-auth; see the header of code-task-wire.ts.
export {
  serializeDevice,
  serializeTask,
  serializeTaskEvent,
  type SerializeTaskOptions,
} from "@/lib/code-task-wire";

export const ONLINE_WINDOW_MS = 120_000;

export const TASK_STATUSES = ["queued", "running", "awaiting_approval", "done", "failed", "cancelled"] as const;

// Worker-safe: the transcript fold lives where a PM2 worker can import it
// without dragging in session.ts → next-auth → next/navigation. See the
// header of code-task-outcome.ts.
export {
  TERMINAL_TASK_STATUSES,
  codeTaskMessageId,
  isTerminalTaskStatus,
  persistCodeTaskOutcome,
} from "@/lib/code-task-outcome";

export const EVENT_KINDS = [
  "status",
  "user",
  "text",
  "reasoning",
  "reasoning_delta",
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
  /*
   * MID-RUN STEERING. `steer` ({ requestId, text }) is the web → host control
   * (see CONTROL_KINDS in code-task-events.ts); `steer_ack` ({ requestId }) is
   * the host saying it took the text as its next user message. The web shows
   * an instruction as "delivered" ONLY on the ack — the control channel is
   * fire-and-forget, so an appended `steer` is a request, never an outcome.
   */
  "steer",
  "steer_ack",
  /*
   * THE CANONICAL AGENT PROTOCOL. `protocol` rows carry one event of
   * contracts/agent/juno-agent-protocol-v1.json each, as the payload. A host
   * posts them only when the task it was handed says this server stores them
   * (`agentProtocol` on serializeTask and in runner-context), and posts the
   * legacy kinds beside them — marked `protocolEventId` — so readers that
   * predate the protocol keep rendering. Readers of the protocol fold the
   * `protocol` rows and skip the marked ones (src/lib/agent-protocol).
   */
  "protocol",
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
