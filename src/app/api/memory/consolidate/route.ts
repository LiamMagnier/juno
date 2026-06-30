import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { consolidateMemories, getMemorySummary } from "@/lib/memory";
import { MODEL_LIST } from "@/lib/models";
import { isProviderConfigured } from "@/lib/providers";

export const runtime = "nodejs";
export const maxDuration = 60;

// Regenerate the consolidated memory summary on demand (the "Regenerate" button).
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const model =
    MODEL_LIST.find((m) => isProviderConfigured(m.provider) && m.minPlan === "FREE") ??
    MODEL_LIST.find((m) => isProviderConfigured(m.provider));
  if (!model) return NextResponse.json({ error: "No model provider is configured." }, { status: 503 });

  const count = await prisma.memoryEntry.count({ where: { userId: user.id } });
  if (count === 0) return NextResponse.json({ summary: null });

  const content = await consolidateMemories({ userId: user.id, model });
  if (!content) {
    return NextResponse.json({ error: "Couldn’t generate a summary right now — try again in a moment." }, { status: 502 });
  }

  const s = await getMemorySummary(user.id);
  return NextResponse.json({
    summary: { content, updatedAt: s?.updatedAt.toISOString() ?? new Date().toISOString(), entryCount: s?.entryCount ?? count },
  });
}
