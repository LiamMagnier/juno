import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { decryptMessageTextSafe } from "@/lib/message-crypto";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { getUserPlan } from "@/lib/usage";

export const runtime = "nodejs";

/** Hard cap on exported message rows — keeps the response to a few MB at most. */
const MAX_MESSAGE_ROWS = 50_000;

/**
 * RFC 4180 quoting, plus CSV-injection neutralization: a leading =, +, -, @,
 * tab or CR is prefixed with a single quote so spreadsheet apps do not evaluate
 * attacker-influenceable message text as a formula (CWE-1236).
 */
function csvField(value: string | null | undefined): string {
  let v = value ?? "";
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return `"${v.replace(/"/g, '""')}"`;
}

/**
 * GDPR data export. `GET` returns the full account snapshot as JSON;
 * `?format=csv` returns the message history as a CSV instead.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const limit = await rateLimit({ key: `export:${user.id}`, limit: 5, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "Too many exports — try again later." }, { status: 429 });
  }

  const format = new URL(req.url).searchParams.get("format") === "csv" ? "csv" : "json";
  const date = new Date().toISOString().slice(0, 10);

  const [account, plan, settings, conversations, rawMessages, memories, memorySummary, projects, attachments, spendTotals, spendByKind] =
    await Promise.all([
      prisma.user.findUnique({ where: { id: user.id }, select: { name: true, email: true, createdAt: true } }),
      getUserPlan(user.id),
      prisma.settings.findUnique({
        where: { userId: user.id },
        select: {
          theme: true,
          accent: true,
          defaultModel: true,
          customInstructions: true,
          responseLanguage: true,
          personality: true,
          memoryEnabled: true,
          voiceId: true,
          favoriteModels: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.conversation.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        select: { id: true, title: true, model: true, createdAt: true, updatedAt: true },
      }),
      prisma.message.findMany({
        where: { conversation: { userId: user.id } },
        orderBy: { createdAt: "asc" },
        take: MAX_MESSAGE_ROWS + 1,
        select: {
          conversationId: true,
          role: true,
          content: true,
          reasoning: true,
          model: true,
          promptTokens: true,
          completionTokens: true,
          createdAt: true,
        },
      }),
      prisma.memoryEntry.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        select: { content: true, source: true, kind: true, createdAt: true },
      }),
      prisma.memorySummary.findUnique({
        where: { userId: user.id },
        select: { content: true, entryCount: true, updatedAt: true },
      }),
      prisma.project.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        select: { name: true, instructions: true, createdAt: true, updatedAt: true },
      }),
      prisma.attachment.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
        select: { fileName: true, mimeType: true, kind: true, size: true, createdAt: true },
      }),
      prisma.apiSpend.aggregate({
        where: { userId: user.id },
        _count: true,
        _sum: { promptTokens: true, completionTokens: true, costMicroUsd: true },
      }),
      prisma.apiSpend.groupBy({
        by: ["kind"],
        where: { userId: user.id },
        _count: true,
        _sum: { costMicroUsd: true },
      }),
    ]);

  const truncated = rawMessages.length > MAX_MESSAGE_ROWS;
  const messages = (truncated ? rawMessages.slice(0, MAX_MESSAGE_ROWS) : rawMessages).map((m) => ({
    ...m,
    content: decryptMessageTextSafe(m.content),
    reasoning: decryptMessageTextSafe(m.reasoning),
  }));

  if (format === "csv") {
    const titleById = new Map(conversations.map((c) => [c.id, c.title]));
    const lines = ["conversation,role,model,content,createdAt"];
    for (const m of messages) {
      lines.push(
        [
          csvField(titleById.get(m.conversationId)),
          csvField(m.role),
          csvField(m.model),
          csvField(m.content),
          csvField(m.createdAt.toISOString()),
        ].join(",")
      );
    }
    return new NextResponse(lines.join("\r\n") + "\r\n", {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="juno-export-${date}.csv"`,
      },
    });
  }

  const byConversation = new Map<string, object[]>();
  for (const m of messages) {
    const row = {
      role: m.role,
      content: m.content,
      reasoning: m.reasoning,
      model: m.model,
      promptTokens: m.promptTokens,
      completionTokens: m.completionTokens,
      createdAt: m.createdAt,
    };
    const list = byConversation.get(m.conversationId);
    if (list) list.push(row);
    else byConversation.set(m.conversationId, [row]);
  }

  const payload = {
    exportedAt: new Date().toISOString(),
    profile: {
      name: account?.name ?? null,
      email: account?.email ?? user.email ?? null,
      createdAt: account?.createdAt ?? null,
      plan,
    },
    settings,
    memories,
    memorySummary,
    projects,
    attachments: {
      note: "File metadata only — the files themselves can be downloaded from the app.",
      items: attachments,
    },
    apiSpend: {
      requestCount: spendTotals._count,
      promptTokens: spendTotals._sum.promptTokens ?? 0,
      completionTokens: spendTotals._sum.completionTokens ?? 0,
      totalCostUsd: (spendTotals._sum.costMicroUsd ?? 0) / 1_000_000,
      byKind: spendByKind.map((k) => ({
        kind: k.kind,
        requestCount: k._count,
        costUsd: (k._sum.costMicroUsd ?? 0) / 1_000_000,
      })),
    },
    messagesTruncated: truncated,
    ...(truncated
      ? { truncationNote: `Message export is capped at ${MAX_MESSAGE_ROWS.toLocaleString("en-US")} rows; older messages are included first.` }
      : {}),
    conversations: conversations.map((c) => ({
      title: c.title,
      model: c.model,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      messages: byConversation.get(c.id) ?? [],
    })),
  };

  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="juno-export-${date}.json"`,
    },
  });
}
