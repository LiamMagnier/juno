import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import {
  decryptAuthHeader,
  encryptAuthHeader,
  serializeUserMcpServer,
  testUserMcpConnection,
  userMcpUrlProblem,
} from "@/lib/user-mcp";

export const runtime = "nodejs";

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    url: z.string().trim().min(1).max(2000).optional(),
    // null clears the header; a string replaces it; omitted leaves it alone.
    authHeader: z.string().max(4000).nullable().optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nothing to update" });

/** PATCH: rename, re-point, swap the auth header, or enable/disable. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.userMcpServer.findFirst({ where: { id, userId: user.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const data = parsed.data;

  const urlProblem = data.url !== undefined ? userMcpUrlProblem(data.url) : null;
  if (urlProblem) return NextResponse.json({ error: urlProblem }, { status: 400 });

  if (data.name !== undefined && data.name !== existing.name) {
    const duplicate = await prisma.userMcpServer.findUnique({
      where: { userId_name: { userId: user.id, name: data.name } },
      select: { id: true },
    });
    if (duplicate && duplicate.id !== id) {
      return NextResponse.json({ error: "You already have an MCP server with that name." }, { status: 409 });
    }
  }

  // If URL or header changed, re-probe so status/lastError follow the new
  // definition rather than the old one. A pure enable toggle must not open a
  // network connection (flipping a switch offline would look like a failure).
  const identityChanged = data.url !== undefined || data.authHeader !== undefined;
  if (identityChanged) {
    // That re-probe dials the URL, so it spends the Test button's budget.
    // Unmetered, PATCH was a way around /test's limit: re-point, read
    // status/lastError, repeat.
    const limit = await rateLimit({ key: `user-mcp:test:${user.id}`, limit: 60, windowSec: 3600 });
    if (!limit.success) {
      return NextResponse.json({ error: "Too many connection tests just now. Try again later." }, { status: 429 });
    }
  }
  const nextUrl = data.url ?? existing.url;
  const nextAuthHeader =
    data.authHeader === undefined ? existing.authHeader : data.authHeader === null ? null : encryptAuthHeader(data.authHeader);

  let probe: Awaited<ReturnType<typeof testUserMcpConnection>> | null = null;
  let plainHeader: string | null;
  if (identityChanged) {
    plainHeader =
      data.authHeader !== undefined ? (data.authHeader ?? null) : decryptAuthHeader(existing.authHeader);
    probe = await testUserMcpConnection({ url: nextUrl, authHeader: plainHeader });
  }

  const row = await prisma.userMcpServer.update({
    where: { id, userId: user.id },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.url !== undefined ? { url: data.url } : {}),
      ...(data.enabled !== undefined ? { enabled: data.enabled } : {}),
      ...(identityChanged
        ? {
            authHeader: nextAuthHeader,
            status: probe && probe.ok ? "ok" : probe ? "error" : existing.status,
            lastError: probe ? (probe.ok ? null : probe.error) : existing.lastError,
            lastCheckedAt: probe ? new Date() : existing.lastCheckedAt,
            toolCount: probe && probe.ok ? probe.toolCount : existing.toolCount,
            tools: probe && probe.ok ? probe.toolNames.slice(0, 200) : existing.tools,
            accountLabel: probe && probe.ok ? probe.accountLabel : existing.accountLabel,
          }
        : {}),
    },
  });

  return NextResponse.json({ server: serializeUserMcpServer(row) });
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const existing = await prisma.userMcpServer.findFirst({ where: { id, userId: user.id }, select: { id: true } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.userMcpServer.delete({ where: { id, userId: user.id } });
  return NextResponse.json({ ok: true });
}
