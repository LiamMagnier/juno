import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

/*
 * A CONVERSATION EDITS AN EXISTING WORKBOOK, DOCUMENT OR DECK INCREMENTALLY
 * (BRIEF §29–30), through the real route handlers against Postgres:
 *
 *   POST /api/chat creates a SPREADSHEET artifact from the model's JSON;
 *   the next turn's <juno:artifact-ops> raises one assumption and the server
 *   applies it to the CURRENT version — one cell changes, dependents recompute;
 *   the model saw the outline of that version in its system prompt;
 *   undo is a restore of v1 as a new version;
 *   a person's edit through POST /api/artifacts/:id/ops makes the next model
 *   edit wait as a suggestion, which Apply turns into a version;
 *   GET /api/artifacts/:id/export?format=xlsx|docx|pptx serves a file that
 *   reopens with the edit in it.
 *
 * Skipped unless SEMANTIC_TEST_DATABASE_URL names a throwaway database:
 *
 *   SEMANTIC_TEST_DATABASE_URL=postgresql://…/juno_deliverables_test \
 *   NODE_OPTIONS=--conditions=react-server \
 *   npx tsx --test --experimental-test-module-mocks tests/semantic-artifact-chat.integration.test.ts
 */

const DB_URL = process.env.SEMANTIC_TEST_DATABASE_URL;

