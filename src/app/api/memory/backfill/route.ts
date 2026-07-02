import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { backfillMemories, pendingBackfill, utilityModelCandidates } from "@/lib/memory";

export const runtime = "nodejs";
export const maxDuration = 60;

/** How many conversations still need their messages distilled into memory. */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const remaining = (await pendingBackfill(user.id)).length;
  return NextResponse.json({ remaining });
}

/**
 * Process one bounded batch of not-yet-distilled conversations. Call again
 * while `remaining` > 0 — progress is saved per chunk, so this is resumable.
 */
export async function POST() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (utilityModelCandidates().length === 0) {
    return NextResponse.json({ error: "No model provider is configured." }, { status: 503 });
  }

  const { processedConversations, created, remaining } = await backfillMemories({
    userId: user.id,
    maxConversations: 2,
  });
  return NextResponse.json({ processedConversations, created, remaining });
}
