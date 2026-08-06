import { NextResponse } from "next/server";
import type { Prisma, WorkCommand } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { recordWorkAudit } from "@/lib/work/audit";
import { serializeCommand } from "@/lib/work/serializers";
import {
  HOST_NOT_FOUND,
  HOST_POLL_INTERVAL_MS,
  WORK_RELAY_REFUSALS,
  commandExpiresAt,
  commandLeaseUntil,
  enqueueCommandSchema,
  negotiatedProtocolVersion,
  pollDeadline,
  refusalBody,
  refuseEnqueue,
  refuseHostPlane,
  shouldPollAgain,
  supportedCommandKinds,
  type WorkRelayRefusal,
} from "@/lib/work/relay";

export const runtime = "nodejs";
// Vercel-only directive (`next start` ignores it); the long poll below parks for
// twenty-five seconds and would otherwise be cut off at the platform default.
export const maxDuration = 60;

type RouteParams = { params: Promise<{ id: string }> };

/** Per-user ceiling on client→Mac instructions. Matches the Code relay's, for
 *  the reason that one gives: well above any human's tap rate, low enough that a
 *  runaway client cannot flood a Mac's command queue. Enqueues are idempotent,
 *  so a retried key never burns quota twice for the same logical command. */
const WORK_COMMAND_RATE_LIMIT = 120;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Refuses, and records the refusal, in that order in the code and the opposite
 * order on the wire.
 *
 * Awaited rather than fired and forgotten even though `recordWorkAudit` never
 * throws: the refusal and its record are one event, and returning first loses
 * the row whenever the process is torn down between the two — which on a
 * serverless platform is whenever the response completes.
 */
async function refuse(
  refusal: WorkRelayRefusal,
  audit: { userId: string; hostId: string; sessionId?: string | null; detail: Record<string, unknown> }
): Promise<NextResponse> {
  await recordWorkAudit({
    userId: audit.userId,
    kind: refusal.audit,
    severity: refusal.severity,
    hostId: audit.hostId,
    sessionId: audit.sessionId ?? null,
    detail: { ...audit.detail, reason: refusal.code },
  });
  return NextResponse.json(refusalBody(refusal), { status: refusal.status });
}

/**
 * The host's long poll: claim the next instruction for this Mac.
 *
 * Three things make this different from a plain "give me a row".
 *
 * The claim is a conditional `updateMany` rather than a read followed by a
 * write. Two app processes on the same Mac — or the same process reconnecting
 * before its old request has finished — would otherwise both read the same
 * pending row and both execute it, and "move 400 files" is not an instruction
 * anybody wants carried out twice.
 *
 * Revocation is re-read on every pass, not once at connect. This request is
 * parked for most of its life, so a revocation almost always lands *during* it;
 * a host that only checked at the start would keep serving for the rest of the
 * poll and then reconnect and serve again.
 *
 * And the refusal a revoked host gets is non-retryable, which is what makes it
 * stop. `WorkRemoteHost.run` backs off and reconnects on anything retryable, so
 * a revocation delivered as a generic error is a decommissioned Mac polling a
 * relay that has already told it to go away.
 */
export async function GET(req: Request, { params }: RouteParams) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  // The generation the polling binary says it is running. Optional: a host that
  // does not send one is taken at its registered word.
  const declared = Number(new URL(req.url).searchParams.get("protocolVersion"));
  const deadline = pollDeadline(new Date());
  let swept = false;

  for (;;) {
    const host = await prisma.workHost.findFirst({
      where: { id, userId: user.id },
      select: { id: true, enabled: true, revokedAt: true, protocolVersion: true },
    });
    // A host id from another account is a 404, never a 403. The two answers are
    // deliberately identical: telling a caller that a host exists but is not
    // theirs is the one fact worth having.
    if (!host) return NextResponse.json(HOST_NOT_FOUND, { status: 404 });

    const gate = refuseHostPlane(host);
    if (gate) {
      return await refuse(gate, { userId: user.id, hostId: host.id, detail: { hostId: host.id } });
    }

    const now = new Date();
    const protocolVersion = negotiatedProtocolVersion(host.protocolVersion, declared);

    // Settle anything past its TTL. Not needed for correctness — the candidate
    // query excludes expired rows anyway — but a command that stays `pending`
    // forever is one the phone that issued it renders as still on its way, when
    // in fact nothing will ever collect it.
    //
    // Once per poll rather than once per pass. A row that expires mid-poll is
    // already excluded from the candidate query and is swept by the next poll,
    // so repeating this write twenty times per request buys nothing and costs a
    // table write per idle host per second across the fleet.
    if (!swept) {
      swept = true;
      await prisma.workCommand.updateMany({
        where: {
          userId: user.id,
          hostId: host.id,
          status: { in: ["pending", "claimed"] },
          expiresAt: { lte: now },
        },
        data: { status: "expired", completedAt: now, leaseExpiresAt: null },
      });
    }

    const claimable: Prisma.WorkCommandWhereInput = {
      userId: user.id,
      hostId: host.id,
      // Filtered in the database rather than skipped in application code: a
      // command this build cannot parse must never be leased at all, because a
      // lease taken and then abandoned hands the host nothing once per poll for
      // as long as the command lives.
      kind: { in: supportedCommandKinds(protocolVersion) },
      expiresAt: { gt: now },
      OR: [
        { status: "pending" },
        // A host that crashed holding a command has not done the work. Once its
        // lease lapses the command is free again, which is the difference
        // between a lease and a claim flag.
        { status: "claimed", leaseExpiresAt: { lte: now } },
      ],
    };

    const candidate = await prisma.workCommand.findFirst({
      where: claimable,
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });

    if (candidate) {
      // The same predicate again, as the WHERE of the write. Postgres
      // re-evaluates it against the committed row, so exactly one caller sees a
      // count of 1 however many are racing.
      const claimed = await prisma.workCommand.updateMany({
        where: { ...claimable, id: candidate.id },
        data: {
          status: "claimed",
          claimedAt: now,
          leaseExpiresAt: commandLeaseUntil(now),
          attempts: { increment: 1 },
        },
      });
      if (claimed.count) {
        const command = await prisma.workCommand.findFirst({
          where: { id: candidate.id, userId: user.id },
        });
        if (command) {
          await recordWorkAudit({
            userId: user.id,
            kind: "command_claimed",
            severity: "info",
            actor: "macos",
            hostId: host.id,
            sessionId: command.sessionId,
            runId: command.runId,
            detail: {
              hostId: host.id,
              commandId: command.id,
              commandKind: command.kind,
              attempts: command.attempts,
              protocolVersion,
            },
          });
          return NextResponse.json({ command: serializeCommand(command) });
        }
      }
      // Lost the race, or the row settled underneath us. Falling through to the
      // deadline check rather than retrying immediately: a `continue` here
      // spins against a queue whose head keeps being taken, and one extra
      // interval of latency in a rare race is cheaper than a busy loop.
    }

    if (!shouldPollAgain(deadline, new Date())) {
      // Idle, not broken. `WorkRemoteHost` treats a nil command as the normal
      // outcome and polls again without backing off.
      return NextResponse.json({ command: null, protocolVersion });
    }
    await sleep(HOST_POLL_INTERVAL_MS);
  }
}