if (!DB_URL) {
  test("semantic artifact chat suite is skipped without SEMANTIC_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "semantic-artifact-test-secret";

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });

  const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });
  const request = (method: string, body?: unknown, url = "http://alevr.test/api") =>
    new Request(url, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  let nextAnswer = "";
  const systemPrompts: string[] = [];
  test("stand in for the session and the model", async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      throw new Error(`unexpected network call to ${input instanceof Request ? input.url : String(input)}`);
    };
    const server = await import("next/server");
    mock.module("next/server", { namedExports: { ...server, after: () => {} } });
    const providers = await import("@/lib/providers");
    mock.module("@/lib/providers", {
      namedExports: {
        ...providers,
        isProviderConfigured: () => true,
        configuredProviders: () => [...providers.PROVIDER_LIST],
      },
    });
    const llm = await import("@/lib/llm");
    mock.module("@/lib/llm", {
      namedExports: {
        ...llm,
        streamChat: async function* (args: { system?: string }) {
          systemPrompts.push(typeof args?.system === "string" ? args.system : JSON.stringify(args).slice(0, 200_000));
          yield { type: "text", text: nextAnswer };
          yield { type: "usage", input: 12, output: nextAnswer.length };
          yield { type: "finish", reason: "stop" };
        },
      },
    });
  });

  async function signUp() {
    const user = await prisma.user.create({
      data: { email: `semantic-${Date.now()}-${Math.random().toString(16).slice(2)}@example.invalid`, name: "Semantic", emailVerified: new Date() },
    });
    await prisma.subscription.create({ data: { userId: user.id, plan: "PRO", status: "ACTIVE" } });
    signedIn = { id: user.id, email: user.email!, name: user.name! };
    return user;
  }

  async function say(conversationId: string | undefined, message: string, answer: string) {
    nextAnswer = answer;
    const chat = await import("@/app/api/chat/route");
    const res = await chat.POST(request("POST", { ...(conversationId ? { conversationId } : {}), message }));
    const body = await res.text();
    assert.equal(res.status, 200, body.slice(0, 400));
    const frames = body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; [key: string]: unknown });
    const done = frames.find((frame) => frame.type === "done") as
      | { message: { id: string; content: string; conversationId?: string }; artifacts: { id: string; identifier: string; currentVersion: number }[] }
      | undefined;
    assert.ok(done, `done frame; got ${frames.map((f) => f.type).join(",")}: ${JSON.stringify(frames.find((f) => f.type === "error"))}`);
    const row = await prisma.message.findUnique({ where: { id: done.message.id }, select: { conversationId: true } });
    return { done, conversationId: row!.conversationId };
  }

  const growthBody = {
    title: "Growth model",
    names: { conversion: "Assumptions!$B$3" },
    sheets: [
      {
        name: "Assumptions",
        rows: [
          ["Input", "Value"],
          ["Visitors", { v: 120000, fmt: "integer" }],
          ["Conversion", { v: 0.05, fmt: "percent" }],
          ["Order value", { v: 48, fmt: "currency" }],
        ],
      },
      {
        name: "Model",
        rows: [
          ["Month", "Orders", "Revenue"],
          ["Jan", { f: "=ROUND(Assumptions!B2*conversion,0)" }, { f: "=B2*Assumptions!$B$4", fmt: "currency" }],
          ["Feb", { f: "=ROUND(Assumptions!B2*1.04*conversion,0)" }, { f: "=B3*Assumptions!$B$4", fmt: "currency" }],
          ["Total", { f: "=SUM(B2:B3)" }, { f: "=SUM(C2:C3)", fmt: "currency" }],
        ],
        charts: [{ type: "column", title: "Revenue", categories: "A2:A3", series: [{ name: "Revenue", values: "C2:C3" }] }],
      },
    ],
  };

  const tag = (identifier: string, type: string, title: string, body: unknown) =>
    `Here it is.\n\n<juno:artifact identifier="${identifier}" type="${type}" title="${title}">${JSON.stringify(body)}</juno:artifact>`;
  const opsTag = (identifier: string, summary: string, ops: unknown[]) =>
    `<juno:artifact-ops identifier="${identifier}">${JSON.stringify({ summary, ops })}</juno:artifact-ops>`;

  async function versions(artifactId: string) {
    return prisma.artifactVersion.findMany({ where: { artifactId }, orderBy: { version: "asc" } });
  }

  test("a chat creates a workbook, edits one assumption incrementally, undoes it, and exports it", async () => {
    await signUp();
    const first = await say(undefined, "Build me a growth model", tag("growth-model", "SPREADSHEET", "Growth model", growthBody));
    const artifact = await prisma.artifact.findFirstOrThrow({ where: { conversationId: first.conversationId, identifier: "growth-model" } });
    assert.equal(artifact.type, "SPREADSHEET");
    const v1 = (await versions(artifact.id))[0];
    const stored1 = JSON.parse(v1.content);
    assert.equal(stored1.kind, "spreadsheet");
    assert.equal(stored1.sheets[1].cells.B2.f, "ROUND(Assumptions!B2*conversion,0)", "stored canonically");

    // Turn two: the model sees the outline and edits with ONE operation.
    systemPrompts.length = 0;
    const second = await say(
      first.conversationId,
      "Increase conversion assumption to 7.5% and update the charts",
      `Done.\n\n${opsTag("growth-model", "Raised the conversion assumption to 7.5%", [
        { op: "setCell", sheet: "Assumptions", cell: "conversion", value: 0.075 },
      ])}`
    );
    assert.ok(systemPrompts.some((p) => p.includes("Editable spreadsheets, documents and decks") && p.includes("C2: =B2*Assumptions!$B$4 → 288000")), "the model was given the current outline");
    const after = await versions(artifact.id);
    assert.deepEqual(after.map((v) => [v.version, v.origin]), [[1, "generated"], [2, "generated"]]);
    const stored2 = JSON.parse(after[1].content);
    const changed: string[] = [];
    stored2.sheets.forEach((sheet: { name: string; cells: Record<string, unknown> }, i: number) => {
      const old = stored1.sheets[i].cells as Record<string, unknown>;
      for (const key of new Set([...Object.keys(sheet.cells), ...Object.keys(old)])) {
        if (JSON.stringify(sheet.cells[key]) !== JSON.stringify(old[key])) changed.push(`${sheet.name}!${key}`);
      }
    });
    assert.deepEqual(changed, ["Assumptions!B3"], "one stored cell changed; formulas and the chart follow from it");
    assert.match(second.done.message.content, /Raised the conversion assumption to 7\.5%/);
    assert.doesNotMatch(second.done.message.content, /juno:artifact-ops/, "the saved message carries the result, not the ops");

    // The export reopens with the dependents recomputed.
    const exportRoute = await import("@/app/api/artifacts/[id]/export/route");
    const xlsx = await exportRoute.GET(request("GET", undefined, `http://alevr.test/api/artifacts/${artifact.id}/export?format=xlsx`), params({ id: artifact.id }));
    assert.equal(xlsx.status, 200, await xlsx.clone().text().catch(() => ""));
    const { readWorkbookXlsx } = await import("@/lib/work/deliverables/semantic/workbook/xlsx");
    const { WorkbookEngine } = await import("@/lib/work/deliverables/semantic/workbook/engine");
    const reopened = await readWorkbookXlsx(Buffer.from(await xlsx.arrayBuffer()));
    assert.equal(new WorkbookEngine(reopened.model).value("Model", "C2"), 432000);
    assert.equal(reopened.model.sheets[1].charts.length, 1);

    // Undo: restore v1 as a new version (history is never rewritten).
    const artifactRoute = await import("@/app/api/artifacts/[id]/route");
    const undo = await artifactRoute.POST(request("POST", { content: v1.content, baseVersion: 2, origin: "restore" }), params({ id: artifact.id }));
    assert.equal(undo.status, 200);
    const afterUndo = await versions(artifact.id);
    assert.deepEqual(afterUndo.map((v) => v.origin), ["generated", "generated", "restore"]);
    assert.equal(JSON.parse(afterUndo[2].content).sheets[0].cells.B3.v, 0.05);

    // A person's edit through the ops route…
    const opsRoute = await import("@/app/api/artifacts/[id]/ops/route");
    const stale = await opsRoute.POST(request("POST", { baseVersion: 2, ops: [{ op: "setCell", sheet: "Assumptions", cell: "B4", value: 50 }] }), params({ id: artifact.id }));
    assert.equal(stale.status, 409, "a moved head refuses the person's ops");
    const bad = await opsRoute.POST(request("POST", { baseVersion: 3, ops: [{ op: "setFormula", sheet: "Model", cell: "B2", formula: "=B4" }] }), params({ id: artifact.id }));
    assert.equal(bad.status, 422, "a cycle is refused");
    assert.equal((await bad.json()).code, "cycle");
    const edited = await opsRoute.POST(request("POST", { baseVersion: 3, ops: [{ op: "setCell", sheet: "Assumptions", cell: "B4", value: 50 }] }), params({ id: artifact.id }));
    assert.equal(edited.status, 200);
    const editedBody = (await edited.json()) as { recalculated: string[]; chartsChanged: string[] };
    assert.deepEqual(new Set(editedBody.recalculated), new Set(["model!C2", "model!C3", "model!C4"]));
    assert.deepEqual(editedBody.chartsChanged, ["ch1"]);
    assert.equal((await versions(artifact.id)).at(-1)?.origin, "edit");

    // …so the model's next edit waits as a suggestion instead of landing over it.
    await say(
      first.conversationId,
      "Make visitors 150k",
      opsTag("growth-model", "Set visitors to 150,000", [{ op: "setCell", sheet: "Assumptions", cell: "B2", value: 150000 }])
    );
    assert.equal((await versions(artifact.id)).length, 4, "no version: it is held");
    const proposal = await prisma.artifactProposal.findFirstOrThrow({ where: { artifactId: artifact.id, status: "PENDING" } });
    const applyRoute = await import("@/app/api/artifacts/[id]/proposals/[proposalId]/apply/route");
    const applied = await applyRoute.POST(request("POST", { baseVersion: 4 }), params({ id: artifact.id, proposalId: proposal.id }));
    assert.equal(applied.status, 200);
    const final = JSON.parse((await versions(artifact.id)).at(-1)!.content);
    assert.equal(final.sheets[0].cells.B2.v, 150000);
    assert.equal(final.sheets[0].cells.B4.v, 50, "the person's edit survives the applied suggestion");
  });

  test("a failing ops block changes nothing and says so", async () => {
    await signUp();
    const first = await say(undefined, "Model", tag("m", "SPREADSHEET", "M", growthBody));
    const artifact = await prisma.artifact.findFirstOrThrow({ where: { conversationId: first.conversationId, identifier: "m" } });
    const turn = await say(first.conversationId, "break it", opsTag("m", "x", [{ op: "setCell", sheet: "Nope", cell: "A1", value: 1 }]));
    assert.match(turn.done.message.content, /Couldn't apply that edit to “M”: Operation 1: There is no sheet named "Nope"/);
    assert.equal((await versions(artifact.id)).length, 1);
  });

  test("documents and decks are created, edited by operation and exported", async () => {
    await signUp();
    const doc = {
      title: "Q3 review",
      blocks: [
        { type: "heading", level: 1, text: "Q3 review" },
        { type: "paragraph", text: "Revenue grew." },
        { type: "paragraph", text: "Costs held." },
      ],
    };
    const first = await say(undefined, "Write a review", tag("q3", "DOCUMENT", "Q3 review", doc));
    const docRow = await prisma.artifact.findFirstOrThrow({ where: { conversationId: first.conversationId, identifier: "q3" } });
    assert.equal(docRow.type, "DOCUMENT");
    const docV1 = JSON.parse((await versions(docRow.id))[0].content);
    const target = docV1.blocks[1].id as string;
    await say(
      first.conversationId,
      "Suggest a sharper second paragraph and comment on the costs",
      opsTag("q3", "Suggested a sharper line and left a comment", [
        { op: "suggestRevision", blockId: target, kind: "replace", text: "Revenue grew **18%**." },
        { op: "comment", blockId: docV1.blocks[2].id, text: "Source?" },
      ])
    );
    const docV2 = JSON.parse((await versions(docRow.id)).at(-1)!.content);
    assert.equal(docV2.blocks[1].text, "Revenue grew.", "a suggestion does not change the block");
    assert.equal(docV2.revisions.length, 1);
    assert.equal(docV2.comments.length, 1);
    assert.deepEqual(docV2.blocks.map((b: { id: string }) => b.id), docV1.blocks.map((b: { id: string }) => b.id));

    const exportRoute = await import("@/app/api/artifacts/[id]/export/route");
    const docx = await exportRoute.GET(request("GET", undefined, `http://alevr.test/x?format=docx`), params({ id: docRow.id }));
    assert.equal(docx.status, 200);
    const { readDocumentDocx } = await import("@/lib/work/deliverables/semantic/document/docx-export");
    const reopenedDoc = await readDocumentDocx(Buffer.from(await docx.arrayBuffer()));
    assert.equal(reopenedDoc.revisions.filter((r) => r.status === "pending").length, 1);
    assert.equal(reopenedDoc.comments[0].text, "Source?");

    const deck = {
      title: "Launch",
      slides: [
        { layout: "title", title: "Launch", subtitle: "Q4" },
        { layout: "title-content", title: "Plan", elements: [{ type: "text", paragraphs: [{ text: "Ship", bullet: true }] }] },
        { layout: "title-content", title: "Numbers", elements: [{ type: "chart", chartType: "column", categories: ["Q1", "Q2"], series: [{ name: "Users", values: [10, 14] }] }] },
      ],
    };
    const deckTurn = await say(first.conversationId, "Make a deck", tag("launch", "PRESENTATION", "Launch", deck));
    void deckTurn;
    const deckRow = await prisma.artifact.findFirstOrThrow({ where: { conversationId: first.conversationId, identifier: "launch" } });
    const deckV1 = JSON.parse((await versions(deckRow.id))[0].content);
    const chartSlide = deckV1.slides[2];
    await say(
      first.conversationId,
      "Q2 was 18",
      opsTag("launch", "Updated the chart", [
        { op: "updateChart", slideId: chartSlide.id, elementId: chartSlide.elements[0].id, series: [{ name: "Users", values: [10, 18] }] },
      ])
    );
    const deckV2 = JSON.parse((await versions(deckRow.id)).at(-1)!.content);
    assert.deepEqual(deckV2.slides.slice(0, 2), deckV1.slides.slice(0, 2), "the other slides are untouched");
    assert.deepEqual(deckV2.slides[2].elements[0].series[0].values, [10, 18]);
    const pptx = await exportRoute.GET(request("GET", undefined, `http://alevr.test/x?format=pptx`), params({ id: deckRow.id }));
    assert.equal(pptx.status, 200);
    const { readDeckPptx } = await import("@/lib/work/deliverables/semantic/deck/pptx-export");
    const readback = await readDeckPptx(Buffer.from(await pptx.arrayBuffer()));
    assert.equal(readback.slideCount, 3);
    assert.deepEqual(readback.slides[2].chartData[0].series[0].values, [10, 18]);
  });

  test("close the database", async () => {
    await prisma.$disconnect();
  });
}
