import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

// Aggregate the user's activity for the profile page: a daily token heatmap
// (last 53 weeks) + per-model usage.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const since = new Date();
  since.setDate(since.getDate() - 371);

  const account = await prisma.user.findUnique({ where: { id: user.id }, select: { createdAt: true } });

  const messages = await prisma.message.findMany({
    where: { conversation: { userId: user.id }, createdAt: { gte: since } },
    select: { model: true, role: true, promptTokens: true, completionTokens: true, createdAt: true },
    take: 50000,
  });

  const daily: Record<string, { tokens: number; count: number }> = {};
  const byModel: Record<string, { count: number; tokens: number }> = {};
  let totalTokens = 0;
  let totalMessages = 0;

  for (const m of messages) {
    const tokens = (m.promptTokens ?? 0) + (m.completionTokens ?? 0);
    const day = m.createdAt.toISOString().slice(0, 10);
    daily[day] ??= { tokens: 0, count: 0 };
    daily[day].tokens += tokens;
    daily[day].count += 1;
    totalTokens += tokens;
    if (m.role === "ASSISTANT") {
      totalMessages += 1;
      const key = m.model ?? "unknown";
      byModel[key] ??= { count: 0, tokens: 0 };
      byModel[key].count += 1;
      byModel[key].tokens += tokens;
    }
  }

  const models = Object.entries(byModel)
    .map(([model, v]) => ({ model, ...v }))
    .sort((a, b) => b.count - a.count);

  return NextResponse.json({
    daily,
    models,
    totalTokens,
    totalMessages,
    memberSince: account?.createdAt.toISOString() ?? null,
  });
}
