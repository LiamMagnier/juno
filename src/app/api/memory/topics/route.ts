import { NextResponse, after } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { forgetStatements, refreshSummaries } from "@/lib/memory";
import { normalizeStatement } from "@/lib/memory-suppression";
import { TOPIC_MAX_CHARS, cleanTopic, topicOfStatement, topicStatement } from "@/lib/memory-topics";

/*
 * Topics Juno does not remember — "anything about my divorce".
 *
 * A topic exclusion is a block-list row (a SUPPRESSION whose text is
 * "Anything about <topic>", see src/lib/memory-topics.ts), so this route only
 * lists and adds them; lifting one is the ordinary DELETE /api/memory/[id] on
 * its row, like any other block-list entry.
 *
 * Adding one is a forget, not a filter: every fact already remembered on the
 * topic is retired (kept as history, marked forgotten, its vector dropped), the
 * row blocks every writer from learning the topic again, and the summaries
 * that may mention it are benched until rebuilt — the same path as saying
 * "never remember anything about my divorce" in a chat (forgetStatements).
 */

interface TopicView {
  id: string;
  topic: string;
  createdAt: string;
}

async function listTopics(userId: string): Promise<TopicView[]> {
  const rows = await prisma.memoryEntry.findMany({
    where: { userId, kind: "SUPPRESSION" },
    orderBy: { createdAt: "desc" },
    select: { id: true, content: true, createdAt: true },
  });
  return rows.flatMap((row) => {
    const topic = topicOfStatement(row.content);
    return topic === null ? [] : [{ id: row.id, topic, createdAt: row.createdAt.toISOString() }];
  });
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ topics: await listTopics(user.id) });
}

const schema = z.object({ topic: z.string().trim().min(1).max(TOPIC_MAX_CHARS * 2) });

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  // "Anything about my divorce" typed into the box is the topic "my divorce".
  const topic = topicOfStatement(parsed.data.topic) ?? cleanTopic(parsed.data.topic);
  if (!topic) {
    return NextResponse.json({ error: "Name the topic in a word or two — “my divorce”, “my health”." }, { status: 400 });
  }

  const statement = topicStatement(topic);
  const key = normalizeStatement(statement);
  const sameTopic = (view: TopicView) => normalizeStatement(topicStatement(view.topic)) === key;
  const existed = (await listTopics(user.id)).some(sameTopic);
  const outcome = await forgetStatements(user.id, [statement], { conversationId: null, origin: "memory-page" });
  // The account's summary is benched by the new block-list row already
  // (summaryPredatesForget); rebuild it once the response has gone, so the
  // next chat has a summary again that never mentions the topic. Project
  // summaries are benched the same way and rebuild on their next turn.
  if (!existed || outcome.retired > 0) {
    after(() => refreshSummaries(user.id, [null]).then(() => undefined, () => undefined));
  }

  const topics = await listTopics(user.id);
  return NextResponse.json(
    { topic: topics.find(sameTopic) ?? null, retired: outcome.retired, topics },
    { status: existed ? 200 : 201 }
  );
}
