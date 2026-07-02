import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { consolidateWithFallback, getMemorySummary, hasMemorySources, utilityModelCandidates } from "@/lib/memory";

export const runtime = "nodejs";
export const maxDuration = 60;

// Regenerate the consolidated memory summary on demand (the "Regenerate" button).
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (utilityModelCandidates().length === 0) {
    return NextResponse.json({ error: "No model provider is configured." }, { status: 503 });
  }

  if (!(await hasMemorySources(user.id))) return NextResponse.json({ summary: null });

  const content = await consolidateWithFallback(user.id);
  if (!content) {
    return NextResponse.json({ error: "Couldn’t generate a summary right now — try again in a moment." }, { status: 502 });
  }

  const s = await getMemorySummary(user.id);
  return NextResponse.json({
    summary: { content, updatedAt: s?.updatedAt.toISOString() ?? new Date().toISOString(), entryCount: s?.entryCount ?? 0 },
  });
}
