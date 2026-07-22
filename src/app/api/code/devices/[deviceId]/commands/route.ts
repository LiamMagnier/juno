import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { serializeSessionCommand } from "@/lib/code-remote-sessions";

export const runtime = "nodejs";

const ackSchema = z.object({
  commandId: z.string().min(1).max(200),
  status: z.enum(["completed", "failed"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().max(10_000).optional(),
});

async function ownedDevice(deviceId: string, userId: string) {
  return prisma.codeDevice.findFirst({ where: { id: deviceId, userId }, select: { id: true } });
}

/// Host long-poll/claim. updateMany is the claim CAS so two app processes can
/// never execute the same remote command.
export async function GET(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { deviceId } = await params;
  if (!(await ownedDevice(deviceId, user.id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const deadline = Date.now() + 25_000;
  for (;;) {
    const candidate = await prisma.codeSessionCommand.findFirst({
      where: { userId: user.id, deviceId, status: "pending" },
      orderBy: { createdAt: "asc" },
    });
    if (candidate) {
      const claimed = await prisma.codeSessionCommand.updateMany({
        where: { id: candidate.id, userId: user.id, deviceId, status: "pending" },
        data: { status: "claimed", claimedAt: new Date() },
      });
      if (claimed.count) {
        const command = await prisma.codeSessionCommand.findUniqueOrThrow({ where: { id: candidate.id } });
        return NextResponse.json({ command: serializeSessionCommand(command) });
      }
    }
    if (Date.now() + 1_250 >= deadline) return NextResponse.json({ command: null });
    await new Promise((resolve) => setTimeout(resolve, 1_250));
  }
}

export async function POST(req: Request, { params }: { params: Promise<{ deviceId: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { deviceId } = await params;
  if (!(await ownedDevice(deviceId, user.id))) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const parsed = ackSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const updated = await prisma.codeSessionCommand.updateMany({
    where: { id: parsed.data.commandId, userId: user.id, deviceId, status: "claimed" },
    data: {
      status: parsed.data.status,
      result: parsed.data.result as Prisma.InputJsonValue | undefined,
      error: parsed.data.error,
      completedAt: new Date(),
    },
  });
  if (!updated.count) {
    const existing = await prisma.codeSessionCommand.findFirst({ where: { id: parsed.data.commandId, userId: user.id, deviceId } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // A completed ack replay is safe; a different transition is not.
    if (existing.status === parsed.data.status) return NextResponse.json({ ok: true, replay: true });
    return NextResponse.json({ error: "command_conflict" }, { status: 409 });
  }
  return NextResponse.json({ ok: true });
}
