import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { rateLimit } from "@/lib/rate-limit";
import { isOwnerEmail } from "@/lib/owner";
import { decryptMessageTextSafe } from "@/lib/message-crypto";
import { runUtilityPrompt } from "@/lib/memory";

export const runtime = "nodejs";
export const maxDuration = 60;

const requestSchema = z.object({
  conversationId: z.string().cuid(),
});

const MAX_SUGGESTIONS = 3;
/** A pill's text IS the message that gets sent, so it must stay a whole, short question. */
const MAX_SUGGESTION_CHARS = 80;
/** Below this, a line is an interjection ("Sure!"), not a real follow-up ask. */
const MIN_SUGGESTION_CHARS = 12;
const CONTEXT_MESSAGES = 6;

function compact(text: string): string {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * One suggestion per line. Over-long lines are dropped rather than truncated —
 * a sliced-off question would be sent verbatim as the user's next prompt.
 * Returns null when nothing survives so runUtilityPrompt walks to the next model.
 */
/**
 * A conversational preamble the model emits despite being told not to —
 * "Here are three follow-up questions:", "Sure!", "Voici :".
 *
 * This matters more than it looks: a pill's text IS the next user prompt, so a
 * preamble that survives is both sent verbatim AND displaces a real suggestion
 * (we stop at three). The parser already strips bullets/numbering — i.e. it
 * assumes the model disobeys the format rules — so trusting "no preamble" from
 * the same sentence was inconsistent. titles.ts guards the same class.
 */
function isPreamble(text: string): boolean {
  // A user's question never ends in a colon; a heading almost always does.
  if (/[:：]$/.test(text)) return true;
  // Interjections ("Sure!", "Okay", "Bien sûr !") are far shorter than a real ask.
  return text.length < MIN_SUGGESTION_CHARS;
}

function parseSuggestions(raw: string): string[] | null {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of (raw || "").split("\n")) {
    const text = line
      .replace(/^\s*(?:[-*•–—]|\d+[.)])\s*/, "")
      .replace(/^["'`«»“”*]+|["'`«»“”*]+$/g, "")
      .trim();
    if (!text || text.length > MAX_SUGGESTION_CHARS || isPreamble(text)) continue;
    const key = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out.length ? out : null;
}

const SYSTEM = `You propose what the user is most likely to ask NEXT in this conversation.
Rules:
- Return exactly 3 suggestions, one per line. No numbering, no bullets, no quotes, no preamble.
- Each line is written from the USER's point of view, addressed to the assistant.
- Each line is at most 80 characters. Short and specific beats complete.
- Anchor each one in the concrete details of this conversation. No generic filler like "Tell me more" or "Explain further".
- Each must open a genuinely new direction — never restate what the assistant already answered.
- Write them in the SAME language as the conversation.
Return ONLY the 3 lines.`;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (!isOwnerEmail(user.email)) {
    const limit = await rateLimit({ key: `follow-ups:${user.id}`, limit: 30, windowSec: 60 });
    if (!limit.success) return NextResponse.json({ error: "Too many follow-up requests." }, { status: 429 });
  }

  const parsed = requestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const conversation = await prisma.conversation.findFirst({
    where: { id: parsed.data.conversationId, userId: user.id },
    select: { id: true },
  });
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Suggestions are decoration under a finished reply: any failure past this
  // point degrades to no pills at all, never an error surfaced in the UI.
  try {
    const recent = await prisma.message.findMany({
      where: { conversationId: conversation.id, role: { in: ["USER", "ASSISTANT"] } },
      orderBy: { createdAt: "desc" },
      take: CONTEXT_MESSAGES,
      select: { role: true, content: true },
    });

    const messages = recent
      .reverse()
      .map((m) => ({ role: m.role, content: compact(decryptMessageTextSafe(m.content)) }))
      .filter((m) => m.content);

    // Nothing to follow up on until the assistant has actually said something.
    if (!messages.some((m) => m.role === "ASSISTANT")) return NextResponse.json({ suggestions: [] });

    const transcript = messages
      .map((m) => `${m.role === "USER" ? "User" : "Assistant"}: ${m.content.slice(0, m.role === "USER" ? 1200 : 2000)}`)
      .join("\n\n");

    const { result } = await runUtilityPrompt({
      system: SYSTEM,
      userMsg: `Conversation so far:\n${transcript}\n\nThree follow-up questions the user might send next:`,
      maxTokens: 160,
      label: "follow-ups",
      parse: parseSuggestions,
    });

    return NextResponse.json({ suggestions: result ?? [] });
  } catch (err) {
    console.error("[follow-ups] generation failed", { conversationId: conversation.id, err });
    return NextResponse.json({ suggestions: [] });
  }
}
