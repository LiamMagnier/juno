import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { appendTaskEvents } from "@/lib/code-remote";
import { deleteConversationsKeepingArtifacts } from "@/lib/artifact-follow";
import { removeOwnedCodeProject } from "@/lib/code-project-removal";

export const runtime = "nodejs";
const schema = z.object({ id: z.string().min(1).max(200).optional(), key: z.string().min(1).max(200).optional(), cwd: z.string().min(1).max(1000) });

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid project" }, { status: 400 });
  const result = await removeOwnedCodeProject(user.id, parsed.data, {
    find: (userId, input) => prisma.codeWorkspace.findFirst({ where: { userId, ...(input.id ? { id: input.id } : input.key ? { key: input.key } : { path: input.cwd }) }, select: { id: true, key: true, path: true } }),
    activeTasks: async (userId, cwd, key) => (await prisma.codeTask.findMany({
      where: { userId, OR: [{ workspacePath: cwd }, ...(key ? [{ workspaceKey: key }] : [])], status: { notIn: ["done", "failed", "cancelled"] } }, select: { id: true },
    })).map((t) => t.id),
    cancel: async (id) => {
      const task = await prisma.codeTask.findUnique({ where: { id }, select: { status: true } });
      await appendTaskEvents(id, [{ kind: "cancel_request", payload: {} }], task?.status === "queued" ? { status: "cancelled" } : {});
    },
    erase: async (userId, cwd, key, workspaceId) => {
      const sessions = await prisma.conversation.findMany({ where: { userId, kind: "code", OR: [{ codeWorkspacePath: cwd }, ...(key ? [{ codeWorkspaceKey: key }] : [])] }, select: { id: true } });
      const ids = sessions.map((s) => s.id);
      // Uses the ordinary conversation deletion path, including sync tombstones and artifact retention.
      if (ids.length) await deleteConversationsKeepingArtifacts(userId, ids);
      await prisma.codeTask.deleteMany({ where: { userId, OR: [{ workspacePath: cwd }, ...(key ? [{ workspaceKey: key }] : [])] } });
      await prisma.codeWorkspace.deleteMany({ where: { userId, ...(workspaceId ? { id: workspaceId } : { path: cwd }) } });
      return ids;
    },
  });
  return NextResponse.json(result.status === 200 ? { ok: true, sessionIds: result.sessionIds } : { error: result.error }, { status: result.status });
}
