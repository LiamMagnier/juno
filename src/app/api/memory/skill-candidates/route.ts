import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { listSkillCandidates, refreshSkillCandidates } from "@/lib/procedural-memory-store";

/**
 * Methods the person's own runs repeated, proposed as skills (Layer G).
 * Refreshed on read while memory is on — a paused memory proposes nothing
 * new, and still shows what was already proposed so it can be dismissed.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const settings = await prisma.settings.findUnique({ where: { userId: user.id }, select: { memoryEnabled: true } });
  if (settings?.memoryEnabled !== false) {
    await refreshSkillCandidates(user.id).catch((error) => {
      console.error("[memory] skill candidates refresh failed:", error instanceof Error ? error.message : error);
    });
  }
  return NextResponse.json({ candidates: await listSkillCandidates(user.id) });
}
