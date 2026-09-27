import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import {
  decryptAuthHeader,
  recordUserMcpTest,
  serializeUserMcpServer,
  testUserMcpConnection,
} from "@/lib/user-mcp";

export const runtime = "nodejs";

/**
 * Test a SAVED user MCP server and record status / lastError / tool snapshot.
 *
 * The probe itself is `probeMcpEndpoint` (src/lib/mcp-probe.ts), the same
 * function a native-connector Test button should call later with that
 * connector's mcpUrl and headers. This route only owns auth, ownership, and
 * writing the outcome onto the row. Draft tests (before a row exists) live at
 * POST /api/mcp/servers/test.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `user-mcp:test:${user.id}`, limit: 60, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many connection tests just now. Try again later." }, { status: 429 });
  }

  const { id } = await params;
  const row = await prisma.userMcpServer.findFirst({ where: { id, userId: user.id } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const result = await testUserMcpConnection({
    url: row.url,
    authHeader: decryptAuthHeader(row.authHeader),
  });
  await recordUserMcpTest(user.id, row.id, result);

  const updated = await prisma.userMcpServer.findFirst({ where: { id, userId: user.id } });
  return NextResponse.json({
    result,
    server: updated ? serializeUserMcpServer(updated) : null,
  });
}
