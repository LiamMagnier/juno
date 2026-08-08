import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { loadCitationAuditForMessage } from "@/lib/research/claims";

/**
 * The citation audit for one answer (program §8.3).
 *
 * The message footer asks for this after a deep-research turn, and renders each
 * claim's support state plus the exact passage the validator read. It answers
 * 200 with `audit: null` rather than 404 for a message that has no audit,
 * because that is the ordinary case — every non-research answer, and a research
 * answer whose audit is still running in the background — and a 404 would put
 * an error state under an answer that is perfectly fine.
 *
 * Scoping is by userId inside loadCitationAuditForMessage: a research corpus is
 * the user's reading history and the claims are what they were told, so a
 * message id belonging to someone else simply finds nothing here.
 */

const query = z.object({ messageId: z.string().min(1).max(64) });

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = query.safeParse({ messageId: new URL(req.url).searchParams.get("messageId") ?? "" });
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  try {
    const audit = await loadCitationAuditForMessage(user.id, parsed.data.messageId);
    return NextResponse.json({ audit });
  } catch (err) {
    // A failed audit lookup must not break the answer it sits under. The footer
    // degrades to "citation check unavailable" and the report stays readable.
    console.error("[research/citations] load failed", {
      messageId: parsed.data.messageId,
      message: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "Citation audit unavailable" }, { status: 500 });
  }
}
