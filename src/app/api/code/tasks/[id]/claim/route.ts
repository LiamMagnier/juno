import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { appendTaskEvents, requireTaskAuth, serializeTask } from "@/lib/code-remote";

export const runtime = "nodejs";

// deviceId is required for device claims (the host proves which device it is);
// the cloud runner claims via its task token and has no device.
const schema = z.object({ deviceId: z.string().min(1).max(200).optional() });

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, viaTaskToken, error } = await requireTaskAuth(id, req);
  if (!user) return error;

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  // Session/native (device) callers must still name their device; the cloud
  // runner (task token, no device) claims the exact task its token authorizes.
  if (!viaTaskToken && !parsed.data.deviceId) {
    return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  }

  const claimed = await prisma.codeTask.updateMany({
    where: {
      id,
      userId: user.id,
      status: "queued",
      ...(viaTaskToken ? {} : { deviceId: parsed.data.deviceId }),
    },
    data: { status: "running" },
  });
  if (claimed.count === 0) {
    const exists = await prisma.codeTask.findFirst({ where: { id, userId: user.id }, select: { id: true } });
    if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ error: "not_queued" }, { status: 409 });
  }

  const { task } = await appendTaskEvents(id, [{ kind: "status", payload: { status: "running" } }]);
  return NextResponse.json({ task: serializeTask(task) });
}
