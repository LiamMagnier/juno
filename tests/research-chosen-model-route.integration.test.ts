import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/*
 * THE MODEL CHOSEN IN THE COMPOSER LEADS THE WEB'S DEEP RESEARCH, THROUGH THE
 * REAL CHAT ROUTE, AGAINST POSTGRES.
 *
 * The report (2026-10-10): with Gemini 3.5 Flash-Lite at Low selected, a web
 * research turn parked at the plan gate and its card read "Led by Claude
 * Fable 5.1 · Researchers on Claude Haiku 5.5" — the Auto pair. The web's
 * in-chat path (`runDeepResearch`, src/lib/chat/turn/research-stage.ts) never
 * passed the chat's model, so the plan had no `preferredLead` and the planner,
 * sizing and every stage after them chose as if the person had picked Auto.
 * Only the apps' background hand-off carried it.
 *
 * Proven here, through POST /api/chat and the scope card's Start:
 *  - the run records the chosen model as its preferred lead, and its depth
 *    derives from that model and its effort;
 *  - the planner drafts on it, strictly (no second model behind it);
 *  - Start sizes the run on it: the envelope's lead and researchers are it;
 *  - a chosen model the plan cannot use is never swapped in silence: the
 *    envelope records it and the run card says so in words.
 *
 * Stand-ins: the session, the providers' keys, the chat model, the search
 * backend's availability, the planner's model call and the background
 * driver; a fetch tripwire proves nothing leaves the process. Skipped unless
 * RESEARCH_TEST_DATABASE_URL names a throwaway loopback database (setup as in
 * tests/research-handoff-route.integration.test.ts):
 *
 *   RESEARCH_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:<port>/juno_research_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/research-chosen-model-route.integration.test.ts
 */

const DB_URL = process.env.RESEARCH_TEST_DATABASE_URL;

