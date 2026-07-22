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
  appVersion: z.string().trim().max(100).optional(),
  protocolVersion: z.number().int().min(1).max(100).optional(),
  sessionCount: z.number().int().min(0).optional(),
  activeCount: z.number().int().min(0).optional(),
  workspaces: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(200),
        path: z.string().trim().min(1).max(1000),
        // Stable workspace identity (CodeWorkspace.key) when the host knows
        // it. Optional and passed through as-is — key-less clients keep the
        // path-based contract unchanged.
        key: z.string().trim().min(1).max(200).optional(),
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

  const { deviceId, name, platform, workspaces, appVersion, protocolVersion, sessionCount, activeCount } = parsed.data;
  const now = new Date();
  const capabilities = {
    platform,
    workspaces,
    appVersion: appVersion ?? "",
    protocolVersion: protocolVersion ?? 1,
    sessionCount: sessionCount ?? 0,
    activeCount: activeCount ?? 0,
    lastSeenAt: now,
  };

  const existing = deviceId
    ? await prisma.codeDevice.findFirst({ where: { id: deviceId, userId: user.id }, select: { id: true } })
    : null;

  const device = existing
    ? await prisma.codeDevice.update({
        where: { id: existing.id, userId: user.id },
        data: { name, ...capabilities },
      })
    : await prisma.codeDevice.upsert({
        where: { userId_name: { userId: user.id, name } },
        update: capabilities,
        create: { userId: user.id, name, ...capabilities },
      });

  return NextResponse.json({ device: serializeDevice(device) });
}
