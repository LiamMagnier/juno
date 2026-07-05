import { NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { appendTaskEvents, EVENT_KINDS, requireUser, TASK_STATUSES } from "@/lib/code-remote";

export const runtime = "nodejs";

const MAX_BODY_BYTES = 256 * 1024;

const schema = z.object({
  events: z
    .array(
      z.object({
        kind: z.enum(EVENT_KINDS),
        payload: z.record(z.string(), z.unknown()),
      }),
    )
    .max(500),
  status: z.enum(TASK_STATUSES).optional(),
  afterControlSeq: z.number().int().min(0).optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id } = await params;
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }

  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const task = await prisma.codeTask.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!task) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { lastSeq, control } = await appendTaskEvents(
    task.id,
    parsed.data.events.map((event) => ({
      kind: event.kind,
      payload: event.payload as Prisma.InputJsonValue,
    })),
    { status: parsed.data.status, afterControlSeq: parsed.data.afterControlSeq ?? 0 },
  );
  return NextResponse.json({ lastSeq, control });
}
