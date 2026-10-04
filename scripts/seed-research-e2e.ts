/** Persisted UI fixtures for the local Research acceptance workflow.
 * This seeds no mock HTTP responses and refuses any non-local database.
 * Run after scripts/seed-e2e-user.ts with RESEARCH_E2E_SEED=1.
 */
import { PrismaClient } from "@prisma/client";
import { parsePlan } from "../src/lib/research/domain";

const url = new URL(process.env.DATABASE_URL ?? "");
if (process.env.RESEARCH_E2E_SEED !== "1" || !["127.0.0.1", "localhost"].includes(url.hostname)) {
  throw new Error("Research acceptance fixtures require an explicitly enabled local database.");
}
async function main() {
const db = new PrismaClient();
try {
  const user = await db.user.findUniqueOrThrow({ where: { email: "e2e@juno.test" } });
  const conversation = await db.conversation.upsert({
    where: { userId_clientRequestId: { userId: user.id, clientRequestId: "research-workspace-qa" } },
    create: { userId: user.id, clientRequestId: "research-workspace-qa", title: "Research workspace · QA fixtures" },
    update: {},
  });
  const questions = [
    { id: "qa-q1", question: "How does seasonal efficiency change below freezing?", status: "covered" },
    { id: "qa-q2", question: "How do independent field trials compare with laboratory ratings?", status: "partial" },
    { id: "qa-q3", question: "What does installation cost in France?", status: "thin" },
    { id: "qa-q4", question: "Which backup heating is needed, and when?", status: "pending" },
  ];
  const plan = parsePlan({
    title: "Heat pumps in cold climates", approach: "Compare field trials, manufacturer specifications and public energy guidance. This is an illustrative QA fixture, not a research conclusion.",
    objectives: questions, queries: ["cold climate heat pump field trials"], steps: questions.map(q => q.question),
    constraints: ["Illustrative local acceptance fixture"], pinnedSources: [], confirmed: true,
    pausedFrom: "investigating", pausedAt: new Date().toISOString(),
    coverage: [{ objectiveId: "qa-q1", requirementId: "qa-e1", status: "satisfied", supportingSourceIds: ["qa-s1"], independentSourceCount: 1, evidenceStrength: .7 }],
  });
  const run = await db.researchRun.upsert({
    where: { id: "qa-research-paused" },
    create: { id: "qa-research-paused", userId: user.id, conversationId: conversation.id, goal: "Compare heat pumps for cold climates using primary sources", state: "paused", plan: JSON.parse(JSON.stringify(plan)), costMicroUsd: 120000n, budgetMicroUsd: 1000000n },
    update: { state: "paused", plan: JSON.parse(JSON.stringify(plan)), error: null },
  });
  const items = [
    { id: "qa-s1", url: "https://www.energy.gov/energysaver/heat-pump-systems", title: "Heat pump systems · Department of Energy", read: true, sourceType: "official" },
    { id: "qa-s2", url: "https://www.iea.org/reports/the-future-of-heat-pumps", title: "The future of heat pumps · IEA", read: true, sourceType: "primary" },
    { id: "qa-s3", url: "https://www.ademe.fr/", title: "French energy guidance · ADEME", read: false, sourceType: "official" },
  ];
  for (const item of items) await db.researchSource.upsert({
    where: { id: item.id },
    create: { id: item.id, userId: user.id, runId: run.id, url: item.url, canonicalUrl: item.url, title: item.title, sourceType: item.sourceType, snapshot: item.read ? "Illustrative QA source snapshot. This content is not evidence for a published report." : null },
    update: {},
  });
  const events = [
    { kind: "state_changed", payload: { from: "planning", state: "investigating" } },
    { kind: "worker_spawned", payload: { workerId: "qa-worker", objective: "Independent field trials" } },
    { kind: "source_read", payload: { url: items[0].url, sourceId: items[0].id } },
    { kind: "worker_finished", payload: { workerId: "qa-worker" } },
    { kind: "state_changed", payload: { from: "investigating", state: "paused" } },
  ];
  for (const [index, event] of events.entries()) await db.researchEvent.upsert({
    where: { id: `qa-re-${index}` },
    create: { id: `qa-re-${index}`, userId: user.id, runId: run.id, seq: index + 1, ...event, createdAt: new Date(Date.now() - (events.length - index) * 20000) },
    update: {},
  });
  const completedPlan = parsePlan({ ...plan, title: "Heat pump evidence · QA report", summary: "Illustrative report for verifying the document and provenance workflow." });
  await db.researchRun.upsert({
    where: { id: "qa-research-complete" },
    create: { id: "qa-research-complete", userId: user.id, conversationId: conversation.id, goal: "Illustrative completed report", state: "completed", plan: JSON.parse(JSON.stringify(completedPlan)), report: "# Heat pump evidence\n\nThis is an illustrative local QA report. It is not a live research result.\n\n## What the evidence says\nThe document view keeps the question, findings and source links together.\n\n## What remains uncertain\nLive research quality requires a configured model and search provider and a separate evaluation.\n\n## Method\nThis fixture exercises actual database persistence, authenticated APIs, report rendering and reload recovery.", finishedAt: new Date() },
    update: {},
  });
  console.log(`Research QA conversation: /chat/${conversation.id}?researchRun=qa-research-paused`);
} finally { await db.$disconnect(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
