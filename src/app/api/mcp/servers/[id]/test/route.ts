import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { testSavedMcpServerInput } from "@/lib/mcp-server-input";
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
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `user-mcp:test:${user.id}`, limit: 60, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many connection tests just now. Try again later." }, { status: 429 });
  }

  const { id } = await params;
  const row = await prisma.userMcpServer.findFirst({ where: { id, userId: user.id } });
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const raw = await req.text();
  let body: unknown = {};
  try { if (raw) body = JSON.parse(raw); } catch { body = null; }
  const parsed = testSavedMcpServerInput.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid input" }, { status: 400 });
  }
  const draft = parsed.data;

  const result = await testUserMcpConnection({
    url: draft.url ?? row.url,
    authHeader: draft.authHeader === undefined ? decryptAuthHeader(row.authHeader) : draft.authHeader,
  });
  // Testing unsaved edits must not mark the saved definition healthy or broken.
  if (draft.url !== undefined || draft.authHeader !== undefined) {
    return NextResponse.json({ result });
  }
  await recordUserMcpTest(user.id, row.id, result);

  const updated = await prisma.userMcpServer.findFirst({ where: { id, userId: user.id } });
  return NextResponse.json({
    result,
    server: updated ? serializeUserMcpServer(updated) : null,
  });
}
