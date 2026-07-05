import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser, serializeTask } from "@/lib/code-remote";

export const runtime = "nodejs";
export const maxDuration = 30;

const POLL_WINDOW_MS = 25_000;
const POLL_INTERVAL_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function GET(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const deviceId = new URL(req.url).searchParams.get("deviceId");
  if (!deviceId) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const device = await prisma.codeDevice.findFirst({
    where: { id: deviceId, userId: user.id },
    select: { id: true },
  });
  if (!device) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const deadline = Date.now() + POLL_WINDOW_MS;
  for (;;) {
    const task = await prisma.codeTask.findFirst({
      where: { userId: user.id, deviceId, status: "queued" },
      orderBy: { createdAt: "asc" },
    });
    if (task) return NextResponse.json({ task: serializeTask(task) });
    if (Date.now() + POLL_INTERVAL_MS >= deadline) return NextResponse.json({ task: null });
    await sleep(POLL_INTERVAL_MS);
  }
}
