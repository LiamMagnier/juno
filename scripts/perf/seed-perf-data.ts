// Deterministic data for the navigation and long-transcript benchmark
// (scripts/perf/measure-navigation.mjs). Run AFTER scripts/seed-e2e-user.ts,
// against a throwaway database — never production:
//   NODE_OPTIONS=--conditions=react-server npx tsx scripts/perf/seed-perf-data.ts
// Prints the ids the measurement script needs as one JSON line.
import { PrismaClient } from "@prisma/client";
import { encryptMessageText } from "../../src/lib/message-crypto";

const EMAIL = process.env.E2E_EMAIL ?? "e2e@juno.test";
const prisma = new PrismaClient();

const PARAGRAPH =
  "This paragraph carries ordinary detail, [a cited source](https://example.com/source), **emphasis**, and an explanation long enough to wrap across several lines of the transcript column. ";

function assistantBody(i: number) {
  const code = i % 10 === 1
    ? "\n\n```typescript\nexport async function readSources(run: ResearchRun) {\n  const pages = await run.fetch({ limit: 12 });\n  return pages.filter((p) => p.ok);\n}\n```"
    : "";
  const list = i % 6 === 3 ? "\n\n- First finding with a [link](https://example.com/a)\n- Second finding\n- Third finding, slightly longer than the others" : "";
  const table = i % 25 === 5 ? "\n\n| Metric | Before | After |\n|---|---|---|\n| p95 | 120 ms | 40 ms |\n| Long tasks | 9 | 1 |" : "";
  return `Response ${i}. ${PARAGRAPH.repeat((i % 5) + 1)}${code}${list}${table}`;
}

async function conversationWith(userId: string, key: string, data: { title: string; projectId?: string; agentId?: string }) {
  return prisma.conversation.upsert({
    where: { userId_clientRequestId: { userId, clientRequestId: key } },
    update: { title: data.title, projectId: data.projectId ?? null, agentId: data.agentId ?? null },
    create: { userId, clientRequestId: key, titleSource: "manual", ...data },
  });
}

async function fill(conversationId: string, count: number, prefix: string) {
  await prisma.message.deleteMany({ where: { conversationId } });
  const start = Date.UTC(2026, 8, 1);
  const rows = Array.from({ length: count }, (_, i) => ({
    conversationId,
    clientId: `${prefix}-${i}`,
    role: i % 2 ? ("ASSISTANT" as const) : ("USER" as const),
    model: i % 2 ? "anthropic:claude-sonnet-5" : undefined,
    content: encryptMessageText(
      i % 2 ? assistantBody(i) : `Question ${i}: ${i === 42 ? "perf-anchor-42 " : ""}how does the transcript keep its place while work continues?`,
    ),
    createdAt: new Date(start + i * 60_000),
  }));
  for (let i = 0; i < rows.length; i += 500) await prisma.message.createMany({ data: rows.slice(i, i + 500) });
}

async function main() {
  const user = await prisma.user.findUniqueOrThrow({ where: { email: EMAIL } });
  const project = await prisma.project.upsert({
    where: { userId_importSourceId: { userId: user.id, importSourceId: "perf-project" } },
    update: { name: "Perf project" },
    create: { userId: user.id, name: "Perf project", importSourceId: "perf-project", instructions: "Benchmark project." },
  });
  const projectChat = await conversationWith(user.id, "perf-project-chat", { title: "Perf project chat", projectId: project.id });
  await fill(projectChat.id, 12, "perf-project");

  // A realistic sidebar: forty ordinary chats with a few turns each.
  for (let n = 0; n < 40; n++) {
    const c = await conversationWith(user.id, `perf-sidebar-${n}`, { title: `Sidebar chat ${n}` });
    await fill(c.id, 4, `perf-sidebar-${n}`);
  }

  const long = await conversationWith(user.id, "perf-long-1000", { title: "Long conversation (1,000 messages)" });
  await fill(long.id, 1000, "perf-long");

  const agents: string[] = [];
  for (const [n, name] of ["Perf Scout", "Perf Analyst"].entries()) {
    const existing = await prisma.agent.findFirst({ where: { userId: user.id, name, deletedAt: null } });
    const agent = existing ?? await prisma.agent.create({ data: { userId: user.id, name, role: "Benchmark agent", sortOrder: n } });
    const thread = await conversationWith(user.id, `perf-agent-${n}`, { title: name, agentId: agent.id });
    await prisma.agent.update({ where: { id: agent.id }, data: { conversationId: thread.id } });
    await fill(thread.id, 30, `perf-agent-${n}`);
    agents.push(agent.id);
  }

  console.log(JSON.stringify({ projectId: project.id, projectChatId: projectChat.id, longConversationId: long.id, agentIds: agents }));
}

main().finally(() => prisma.$disconnect());
