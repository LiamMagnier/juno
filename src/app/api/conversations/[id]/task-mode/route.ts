import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { agentApprovalMode } from "@/lib/agents/domain";
import { inheritFromProjectDefaults, parseWorkDefaults } from "@/lib/work/projects";
import { WORK_PERMISSION_POLICIES } from "@/lib/work/domain";
import { describeChatTaskMode, parseChatTaskMode } from "@/lib/chat/task-approval-mode";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/*
 * /api/conversations/[id]/task-mode — how often a task started from this chat
 * stops to ask (src/lib/chat/task-approval-mode.ts).
 *
 * GET   → { chosen, effective, narrowedBy }
 * PATCH { mode: "conservative" | "balanced" | "permissive" | null } → the same,
 *       after saving; null goes back to the default.
 *
 * Saved on the conversation, so the choice follows the chat to every device
 * and every later task it starts. What it reports as `effective` is what the
 * dispatcher will actually run: a project or an agent with a stricter mode
 * still wins, and the response says which one did.
 */

async function view(userId: string, id: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id, userId, kind: "chat" },
    select: { id: true, taskApprovalMode: true, projectId: true, agentId: true },
  });
  if (!conversation) return null;
  const [project, agent] = await Promise.all([
    conversation.projectId
      ? prisma.project.findFirst({ where: { id: conversation.projectId, userId }, select: { workDefaults: true } })
      : null,
    conversation.agentId
      ? prisma.agent.findFirst({
          where: { id: conversation.agentId, userId, deletedAt: null },
          select: { approvalMode: true },
        })
      : null,
  ]);
  return describeChatTaskMode({
    chosen: parseChatTaskMode(conversation.taskApprovalMode),
    agentMode: agent ? agentApprovalMode(agent.approvalMode) : null,
    // The mode the dispatcher meets a session with, through the same fold it
    // uses (`inheritFromProject` in work/dispatch.ts), not the project's raw
    // setting: a project can only narrow from the default, so one set to
    // "Just do it" still holds its tasks at "Ask before risky steps", and the
    // chip must not promise a mode the task will not run as.
    projectMode: project
      ? inheritFromProjectDefaults({
          requestedTarget: "automatic",
          linkedConnectorIds: [],
          defaults: parseWorkDefaults(project.workDefaults),
        }).permissionPolicy
      : null,
  });
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const result = await view(user.id, id);
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
}

const patchSchema = z.object({ mode: z.enum(WORK_PERMISSION_POLICIES).nullable() });

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = patchSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const saved = await prisma.conversation.updateMany({
    where: { id, userId: user.id, kind: "chat" },
    data: { taskApprovalMode: parsed.data.mode },
  });
  if (saved.count === 0) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const result = await view(user.id, id);
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(result);
}
