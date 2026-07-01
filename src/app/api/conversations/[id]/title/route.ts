import { NextResponse, after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";
import { canUseModel } from "@/lib/plans";
import { MODEL_LIST, type ModelInfo } from "@/lib/models";
import { isProviderConfigured } from "@/lib/providers";
import { isOwnerEmail } from "@/lib/owner";
import { generateChatTitleFromMessages, fallbackChatTitle, generateProjectName, type TitleContextMessage } from "@/lib/titles";
import { canAutoRenameChatTitle, canAutoRenameProjectName, coerceTitleSource } from "@/lib/title-ownership";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  phase: z.enum(["first_user", "thinking", "writing", "completed", "stopped"]).optional(),
  messages: z
    .array(
      z.object({
        role: z.enum(["USER", "ASSISTANT"]),
        content: z.string().max(50_000),
      })
    )
    .max(8)
    .optional(),
});

function cleanContextMessages(messages: { role: "USER" | "ASSISTANT"; content: string }[] | undefined): TitleContextMessage[] {
  return (messages ?? [])
    .map((m) => ({ role: m.role, content: m.content.trim() }))
    .filter((m) => m.content)
    .slice(0, 8);
}

function pickTitleModel(plan: Awaited<ReturnType<typeof getUserPlan>>): ModelInfo | null {
  return (
    MODEL_LIST.filter((m) => m.modality === "chat" && isProviderConfigured(m.provider) && canUseModel(plan, m.id)).sort((a, b) => {
      if (a.cost !== b.cost) return a.cost - b.cost;
      if (a.minPlan !== b.minPlan) return a.minPlan === "FREE" ? -1 : 1;
      return a.name.localeCompare(b.name);
    })[0] ?? null
  );
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `title:${user.id}`, limit: 20, windowSec: 60 });
    if (!limit.success) return NextResponse.json({ error: "Too many title updates." }, { status: 429 });
  }

  const { id } = await params;
  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const existing = await prisma.conversation.findFirst({
    where: { id, userId: user.id },
    select: { id: true, title: true, titleSource: true, projectId: true },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const storedMessages = await prisma.message.findMany({
    where: { conversationId: id },
    orderBy: { createdAt: "asc" },
    take: 8,
    select: { role: true, content: true },
  });
  const dbMessages = cleanContextMessages(
    storedMessages
      .filter((m) => m.role === "USER" || m.role === "ASSISTANT")
      .map((m) => ({ role: m.role as "USER" | "ASSISTANT", content: m.content }))
  );
  const clientMessages = cleanContextMessages(parsed.data.messages);
  const contextMessages = clientMessages.some((m) => m.role === "USER") ? clientMessages : dbMessages;
  const firstUserText = contextMessages.find((m) => m.role === "USER")?.content ?? dbMessages.find((m) => m.role === "USER")?.content ?? "";

  if (!firstUserText) {
    return NextResponse.json({ title: existing.title, titleSource: coerceTitleSource(existing.titleSource), renamed: false });
  }
  if (!canAutoRenameChatTitle({ title: existing.title, titleSource: existing.titleSource, firstUserText })) {
    return NextResponse.json({ title: existing.title, titleSource: coerceTitleSource(existing.titleSource), renamed: false });
  }

  const plan = await getUserPlan(user.id);
  const titleModel = pickTitleModel(plan);
  const generated = titleModel ? await generateChatTitleFromMessages(titleModel, contextMessages).catch(() => null) : null;
  const nextTitle = generated ?? fallbackChatTitle(contextMessages) ?? existing.title;

  if (!nextTitle || nextTitle === existing.title) {
    return NextResponse.json({ title: existing.title, titleSource: coerceTitleSource(existing.titleSource), renamed: false });
  }

  const updated = await prisma.conversation.updateMany({
    where: { id, userId: user.id, title: existing.title, titleSource: existing.titleSource },
    data: { title: nextTitle, titleSource: "ai" },
  });
  if (updated.count !== 1) {
    const current = await prisma.conversation.findFirst({
      where: { id, userId: user.id },
      select: { title: true, titleSource: true },
    });
    return NextResponse.json({
      title: current?.title ?? existing.title,
      titleSource: coerceTitleSource(current?.titleSource ?? existing.titleSource),
      renamed: false,
    });
  }

  if (existing.projectId && titleModel) {
    const projectId = existing.projectId;
    after(async () => {
      const project = await prisma.project
        .findFirst({
          where: { id: projectId, userId: user.id },
          select: { name: true, nameSource: true, instructions: true },
        })
        .catch(() => null);
      if (!project || !canAutoRenameProjectName({ name: project.name, nameSource: project.nameSource })) return;
      const generatedProjectName =
        (await generateProjectName(titleModel, {
          firstUser: contextMessages.map((m) => m.content).join("\n\n").slice(0, 2000),
          instructions: project.instructions,
        }).catch(() => null)) ?? nextTitle;
      const projectUpdate = await prisma.project
        .updateMany({
          where: { id: projectId, userId: user.id, name: project.name, nameSource: project.nameSource },
          data: { name: generatedProjectName, nameSource: "ai" },
        })
        .catch(() => ({ count: 0 }));
      if (projectUpdate.count === 1) {
        console.info("[title] project name updated", { projectId, nameSource: "ai", nameLength: generatedProjectName.length });
      }
    });
  }

  console.info("[title] conversation title updated", {
    conversationId: id,
    phase: parsed.data.phase ?? null,
    titleSource: "ai",
    titleLength: nextTitle.length,
    projectRenameQueued: !!existing.projectId,
  });

  return NextResponse.json({
    title: nextTitle,
    titleSource: "ai",
    renamed: true,
    projectId: existing.projectId,
    projectName: null,
  });
}
