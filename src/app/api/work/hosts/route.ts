import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { serializeHost } from "@/lib/work/serializers";
import { effectiveHostState } from "@/app/api/work/protocol";

export const runtime = "nodejs";

export async function GET() {
  const { user, error } = await requireUser();
  if (!user) return error;

  // Revoked hosts are included. A Mac the user switched off for Work is still
  // one of their Macs, and a settings screen that simply stops listing it
  // cannot show that it was revoked, when, or offer to switch it back on.
  const hosts = await prisma.workHost.findMany({
    where: { userId: user.id },
    orderBy: { lastSeenAt: "desc" },
  });

  const now = new Date();
  return NextResponse.json({
    hosts: hosts.map((host) =>
      // The stored state is overridden by the heartbeat when the heartbeat has
      // lapsed — the same narrowing the run dispatcher applies — so the list a
      // user picks a host from cannot show `online` for a Mac that was closed
      // an hour ago and left that column behind.
      serializeHost({ ...host, state: effectiveHostState(host, now) })
    ),
  });
}
