import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";

export type SessionRouteParams = Promise<{ deviceId: string; sessionId: string }>;

/** Per-user ceiling on phone→Mac control commands. Well above any human's tap
 *  rate, low enough that a runaway client can't flood the relay or a device's
 *  command queue. Enqueues are idempotent, so a retried key never burns quota
 *  twice for the same logical command (the upsert path below runs regardless). */
export const SESSION_COMMAND_RATE_LIMIT = 120;

/** Shared rate-limit gate for every control command (message/stop/approval/
 *  patch/delete). Returns a 429 response to short-circuit, or null to proceed. */
export async function sessionCommandRateLimit(userId: string): Promise<NextResponse | null> {
  const rl = await rateLimit({ key: `code-session-cmd:${userId}`, limit: SESSION_COMMAND_RATE_LIMIT, windowSec: 60 });
  if (!rl.success) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": "60" } });
  }
  return null;
}

export async function enqueueSessionCommand(
  req: Request,
  params: SessionRouteParams,
  kind: string,
  validate: (body: unknown) => { success: boolean; data?: Record<string, unknown> },
) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const limited = await sessionCommandRateLimit(user.id);
  if (limited) return limited;
  const { deviceId, sessionId } = await params;
  const session = await prisma.codeRemoteSession.findFirst({
    where: { userId: user.id, deviceId, sessionId, deletedAt: null },
  });
  if (!session) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  const parsed = validate(await req.json().catch(() => null));
  if (!parsed.success || !parsed.data) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const idempotencyKey = parsed.data.idempotencyKey;
  if (typeof idempotencyKey !== "string") return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { idempotencyKey: _, ...payload } = parsed.data;
  const command = await prisma.codeSessionCommand.upsert({
    where: { userId_idempotencyKey: { userId: user.id, idempotencyKey } },
    create: {
      userId: user.id,
      deviceId,
      remoteSessionId: session.id,
      sessionId,
      kind,
      payload: payload as Prisma.InputJsonValue,
      idempotencyKey,
    },
    update: {},
  });
  return NextResponse.json({ commandId: command.id, status: command.status, result: command.result, error: command.error }, { status: command.status === "pending" ? 202 : 200 });
}