if (!DB_URL) {
  test("research chosen-model route suite is skipped without RESEARCH_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  const url = new URL(DB_URL);
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error("The research chosen-model suite needs a loopback PostgreSQL.");
  }
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "research-chosen-model-test-secret";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });

  const planned: Array<{ leadModel: string | null; preferredLead: string | null }> = [];
  const drives: string[] = [];
  const outbound: string[] = [];
  /** Providers whose key is "removed" mid-test; every other provider is configured. */
  const unconfigured = new Set<string>();

  const GEMINI = "google:gemini-3.5-flash-lite";

  test("stand in for the session, the keys, the model, the search backend, the planner and the driver", async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      const target = input instanceof Request ? input.url : String(input);
      outbound.push(target);
      throw new Error(`unexpected network call to ${target}`);
    };
    const server = await import("next/server");
    mock.module("next/server", { namedExports: { ...server, after: () => {} } });
    const providers = await import("@/lib/providers");
    mock.module("@/lib/providers", {
      namedExports: {
        ...providers,
        isProviderConfigured: (provider: string) => !unconfigured.has(provider),
        configuredProviders: () => providers.PROVIDER_LIST.filter((provider) => !unconfigured.has(provider)),
      },
    });
    const llm = await import("@/lib/llm");
    mock.module("@/lib/llm", {
      namedExports: {
        ...llm,
        streamChat: async function* () {
          yield { type: "text", text: "Here is the plan." };
          yield { type: "finish", reason: "stop" };
        },
      },
    });
    const engine = await import("@/lib/search/search-engine");
    mock.module("@/lib/search/search-engine", { namedExports: { ...engine, isSearchEngineAvailable: () => true } });
    // The planner's model call: what it was asked to run on is the point.
    const tools = await import("@/lib/research/tools");
    mock.module("@/lib/research/tools", {
      namedExports: {
        ...tools,
        draftResearchPlanWithModel: async (input: { leadModel?: string | null; preferredLead?: string | null }) => {
          planned.push({ leadModel: input.leadModel ?? null, preferredLead: input.preferredLead ?? null });
          return {
            ok: true,
            costMicroUsd: 0,
            output: {
              title: "Heat pumps in Nordic winters",
              approach: "Manufacturer data, field trials and national energy agencies.",
              questions: [
                { question: "How does COP fall at -20C?", rationale: "The core figure.", evidence: { minSources: 2, primary: true } },
                { question: "What do field trials in Norway report?", rationale: "Real installs.", evidence: { minSources: 2, primary: true } },
                { question: "Which defrost strategies matter most?", rationale: "Winter losses.", evidence: { minSources: 2, primary: false } },
              ],
              clarifications: [],
              sources: [],
              queries: ["heat pump COP -20C", "Norway heat pump field trial", "heat pump defrost cycle losses"],
              scope: { breadth: "broad", freshness: "any", primarySources: true, quick: false },
              language: "en",
            },
          };
        },
      },
    });
    const run = await import("@/lib/research/run");
    mock.module("@/lib/research/run", {
      namedExports: {
        ...run,
        driveResearchInBackground: (input: { runId: string }) => {
          drives.push(input.runId);
        },
      },
    });
  });

  type Frame = { type: string; [key: string]: unknown };
  const framesOf = (text: string): Frame[] =>
    text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as Frame);

  async function chat(body: Record<string, unknown>) {
    const route = await import("@/app/api/chat/route");
    const res = await route.POST(
      new Request("http://alevr.test/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );
    const text = await res.text();
    assert.equal(res.status, 200, text.slice(0, 400));
    return framesOf(text);
  }

  async function start(runId: string, body: Record<string, unknown> = { decision: "confirm" }) {
    const route = await import("@/app/api/research/[id]/plan/route");
    return route.POST(
      new Request(`http://alevr.test/api/research/${runId}/plan`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id: runId }) }
    );
  }

  async function view(runId: string) {
    const route = await import("@/app/api/research/[id]/route");
    const res = await route.GET(new Request(`http://alevr.test/api/research/${runId}`), { params: Promise.resolve({ id: runId }) });
    assert.equal(res.status, 200);
    return (await res.json()) as { run: { models: import("@/types/research").ResearchRunModels | null } };
  }

  async function seed(plan: "PRO" | "MAX") {
    const suffix = `${Date.now()}-${randomBytes(4).toString("hex")}`;
    const user = await prisma.user.create({
      data: { email: `research-chosen-${suffix}@example.invalid`, name: "Chosen-model tester", emailVerified: new Date() },
    });
    await prisma.subscription.create({ data: { userId: user.id, plan, status: "ACTIVE" } });
    signedIn = { id: user.id, email: user.email, name: user.name! };
    return user;
  }

  const QUESTION = "How do heat pumps cope with Nordic winters?";

  test("Gemini 3.5 Flash-Lite at Low, chosen in the web composer, plans and sizes the whole run", async () => {
    const user = await seed("PRO");
    const before = planned.length;
    const frames = await chat({ message: QUESTION, deepResearch: true, model: GEMINI, reasoningEffort: "low", timeZone: "Europe/Oslo", locale: "en-GB" });
    const done = frames.find((frame) => frame.type === "done") as (Frame & { message: { content: string } }) | undefined;
    assert.ok(done, `a finished turn: ${frames.map((frame) => frame.type).join(", ")}`);
    assert.match(done.message.content, /research plan/i, "parked at the plan gate, as in the report");

    const run = await prisma.researchRun.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(run.state, "awaiting_plan_confirmation");
    const plan = run.plan as { preferredLead?: string; effort?: string; timeZone?: string };
    assert.equal(plan.preferredLead, GEMINI, "the chosen model is the run's preferred lead");
    assert.equal(plan.timeZone, "Europe/Oslo");
    // The run's depth derives from the chosen model and its effort, not Auto's.
    const { researchEffortFor } = await import("@/lib/research/auto-effort");
    const { getModel } = await import("@/lib/models");
    assert.equal(plan.effort, researchEffortFor({ cost: getModel(GEMINI)!.cost, reasoningEffort: "low", proMode: false }));

    assert.deepEqual(planned.slice(before), [{ leadModel: GEMINI, preferredLead: GEMINI }], "the plan is drafted on the chosen model, strictly");

    const res = await start(run.id);
    assert.equal(res.status, 200, await res.clone().text());
    const confirmed = await prisma.researchRun.findUniqueOrThrow({ where: { id: run.id } });
    const envelope = (confirmed.plan as { envelope?: { leadModel?: string; workerModel?: string; chosen?: boolean; workerNote?: string; chosenRefused?: unknown } }).envelope;
    assert.ok(envelope, "Start froze an envelope");
    assert.equal(envelope.leadModel, GEMINI, "led by the chosen model, not the plan class's strongest");
    assert.equal(envelope.workerModel, GEMINI, "researchers on the chosen model: it calls tools");
    assert.equal(envelope.chosen, true);
    assert.equal(envelope.workerNote, undefined);
    assert.equal(envelope.chosenRefused, undefined);
    assert.ok(drives.includes(run.id), "handed to the driver after Start");

    const { run: dto } = await view(run.id);
    assert.equal(dto.models?.lead.id, GEMINI);
    assert.equal(dto.models?.chosen, true);
    const { modelsLine } = await import("@/components/research/research-view");
    assert.deepEqual(modelsLine(dto.models, false), [{ parts: [{ phrase: "Running on" }, { kind: "label", value: "Gemini 3.5 Flash-Lite" }] }]);
  });

  test("a chosen model whose provider is gone by Start is never swapped in silence: the run card says so", async () => {
    const user = await seed("PRO");
    await chat({ message: QUESTION, deepResearch: true, model: GEMINI, reasoningEffort: "low" });
    const run = await prisma.researchRun.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal((run.plan as { preferredLead?: string }).preferredLead, GEMINI);

    // The deployment loses its Google key while the plan waits at the card.
    unconfigured.add("google");
    try {
      const res = await start(run.id);
      assert.equal(res.status, 200, await res.clone().text());
      const envelope = ((await prisma.researchRun.findUniqueOrThrow({ where: { id: run.id } })).plan as {
        envelope?: { leadModel?: string; chosen?: boolean; chosenRefused?: { model: string; reason: string } };
      }).envelope;
      assert.ok(envelope);
      assert.notEqual(envelope.leadModel, GEMINI, "the run still goes, on the Auto pair");
      assert.notEqual(envelope.chosen, true);
      assert.deepEqual(envelope.chosenRefused, { model: GEMINI, reason: "not_configured" }, "and records whose choice it replaced, and why");

      const { run: dto } = await view(run.id);
      assert.deepEqual(dto.models?.chosenRefused, { model: { id: GEMINI, label: "Gemini 3.5 Flash-Lite" }, reason: "not_configured" });
      const { modelsLine } = await import("@/components/research/research-view");
      const line = modelsLine(dto.models, false)!;
      assert.deepEqual(line[0], { parts: [{ kind: "label", value: "Gemini 3.5 Flash-Lite" }, { phrase: "isn't available right now" }] });
      assert.deepEqual(line[1].parts[0], { phrase: "Led by" });
    } finally {
      unconfigured.delete("google");
    }
  });

  test("a model chosen when the plan is confirmed in chat replaces the one recorded at start", async () => {
    const user = await seed("PRO");
    const frames = await chat({ message: QUESTION, deepResearch: true, model: "juno:auto" });
    const conversationId = frames.find((frame) => frame.type === "meta")!.conversationId as string;
    const run = await prisma.researchRun.findFirstOrThrow({ where: { userId: user.id } });
    assert.equal(run.state, "awaiting_plan_confirmation");
    assert.equal((run.plan as { preferredLead?: string }).preferredLead, undefined, "Auto records no choice");
    // "yes" on the background path, whose driver is a stand-in: the
    // confirmation is what is under test, not the investigation after it.
    const reply = await chat({ message: "yes", deepResearch: true, model: GEMINI, conversationId, clientFeatures: ["timeline", "resume", "research_background"] });
    assert.equal(reply[reply.length - 1].type, "handoff");
    const confirmed = await prisma.researchRun.findUniqueOrThrow({ where: { id: run.id } });
    const plan = confirmed.plan as { preferredLead?: string; envelope?: { leadModel?: string; chosen?: boolean } };
    assert.equal(plan.preferredLead, GEMINI);
    assert.equal(plan.envelope?.leadModel, GEMINI);
    assert.equal(plan.envelope?.chosen, true);
  });

  test("nothing left the process", () => {
    assert.deepEqual(outbound, []);
  });

  test("disconnect", async () => {
    await prisma.$disconnect();
    const { prismaUnguarded } = await import("@/lib/prisma");
    await prismaUnguarded.$disconnect().catch(() => undefined);
  });
}
