import { getCurrentUser } from "@/lib/session";
import { taskTokenAuth, isTerminalTaskStatus } from "@/lib/code-remote";
import { prisma } from "@/lib/prisma";
import { rateLimit } from "@/lib/rate-limit";
import { sessionMcpRpc } from "@/lib/session-mcp";

export const runtime = "nodejs";

export async function POST(req: Request) {
  // A supplied cloud token is authoritative: never fall back to a cookie for
  // an invalid bearer. Native bearer validation is owned by getCurrentUser.
  const cloudBearer = /^Bearer cct_/i.test(req.headers.get("authorization") ?? "");
  const task = cloudBearer ? await taskTokenAuth(req) : null;
  const user = cloudBearer ? task?.user : await getCurrentUser();
  if (!user) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (task) {
    const live = await prisma.codeTask.findFirst({ where: { id: task.taskId, userId: user.id, target: "cloud", status: { in: ["queued", "running"] } }, select: { id: true } });
    const account = await prisma.user.findFirst({ where: { id: user.id, bannedAt: null }, select: { id: true } });
    if (!live || !account || isTerminalTaskStatus(task.status)) return Response.json({ error: "Task is not active" }, { status: 403 });
  }
  const localId = req.headers.get("x-alevr-mcp-session") ?? "";
  if (!task && !/^[a-zA-Z0-9:_-]{1,128}$/.test(localId)) return Response.json({ error: "A session id is required" }, { status: 400 });
  const limit = await rateLimit({ key: `session-mcp:${user.id}`, limit: 180, windowSec: 60 });
  if (!limit.success) return Response.json({ error: "Too many requests" }, { status: 429 });
  try {
    return await sessionMcpRpc(req, { userId: user.id, sessionId: task ? `cloud:${task.taskId}` : `code:${localId}`, surface: "code", unattended: !!task });
  } catch {
    // Provider errors can contain Authorization values or private URLs.
    return Response.json({ error: "Connections are unavailable" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
