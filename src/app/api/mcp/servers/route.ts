import { NextResponse } from "next/server";
import { createMcpServerInput } from "@/lib/mcp-server-input";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import {
  encryptAuthHeader,
  serializeUserMcpServer,
  testUserMcpConnection,
  userMcpUrlProblem,
} from "@/lib/user-mcp";

export const runtime = "nodejs";

/** Soft ceiling so the directory stays bounded and the pickers stay readable. */
const MAX_USER_MCP_SERVERS = 50;

/**
 * List the account's user MCP servers.
 *
 * Deliberately a separate endpoint from `/api/connectors`: that list is the
 * directory of what MAY be linked (registry + Composio), this one is the rows
 * the account OWNS. Chat pickers still see these through `/api/connectors`,
 * which projects them as connected `user_mcp:*` entries.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rows = await prisma.userMcpServer.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ servers: rows.map(serializeUserMcpServer) });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `user-mcp:create:${user.id}`, limit: 30, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many servers added just now. Try again later." }, { status: 429 });
  }

  const parsed = createMcpServerInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }

  const name = parsed.data.name;
  const url = parsed.data.url;
  const urlProblem = userMcpUrlProblem(url);
  if (urlProblem) return NextResponse.json({ error: urlProblem }, { status: 400 });

  const count = await prisma.userMcpServer.count({ where: { userId: user.id } });
  if (count >= MAX_USER_MCP_SERVERS) {
    return NextResponse.json(
      { error: `You can keep up to ${MAX_USER_MCP_SERVERS} MCP servers. Remove one to add another.` },
      { status: 409 }
    );
  }

  const duplicate = await prisma.userMcpServer.findUnique({
    where: { userId_name: { userId: user.id, name } },
    select: { id: true },
  });
  if (duplicate) {
    return NextResponse.json({ error: "You already have an MCP server with that name." }, { status: 409 });
  }

  // Probe BEFORE insert when the dialog already tested: still probe here so a
  // direct API create cannot persist an unreachable endpoint marked ok. Failure
  // is not fatal (a server can come up later), but status starts honest.
  const probe = await testUserMcpConnection({ url, authHeader: parsed.data.authHeader ?? null });

  const row = await prisma.userMcpServer.create({
    data: {
      userId: user.id,
      name,
      url,
      authHeader: encryptAuthHeader(parsed.data.authHeader),
      enabled: true,
      status: probe.ok ? "ok" : "error",
      lastError: probe.ok ? null : probe.error,
      lastCheckedAt: new Date(),
      toolCount: probe.ok ? probe.toolCount : 0,
      tools: probe.ok ? probe.toolNames.slice(0, 200) : [],
      accountLabel: probe.ok ? probe.accountLabel : null,
    },
  });

  return NextResponse.json({ server: serializeUserMcpServer(row) }, { status: 201 });
}
