import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { authenticateNativeBearer } from "@/lib/native-auth";
import { deviceIsOnline } from "@/lib/code-remote-sessions";
import { canonicalSessionCommand } from "@/lib/code-session-command-compat";
import { requireRemotePair } from "@/lib/code-v2/device-pairing-guard";
import { recordWorkAudit } from "@/lib/work/audit";
import {
  LIVE_WORK_RUN_STATUSES,
  projectCodeRun,
  projectWorkRun,
  sortLiveRuns,
  type LiveRun,
} from "@/lib/runs/live-runs";
import type { ControlResult, RemoteActor, RunControlDeps } from "@/lib/runs/remote-control";
import { POST as workRunControl } from "@/app/api/work/runs/[id]/control/route";
import { POST as workApprovalDecision } from "@/app/api/work/approvals/[id]/decision/route";

/** How many runs of each kind a snapshot carries. A person supervises a handful. */
const MAX_RUNS_PER_KIND = 20;
/** Journal events read per Code session to find the turn's steps and questions. */
const CODE_JOURNAL_TAIL = 200;

/**
 * Which client is asking, in the audit vocabulary. A bearer is a native app's
 * (`requireUser` already accepted it); its sign-in names the platform. Anything
 * unreadable is recorded as the web's rather than as a device it did not come
 * from — the same rule as the Work decision route.
 */
export async function remoteActorFor(req: Request): Promise<RemoteActor> {
  const authorization = req.headers.get("authorization");
  if (!authorization) return "web";
  try {
    const { platform } = (await authenticateNativeBearer(authorization)).deviceSession;
    if (/mac|darwin/i.test(platform)) return "macos";
    if (/ios|ipad|iphone/i.test(platform)) return "ios";
    return "web";
  } catch {
    return "web";
  }
}

async function asResult(response: Response): Promise<ControlResult> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, body: body && typeof body === "object" ? body : {} };
}

/**
 * Forwards to another route handler inside this request, carrying the caller's
 * headers: the handler re-authenticates from the same request context and
 * reads the bearer for its own actor attribution.
 */
function forwarded(req: Request, path: string, body: unknown): Request {
  const headers = new Headers(req.headers);
  headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Request(new URL(path, req.url), { method: "POST", headers, body: JSON.stringify(body) });
}

export function prismaRunControlDeps(req: Request): RunControlDeps {
  return {
    async findCodeSession(userId, deviceId, sessionId) {
      return prisma.codeRemoteSession.findFirst({
        where: { userId, deviceId, sessionId, deletedAt: null },
        select: {
          id: true,
          isRunning: true,
          isAwaitingApproval: true,
          currentStatus: true,
          permissionMode: true,
          lastEventSequence: true,
        },
      });
    },
    async codeEventsTail(userId, remoteSessionId, take) {
      return prisma.codeRemoteSessionEvent.findMany({
        where: { userId, remoteSessionId },
        orderBy: { seq: "desc" },
        take,
        select: { seq: true, kind: true, payload: true, createdAt: true },
      });
    },
    async requireCodePair(userId, deviceId) {
      const refusal = await requireRemotePair(req, userId, deviceId);
      return refusal ? asResult(refusal) : null;
    },
    async enqueueCodeCommand(input) {
      const canonical = canonicalSessionCommand(input.kind, input.payload);
      const existing = await prisma.codeSessionCommand.findUnique({
        where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } },
      });
      const command = existing ?? await prisma.codeSessionCommand.upsert({
        where: { userId_idempotencyKey: { userId: input.userId, idempotencyKey: input.idempotencyKey } },
        create: {
          userId: input.userId,
          deviceId: input.deviceId,
          remoteSessionId: input.remoteSessionId,
          sessionId: input.sessionId,
          kind: canonical.kind,
          payload: canonical.payload as Prisma.InputJsonValue,
          idempotencyKey: input.idempotencyKey,
        },
        update: {},
      });
      const payload = command.payload && typeof command.payload === "object" && !Array.isArray(command.payload)
        ? (command.payload as Record<string, unknown>)
        : {};
      return { commandId: command.id, status: command.status, created: !existing, payload };
    },
    async findWorkRun(userId, runId) {
      return prisma.workRun.findFirst({
        where: { id: runId, userId },
        select: { id: true, sessionId: true, status: true, hostId: true },
      });
    },
    async cancelWorkRun(runId) {
      const response = await workRunControl(forwarded(req, `/api/work/runs/${encodeURIComponent(runId)}/control`, { action: "cancel" }), {
        params: Promise.resolve({ id: runId }),
      });
      return asResult(response);
    },
    async findWorkApproval(userId, approvalId) {
      return prisma.workApproval.findFirst({ where: { id: approvalId, userId }, select: { id: true, runId: true } });
    },
    async decideWorkApproval(approvalId, body) {
      const response = await workApprovalDecision(
        forwarded(req, `/api/work/approvals/${encodeURIComponent(approvalId)}/decision`, body),
        { params: Promise.resolve({ id: approvalId }) }
      );
      return asResult(response);
    },
    async audit(input) {
      await recordWorkAudit(input);
    },
  };
}

/** Every live run this account has, needs-you first. */
export async function loadLiveRuns(userId: string, now = new Date()): Promise<LiveRun[]> {
  const [codeSessions, workRuns] = await Promise.all([
    prisma.codeRemoteSession.findMany({
      where: {
        userId,
        deletedAt: null,
        archived: false,
        OR: [{ isRunning: true }, { isAwaitingApproval: true }, { currentStatus: "queued" }],
      },
      orderBy: { sessionUpdatedAt: "desc" },
      take: MAX_RUNS_PER_KIND,
      include: { device: { select: { name: true, lastSeenAt: true } } },
    }),
    prisma.workRun.findMany({
      where: { userId, status: { in: LIVE_WORK_RUN_STATUSES }, session: { deletedAt: null } },
      orderBy: { updatedAt: "desc" },
      take: MAX_RUNS_PER_KIND,
      include: {
        session: { select: { title: true } },
        host: { select: { displayName: true, lastSeenAt: true } },
        approvals: {
          where: { decision: "pending", expiresAt: { gt: now } },
          select: { id: true, summary: true, risk: true, actionDigest: true, decision: true, createdAt: true, expiresAt: true },
        },
      },
    }),
  ]);

  const code = await Promise.all(codeSessions.map(async (session) => {
    const events = await prisma.codeRemoteSessionEvent.findMany({
      where: { userId, remoteSessionId: session.id },
      orderBy: { seq: "desc" },
      take: CODE_JOURNAL_TAIL,
      select: { seq: true, kind: true, payload: true, createdAt: true },
    });
    return projectCodeRun({
      session,
      hostName: session.device.name,
      hostOnline: deviceIsOnline(session.device.lastSeenAt, now.getTime()),
      events,
    });
  }));

  const work = await Promise.all(workRuns.map(async (run) => {
    const [steps, latestTool] = await Promise.all([
      prisma.workEvent.count({ where: { userId, runId: run.id, kind: "tool_started" } }),
      prisma.workEvent.findFirst({
        where: { userId, runId: run.id, kind: "tool_started" },
        orderBy: { seq: "desc" },
        select: { payload: true },
      }),
    ]);
    return projectWorkRun({
      run: { ...run, sessionTitle: run.session.title },
      hostName: run.host?.displayName ?? null,
      hostOnline: run.host ? deviceIsOnline(run.host.lastSeenAt, now.getTime()) : false,
      steps,
      latestTool,
      approvals: run.approvals,
      now,
    });
  }));

  return sortLiveRuns([...code, ...work]);
}
