import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { backfillMemories, pendingBackfill, reconcileMemoryTimeline, utilityModelCandidates } from "@/lib/memory";

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

  // Paused means nothing is learned — enforced here, not only by the disabled
  // button. The button was the only guard, so any client that called the route
  // (a stale tab, the native app, a script) distilled a paused account's chats.
  const settings = await prisma.settings.findUnique({
    where: { userId: user.id },
    select: { memoryEnabled: true },
  });
  if (settings?.memoryEnabled === false) {
    return NextResponse.json(
      { error: "Memory is paused, so Juno isn’t learning from chats. Resume it to read past chats." },
      { status: 409 }
    );
  }

  if (utilityModelCandidates().length === 0) {
    return NextResponse.json({ error: "No model provider is configured." }, { status: 503 });
  }

  const { processedConversations, created, remaining } = await backfillMemories({
    userId: user.id,
    maxConversations: 2,
  });
  // History is read newest chat first. Each fact is judged by when it was
  // said as it arrives, and this settles the rest — rows written before times
  // were recorded, dated from their messages, judged again with the batch.
  // Best effort: the batch is saved whether or not this runs.
  const { changed } = await reconcileMemoryTimeline(user.id).catch(() => ({ changed: 0 }));
  return NextResponse.json({ processedConversations, created, remaining, rejudged: changed });
}
