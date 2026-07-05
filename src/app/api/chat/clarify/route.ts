import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { decryptMessageText } from "@/lib/message-crypto";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";
import { noPreflightClarification, quickPreflightSkip } from "@/lib/preflight-clarification";
import { triagePreflightClarification, type TriageContextMessage } from "@/lib/preflight-triage";
import { getUserPlan } from "@/lib/usage";
import { checkBudget } from "@/lib/spend";

export const runtime = "nodejs";
export const maxDuration = 30;

const bodySchema = z.object({
  message: z.string().max(50_000),
  conversationId: z.string().cuid().optional().nullable(),
  hasAttachments: z.boolean().optional(),
  privateMode: z.boolean().optional(),
});

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `chat-clarify:${user.id}`, limit: 60, windowSec: 60 });
    if (!limit.success) {
      return NextResponse.json(noPreflightClarification("Clarification checks are rate limited."), { status: 200 });
    }
    // The triage LLM is a real API cost; a budget-blocked user shouldn't spend
    // on it. Fail OPEN (no clarification) so this never blocks the UI — the send
    // itself is gated by the chat route's 402.
    const plan = await getUserPlan(user.id);
    const budget = await checkBudget(user.id, plan);
    if (!budget.allowed) {
      return NextResponse.json(noPreflightClarification("Budget exhausted — skipping clarification."), { status: 200 });
    }
  }

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json(noPreflightClarification("Invalid clarification check request."), { status: 200 });
  const input = parsed.data;

  // Deterministic fast path: obvious "just answer" cases never pay AI latency.
  const skip = quickPreflightSkip({ message: input.message, hasAttachments: input.hasAttachments });
  if (skip) return NextResponse.json(noPreflightClarification(skip));

  // This whole check is best-effort: any failure past this point must fail
  // OPEN (no clarification, 200) — a broken triage must never block sending.
  try {
    // Recent conversation context lets the triage model recognize follow-ups
    // ("now make the header sticky") instead of re-interrogating the user.
    // Private chats send no conversationId, so nothing is read for them.
    let recentMessages: TriageContextMessage[] = [];
    if (input.conversationId && !input.privateMode) {
      const rows = await prisma.message.findMany({
        where: { conversationId: input.conversationId, conversation: { userId: user.id } },
        orderBy: { createdAt: "desc" },
        take: 6,
        select: { role: true, content: true },
      });
      recentMessages = rows
        .reverse()
        .filter((m) => m.role === "USER" || m.role === "ASSISTANT")
        .map((m) => ({ role: m.role as "USER" | "ASSISTANT", content: decryptMessageText(m.content) }));
    }

    const result = await triagePreflightClarification({ message: input.message, recentMessages });
    return NextResponse.json(result);
  } catch (err) {
    console.error("[chat/clarify] check failed, answering directly:", err instanceof Error ? err.message : err);
    return NextResponse.json(noPreflightClarification("Clarification check failed — answering directly."));
  }
}
