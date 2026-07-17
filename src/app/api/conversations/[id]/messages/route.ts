import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { encryptMessageText, decryptMessageTextSafe } from "@/lib/message-crypto";
import { appendRequestSchema, appendTurnCreatedAt } from "@/lib/message-append";

export const runtime = "nodejs";

// Native transcript push: the app appends batches of finalized turns (Code
// session transcripts, voice turns) to a conversation it owns. Idempotent on
// (conversationId, clientId) — a retried batch returns the rows the first
// attempt created instead of duplicating them, and the persisted row always
// wins over a retry that drifted.
const MAX_BODY_BYTES = 1024 * 1024;

// Every kind that may receive native appends. kind:"code" is the Code
// transcript push path (POST /api/chat refuses those conversations with 409);
// "chat" covers voice turns and future native chat surfaces.
const APPENDABLE_KINDS = new Set(["chat", "code"]);

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  const parsed = appendRequestSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { turns } = parsed.data;

  const conversation = await prisma.conversation.findFirst({
    where: { id, userId: user.id },
    select: { id: true, kind: true },
  });
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!APPENDABLE_KINDS.has(conversation.kind)) {
    return NextResponse.json({ error: `Conversations of kind "${conversation.kind}" do not accept appends.` }, { status: 409 });
  }

  const clientIds = turns.map((turn) => turn.clientId);
  const write = () =>
    prisma.$transaction(async (tx) => {
      const existing = await tx.message.findMany({
        where: { conversationId: id, clientId: { in: clientIds } },
      });
      const byClientId = new Map(existing.map((row) => [row.clientId as string, row]));
      const createdIds = new Set<string>();
      const now = Date.now();
      let newestCreatedAt: Date | null = null;
      for (const [index, turn] of turns.entries()) {
        if (byClientId.has(turn.clientId)) continue;
        const createdAt = appendTurnCreatedAt(turn, index, turns.length, now);
        const row = await tx.message.create({
          data: {
            conversationId: id,
            clientId: turn.clientId,
            role: turn.role,
            content: encryptMessageText(turn.content),
            model: turn.model ?? null,
            promptTokens: turn.promptTokens ?? null,
            completionTokens: turn.completionTokens ?? null,
            createdAt,
          },
        });
        byClientId.set(turn.clientId, row);
        createdIds.add(turn.clientId);
        if (!newestCreatedAt || createdAt > newestCreatedAt) newestCreatedAt = createdAt;
      }
      // Bump the sidebar ordering only forward — replays and historical
      // backfills must never drag a conversation back in time. The guard is
      // inside the WHERE so a concurrent newer write can't be overwritten.
      if (newestCreatedAt) {
        await tx.conversation.updateMany({
          where: { id, userId: user.id, lastMessageAt: { lt: newestCreatedAt } },
          data: { lastMessageAt: newestCreatedAt },
        });
      }
      return { byClientId, createdIds };
    });

  let result: Awaited<ReturnType<typeof write>>;
  try {
    result = await write();
  } catch (error) {
    // Two identical batches can race past the findMany; the unique index
    // rolls one back — rerun so both callers get the winner's rows.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      result = await write();
    } else {
      throw error;
    }
  }

  return NextResponse.json({
    conversationId: id,
    messages: turns.map((turn) => {
      const row = result.byClientId.get(turn.clientId)!;
      return {
        clientId: turn.clientId,
        id: row.id,
        role: row.role,
        content: decryptMessageTextSafe(row.content),
        model: row.model,
        promptTokens: row.promptTokens,
        completionTokens: row.completionTokens,
        createdAt: row.createdAt.toISOString(),
        created: result.createdIds.has(turn.clientId),
      };
    }),
  });
}
