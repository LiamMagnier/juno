import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { runUtilityPrompt, utilityModelCandidates } from "@/lib/memory";

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({ instruction: z.string().trim().min(1).max(600) });

// What the model returns: operations addressed by 1-based index into the fact list.
const modelOpSchema = z.union([
  z.object({ op: z.literal("add"), content: z.string().trim().min(1).max(500), suppress: z.boolean().optional() }),
  z.object({ op: z.literal("update"), index: z.number().int().min(1), content: z.string().trim().min(1).max(500) }),
  z.object({ op: z.literal("remove"), index: z.number().int().min(1) }),
]);
const modelOutSchema = z.union([
  z.object({ summary: z.string().trim().min(1).max(300), operations: z.array(modelOpSchema).min(1).max(8) }),
  z.object({ refusal: z.string().trim().min(1).max(300) }),
]);

function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Draft a memory edit from a natural-language instruction. Returns a reviewable
 * proposal (operations resolved to fact ids, with `before` text for diffs) —
 * nothing is written until the user accepts it via /api/memory/edit/apply.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const candidates = utilityModelCandidates();
  if (candidates.length === 0) {
    return NextResponse.json({ error: "No model provider is configured." }, { status: 503 });
  }

  const facts = await prisma.memoryEntry.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "asc" },
    select: { id: true, content: true, kind: true },
  });

  const system = `You translate a user's natural-language instruction about their long-term memory into precise operations on their saved memory entries. You are given the numbered list of current entries — regular facts, plus [forgotten] suppression entries (statements the user asked to never remember). Decide the minimal set of operations that fulfils the instruction.

Operations:
- {"op":"add","content":"<new fact>"} — remember something new
- {"op":"add","content":"<the statement to forget>","suppress":true} — forget something permanently: write the statement itself (e.g. "The user is researching desk setups."), NOT an instruction like "forget that…". It will be blocked from memory forever.
- {"op":"update","index":<n>,"content":"<rewritten fact>"} — correct or amend entry n
- {"op":"remove","index":<n>} — delete entry n (also how you un-forget: remove a [forgotten] entry)

Rules:
- Facts are short, durable, third-person statements about the user (e.g. "The user prefers short explanations with code examples.").
- Prefer "update" over remove+add when the instruction corrects an existing fact.
- When the user wants to FORGET something: remove every matching fact entry AND add one suppress entry covering it. The suppress entry also blocks that content from the user's past chats, so add it even when no fact matches.
- Never store secrets, passwords, API keys, or one-off task details — refuse instead.
- If the instruction isn't about what to remember, update, or forget, refuse with a short, friendly reason.
- Return ONLY JSON, no prose: {"summary":"<one short sentence describing the change>","operations":[...]} or {"refusal":"<reason>"}.`;

  const userMsg = `Saved entries:\n${
    facts.length
      ? facts.map((f, i) => `${i + 1}. ${f.kind === "SUPPRESSION" ? "[forgotten] " : ""}${f.content}`).join("\n")
      : "(none yet)"
  }\n\nInstruction: ${parsed.data.instruction}\n\nReturn the JSON.`;

  // Walk the candidate models (with a one-shot retry for transiently
  // rate-limited providers) and be honest about why it failed if it does.
  const { result: drafted, transient } = await runUtilityPrompt({
    system,
    userMsg,
    maxTokens: 600,
    label: "memory/edit",
    parse: (text) => {
      const attempt = modelOutSchema.safeParse(extractJson(text));
      return attempt.success ? attempt.data : null;
    },
  });
  if (!drafted) {
    return NextResponse.json(
      {
        error: transient
          ? "The AI providers are rate-limited right now — wait a minute and try again."
          : "Every configured AI provider is out of credits, so Juno can’t draft changes right now. Add credit to a provider and try again.",
      },
      { status: 502 }
    );
  }

  if ("refusal" in drafted) {
    return NextResponse.json({ refusal: drafted.refusal });
  }

  // Resolve indices to ids + current text; a bad index means the model drifted.
  const operations = [];
  for (const op of drafted.operations) {
    if (op.op === "add") {
      operations.push({ op: "add" as const, content: op.content, ...(op.suppress ? { suppress: true } : {}) });
      continue;
    }
    const fact = facts[op.index - 1];
    if (!fact) {
      return NextResponse.json({ error: "Couldn’t draft that change right now — try again in a moment." }, { status: 502 });
    }
    operations.push(
      op.op === "update"
        ? { op: "update" as const, id: fact.id, before: fact.content, content: op.content }
        : { op: "remove" as const, id: fact.id, before: fact.content }
    );
  }

  return NextResponse.json({ proposal: { summary: drafted.summary, operations } });
}
