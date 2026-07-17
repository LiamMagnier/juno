import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { ONLINE_WINDOW_MS, requireUser, serializeDevice } from "@/lib/code-remote";

export const runtime = "nodejs";

const postSchema = z.object({
  deviceId: z.string().min(1).optional(),
  name: z.string().trim().min(1).max(200),
  // Hosts that can run local code sessions. Widened from the original
  // macOS-only literal when the Windows desktop client shipped.
  platform: z.enum(["macos", "windows"]),
  workspaces: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        path: z.string().trim().min(1).max(1000),
      }),
    )
    .max(100),
});

export async function GET() {
  const { user, error } = await requireUser();
  if (!user) return error;

  const devices = await prisma.codeDevice.findMany({
    where: { userId: user.id },
    orderBy: { lastSeenAt: "desc" },
  });
  const now = Date.now();
  return NextResponse.json({
    devices: devices.map((device) => serializeDevice(device, now - device.lastSeenAt.getTime() <= ONLINE_WINDOW_MS)),
  });
}

export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;

  const parsed = postSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { deviceId, name, platform, workspaces } = parsed.data;
  const now = new Date();

  const existing = deviceId
    ? await prisma.codeDevice.findFirst({ where: { id: deviceId, userId: user.id }, select: { id: true } })
    : null;

  const device = existing
    ? await prisma.codeDevice.update({
        where: { id: existing.id, userId: user.id },
        data: { name, platform, workspaces, lastSeenAt: now },
      })
    : await prisma.codeDevice.upsert({
        where: { userId_name: { userId: user.id, name } },
        update: { platform, workspaces, lastSeenAt: now },
        create: { userId: user.id, name, platform, workspaces },
      });

  return NextResponse.json({ device: serializeDevice(device) });
}