/**
 * A client queues one instruction for a Mac.
 *
 * Idempotent on `(userId, idempotencyKey)`, which is the whole point of the
 * unique index behind it: a phone retrying a "stop" over a flaky connection
 * issues one stop, not five, and the fifth arriving after the run restarted
 * would stop the wrong thing.
 */
export async function POST(req: Request, { params }: RouteParams) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const limited = await rateLimit({
    key: `work-host-cmd:${user.id}`,
    limit: WORK_COMMAND_RATE_LIMIT,
    windowSec: 60,
  });
  if (!limited.success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
  }

  const { id } = await params;
  const parsed = enqueueCommandSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const body = parsed.data;

  const host = await prisma.workHost.findFirst({
    where: { id, userId: user.id },
    select: { id: true, enabled: true, revokedAt: true, protocolVersion: true },
  });
  if (!host) return NextResponse.json(HOST_NOT_FOUND, { status: 404 });

  // The session and the run are re-checked against the account rather than
  // trusted from the body. Without this a caller could address a command at
  // their own Mac naming somebody else's session, and the host would execute it
  // against a session the relay had just confirmed by id.
  const session = await prisma.workSession.findFirst({
    where: { id: body.sessionId, userId: user.id, deletedAt: null },
    select: { id: true },
  });
  if (!session) return NextResponse.json(HOST_NOT_FOUND, { status: 404 });

  if (body.runId) {
    const run = await prisma.workRun.findFirst({
      where: { id: body.runId, userId: user.id, sessionId: session.id },
      select: { id: true },
    });
    if (!run) return NextResponse.json(HOST_NOT_FOUND, { status: 404 });
  }

  // The registered generation, not a negotiated one: the caller here is a phone
  // or a browser, and what it thinks the Mac can parse is not evidence.
  const refusal = refuseEnqueue(host, body.kind, host.protocolVersion);
  if (refusal) {
    return await refuse(refusal, {
      userId: user.id,
      hostId: host.id,
      sessionId: session.id,
      detail: {
        hostId: host.id,
        commandKind: body.kind,
        protocolVersion: host.protocolVersion,
        idempotencyKey: body.idempotencyKey,
      },
    });
  }

  const now = new Date();
  // `update: {}` is what makes the retry a lookup. A body that differed from the
  // first one under the same key is deliberately ignored rather than applied:
  // the key names one logical instruction, and rewriting a command a host may
  // already have claimed would change what it is executing mid-flight.
  const command: WorkCommand = await prisma.workCommand.upsert({
    where: { userId_idempotencyKey: { userId: user.id, idempotencyKey: body.idempotencyKey } },
    create: {
      userId: user.id,
      hostId: host.id,
      sessionId: session.id,
      runId: body.runId ?? null,
      kind: body.kind,
      payload: body.payload as Prisma.InputJsonObject,
      payloadVersion: body.payloadVersion,
      idempotencyKey: body.idempotencyKey,
      expiresAt: commandExpiresAt(now),
    },
    update: {},
  });

  // A retry arriving after the original expired is not the same request coming
  // back — it is a new intention wearing an old key, and answering 202 would
  // have the client wait for a command nothing will collect. The client mints a
  // fresh key if it still wants this.
  if (command.status === "pending" && command.expiresAt.getTime() <= now.getTime()) {
    return await refuse(WORK_RELAY_REFUSALS.commandExpired, {
      userId: user.id,
      hostId: host.id,
      sessionId: session.id,
      detail: {
        hostId: host.id,
        commandId: command.id,
        commandKind: command.kind,
        idempotencyKey: command.idempotencyKey,
      },
    });
  }

  return NextResponse.json(
    { command: serializeCommand(command) },
    { status: command.status === "pending" ? 202 : 200 }
  );
}
