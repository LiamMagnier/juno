// QA fixtures the cross-cutting gates need (spec §9, P0 (5)), seeded by
// run-prod-e2e.sh after scripts/seed-e2e-user.ts and seed-research-e2e.ts:
//
// - "QA · 1,000 messages": the thread the JS heap and INP gates open. 500
//   question/answer pairs with prose, lists and a code block every tenth
//   answer, so the windowed transcript has something realistic to window.
// - "QA · Code session": a kind "code" conversation with a workspace, so
//   /code/[id] renders the v2 workspace instead of redirecting to /chat.
//
// The ids land in $ALEVR_QA_RUN_DIR/fixtures.json for the specs
// (e2e/support/fixtures.ts reads it). Refuses any database that is not the
// disposable QA one, whatever the caller.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { encryptMessageText } from "../../src/lib/message-crypto";
import { parseQaDatabaseUrl } from "./lib/safe-env.mjs";

const EMAIL = process.env.E2E_EMAIL ?? "e2e@juno.test";
const THREAD_MESSAGES = 1000;

function question(i: number): string {
  return `Question ${i + 1}: how should step ${i + 1} of the migration handle rows written before the cutoff?`;
}

function answer(i: number): string {
  const lines = [
    `Step ${i + 1} keeps every pre-cutoff row as it is and marks it as migrated, so nothing is rewritten twice.`,
    "",
    "- Read the row in its original shape.",
    "- Write the new column only when it is still empty.",
    "- Record the batch so a retry resumes where it stopped.",
  ];
  if (i % 10 === 0) {
    lines.push("", "```ts", `export async function migrateBatch${i}(ids: string[]) {`, "  for (const id of ids) await backfill(id);", "}", "```");
  }
  return lines.join("\n");
}

async function main() {
  const db = parseQaDatabaseUrl(process.env.DATABASE_URL, "DATABASE_URL");
  if (!db.ok) throw new Error(`Refusing to seed: ${db.reason}`);
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });

    const thread = await prisma.conversation.upsert({
      where: { userId_clientRequestId: { userId: user.id, clientRequestId: "qa-thread-1000" } },
      update: { title: "QA · 1,000 messages" },
      create: { userId: user.id, clientRequestId: "qa-thread-1000", title: "QA · 1,000 messages" },
    });
    await prisma.message.deleteMany({ where: { conversationId: thread.id } });
    const start = Date.now() - THREAD_MESSAGES * 60_000;
    const rows = Array.from({ length: THREAD_MESSAGES }, (_, n) => {
      const pair = Math.floor(n / 2);
      const isUser = n % 2 === 0;
      return {
        conversationId: thread.id,
        clientId: `qa-thread-${n}`,
        role: isUser ? ("USER" as const) : ("ASSISTANT" as const),
        model: isUser ? null : "anthropic:claude-sonnet-5",
        content: encryptMessageText(isUser ? question(pair) : answer(pair)),
        createdAt: new Date(start + n * 60_000),
      };
    });
    for (let i = 0; i < rows.length; i += 250) {
      await prisma.message.createMany({ data: rows.slice(i, i + 250) });
    }

    const code = await prisma.conversation.upsert({
      where: { userId_clientRequestId: { userId: user.id, clientRequestId: "qa-code-session" } },
      update: { title: "QA · Code session", kind: "code", codeWorkspaceName: "alevr-qa", codeWorkspaceKey: "qa/alevr-qa" },
      create: {
        userId: user.id,
        clientRequestId: "qa-code-session",
        title: "QA · Code session",
        kind: "code",
        codeWorkspaceName: "alevr-qa",
        codeWorkspaceKey: "qa/alevr-qa",
      },
    });
    await prisma.message.deleteMany({ where: { conversationId: code.id } });
    await prisma.message.createMany({
      data: [
        {
          conversationId: code.id,
          clientId: "qa-code-user",
          role: "USER",
          content: encryptMessageText("Add a health check route that returns ok."),
          createdAt: new Date(Date.now() - 60_000),
        },
        {
          conversationId: code.id,
          clientId: "qa-code-assistant",
          role: "ASSISTANT",
          model: "anthropic:claude-sonnet-5",
          content: encryptMessageText("Added `src/app/api/health/route.ts`, which returns `{ ok: true }`."),
          createdAt: new Date(Date.now() - 30_000),
        },
      ],
    });

    const research = await prisma.researchRun.findFirst({ where: { id: "qa-research-paused", userId: user.id }, select: { id: true } });
    const fixtures = { qaThreadId: thread.id, qaCodeSessionId: code.id, researchRunId: research?.id ?? null };
    const runDir = process.env.ALEVR_QA_RUN_DIR;
    if (runDir) writeFileSync(path.join(runDir, "fixtures.json"), `${JSON.stringify(fixtures, null, 2)}\n`);
    console.log(`QA fixtures ready: thread /chat/${thread.id} (${THREAD_MESSAGES} messages), code /code/${code.id}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
