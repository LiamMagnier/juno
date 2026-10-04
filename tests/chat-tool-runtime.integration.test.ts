import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { chatTurnSource, turnModule } from "./chat-turn-source";

/*
 * THE TOOL CONTRACT THROUGH POST /api/chat (TOOL_RUNTIME_DESIGN §7 L1, V5–V7).
 *
 * Drives the real route against Postgres with only the session, the model and
 * the tool providers stood in:
 *
 *   - an untested model gets the plain-language note and no execution tool,
 *     even with a healthy execution provider installed, and the note names a
 *     verified model when there is one;
 *   - a verified model on a paid plan carries run_code and check_run from the
 *     exec provider, with the provider's prompt section and no note;
 *   - a running call's live row carries its phase and progress, and the saved
 *     row keeps the call id, the typed outcome and the run, never the phase;
 *   - an earlier tool-using answer reaches the model with its history note,
 *     inside the envelope, and the untrusted-content rule turns on with it;
 *   - a transport probe's write keeps the tool round-trip evidence.
 *
 * The source checks always run. The database suite needs a throwaway database
 * and never falls back to DATABASE_URL:
 *
 *   createdb juno_tool_test   (or any throwaway Postgres)
 *   DATABASE_URL=… DIRECT_URL=… npx prisma migrate deploy
 *   TOOL_TEST_DATABASE_URL=… NODE_OPTIONS=--conditions=react-server \
 *     npx tsx --test --experimental-test-module-mocks tests/chat-tool-runtime.integration.test.ts
 */


test("the route decides execution tools from the entitlement rows and the verified verdict", () => {
  const route = chatTurnSource();
  // Bound to the adapter this turn uses: Pro mode moves an OpenAI model onto Responses.
  assert.match(route, /const toolCallingVerdict = modelToolCallingVerdict\(modelInfo, capabilityProbes, new Date\(\), \{ proMode: useProMode \}\);/);
  assert.match(route, /const execution = executionEntitlements\(\{/);
  assert.match(route, /attachmentToolToggles\.code = execution\.legacyCodeInterpreter;/);
  // The granted execution specs, then Alevr Search's bound tools (BRIEF §15).
  assert.match(
    route,
    /toolSpecs:\s*\(toolProviderSessions\?\.specs\.length \?\? 0\) \+ \(alevrSearchTurn\?\.specs\.length \?\? 0\) > 0\s*\? \[\.\.\.\(toolProviderSessions\?\.specs \?\? \[\]\), \.\.\.\(alevrSearchTurn\?\.specs \?\? \[\]\)\]\s*: undefined,/,
  );
  assert.match(route, /toolWatch\?\.observe\(ev\);/);
  assert.match(turnModule("run-turn"), /pumpTurnStream\(modelStream, \{[\s\S]*?toolWatch,/);
  // Providers hear of a skill only once it APPLIED (blocked, unscanned and
  // consent-pending skills are not armed), never the slug the request named.
  const toolTurn = route.slice(route.indexOf("const toolTurn: ToolTurn = {"), route.indexOf("const execution = executionEntitlements({"));
  assert.match(toolTurn, /skillSlug: appliedSkill\?\.candidate\.slug \?\? null,/);
  assert.doesNotMatch(toolTurn, /turnSkillSlug/);
  // One capability snapshot per request: routing and tools read the same rows.
  assert.equal(route.match(/loadModelCapabilityMap\(/g)?.length, 1);
});

const DB_URL = process.env.TOOL_TEST_DATABASE_URL;

if (!DB_URL) {
  test("tool runtime route suite is skipped without TOOL_TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  process.env.DATABASE_URL = DB_URL;
  process.env.DIRECT_URL = DB_URL;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  delete process.env.DATA_ENCRYPTION_KEYRING;
  process.env.AUTH_SECRET ??= "tool-runtime-test-secret";
  delete process.env.CODE_INTERPRETER_URL;
  delete process.env.CODE_INTERPRETER_TOKEN;
  delete process.env.E2B_API_KEY;

  const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const MODEL = "claude-sonnet-5";
  /** Capability rows are keyed by the canonical catalog id ("anthropic:claude-sonnet-5"). */
  const catalogId = async (id: string) => (await import("@/lib/models")).getModel(id)!.id;

  let signedIn: { id: string; email: string; name: string } | null = null;
  mock.module("@/lib/session", { namedExports: { getCurrentUser: async () => signedIn } });

  const request = (body: unknown) =>
    new Request("http://juno.test/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  type Captured = {
    system: string;
    history: Array<{ role: string; content: string }>;
    toolSpecs?: Array<{ id: string }>;
    allowedTools?: string[];
  };
  const captured: Captured[] = [];
  let script: unknown[] = [];
  let execAvailable = true;
  const outbound: string[] = [];

  const RUN = {
    runId: "run_1",
    context: "hosted_sandbox",
    language: "python",
    status: "succeeded",
    exitCode: 0,
    durationMs: 2400,
    files: [{ attachmentId: "att_chart", name: "chart.png", mime: "image/png", bytes: 1234 }],
  };
  const TOOL_SCRIPT = [
    { type: "tool", phase: "call", server: "Alevr Runtime", name: "run_code", callId: "toolu_1", args: '{"code":"print(6*7)"}', round: 0, index: 0 },
    { type: "tool", phase: "status", server: "Alevr Runtime", name: "run_code", callId: "toolu_1", status: "queued" },
    { type: "tool", phase: "status", server: "Alevr Runtime", name: "run_code", callId: "toolu_1", status: "running", timeoutMs: 130_000 },
    { type: "tool", phase: "progress", server: "Alevr Runtime", name: "run_code", callId: "toolu_1", progress: { lines: [{ stream: "stdout", text: "computing" }], stdoutBytes: 10 } },
    { type: "tool", phase: "result", server: "Alevr Runtime", name: "run_code", callId: "toolu_1", args: '{"code":"print(6*7)"}', result: "42", ok: true, status: "succeeded", run: RUN, durationMs: 2400 },
    { type: "text", text: "It is 42." },
    { type: "usage", input: 20, output: 6 },
    { type: "finish", reason: "stop" },
  ];
  const TEXT_SCRIPT = [
    { type: "text", text: "Done." },
    { type: "usage", input: 12, output: 2 },
    { type: "finish", reason: "stop" },
  ];

  test("stand in for the session, the model and the tool providers", async () => {
    globalThis.fetch = async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      outbound.push(url);
      throw new Error(`unexpected network call to ${url}`);
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
        streamChat: async function* (opts: Captured) {
          captured.push({
            system: opts.system,
            history: opts.history.map((m) => ({ role: m.role, content: m.content })),
            toolSpecs: opts.toolSpecs?.map((spec) => ({ id: spec.id })),
            allowedTools: opts.allowedTools,
          });
          for (const event of script) yield event;
        },
      },
    });
    const toolProviderModule = await import("@/lib/tools/providers");
    const { defineTool } = await import("@/lib/tools/types");
    const spec = (id: string) =>
      defineTool({
        id,
        title: id,
        description: `${id} for tests`,
        input: { type: "object", properties: { code: { type: "string", description: "Code." } } },
        risk: "read",
        parallelSafe: false,
        timeoutMs: 130_000,
        broker: "juno_runtime",
        dedupe: true,
        execute: async () => ({ status: "succeeded", text: "", body: "" }),
      });
    mock.module("@/lib/tools/providers", {
      namedExports: {
        ...toolProviderModule,
        toolProviders: () => [
          {
            id: "exec",
            tools: ["run_code", "check_run"],
            availability: async () => (execAvailable ? { available: true } : { available: false, reason: "not_configured" }),
            open: async (_turn: unknown, granted: readonly string[]) => ({
              specs: granted.map(spec),
              promptSection: "Running code: you have run_code (test sandbox, no internet).",
            }),
          },
        ],
      },
    });
  });

  async function signUp(label: string, plan: "FREE" | "PRO") {
    const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const user = await prisma.user.create({
      data: { email: `tool-runtime-${label}-${suffix}@example.invalid`, name: "Tool runtime", emailVerified: new Date() },
    });
    if (plan !== "FREE") await prisma.subscription.create({ data: { userId: user.id, plan, status: "ACTIVE" } });
    signedIn = { id: user.id, email: user.email!, name: user.name! };
    return user;
  }

  async function verify(id: string) {
    const modelId = await catalogId(id);
    const now = new Date();
    // Evidence names the adapter it was gathered through, and only verifies a
    // turn that runs through the same one (model-tool-probe.ts).
    const { providerAdapterFor } = await import("@/lib/provider-routing");
    const { getModel } = await import("@/lib/models");
    const tools = {
      probeVersion: 2,
      verdict: "verified",
      checkedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      adapter: providerAdapterFor(getModel(id)!),
      checks: { roundTrip: "passed", parallel: "passed", toolImage: "skipped" },
    };
    await prisma.modelCapabilityProbe.upsert({
      where: { modelId },
      create: {
        modelId,
        provider: "test",
        status: "passed",
        probeVersion: 2,
        evidence: { probeVersion: 2, tools },
        checkedAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
      },
      update: { evidence: { probeVersion: 2, tools }, status: "passed", expiresAt: new Date(now.getTime() + 86_400_000) },
    });
  }

  async function unverifyAll() {
    await prisma.modelCapabilityProbe.deleteMany({});
  }

  async function send(body: Record<string, unknown>, events: unknown[]) {
    script = events;
    const chatRoute = await import("@/app/api/chat/route");
    const res = await chatRoute.POST(request({ model: MODEL, ...body }));
    const text = await res.text();
    assert.equal(res.status, 200, `the turn is accepted: ${text.slice(0, 400)}`);
    const frames = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string; [key: string]: unknown });
    const done = frames.find((frame) => frame.type === "done") as { message: { id: string }; conversationId?: string } | undefined;
    assert.ok(done, `the stream settles; got ${frames.map((f) => f.type).join(", ")}`);
    return { frames, done, turn: captured.at(-1)! };
  }

  test("an untested model gets the limitation note and no execution tool, even with a healthy sandbox", async () => {
    await unverifyAll();
    execAvailable = true;
    await signUp("untested", "PRO");
    const { turn } = await send({ message: "Run this Python and tell me the result." }, TEXT_SCRIPT);
    assert.equal(turn.toolSpecs, undefined, "no run_code, no check_run");
    assert.ok(!(turn.allowedTools ?? []).includes("code_interpreter"));
    assert.match(turn.system, /tool calling has not been verified for this model/);
    assert.doesNotMatch(turn.system, /switching to/, "no verified model exists yet to name");
    assert.doesNotMatch(turn.system, /you have run_code/);

    await verify("gemini-3.8-flash");
    const again = await send({ message: "And this one?" }, TEXT_SCRIPT);
    assert.match(again.turn.system, /switching to Gemini 3\.8 Flash will let it run/);
  });

  test("a verified model on a paid plan carries run_code and check_run from the exec provider", async () => {
    await unverifyAll();
    await verify(MODEL);
    execAvailable = true;
    await signUp("verified", "PRO");
    const { turn } = await send({ message: "Compute 6 times 7 in Python." }, TEXT_SCRIPT);
    assert.deepEqual(turn.toolSpecs?.map((s) => s.id), ["run_code", "check_run"]);
    assert.match(turn.system, /you have run_code \(test sandbox, no internet\)/);
    assert.doesNotMatch(turn.system, /not been verified/);
    assert.doesNotMatch(turn.system, /you cannot run code/);
  });

  test("FREE never reaches the model; with the sandbox down, the turn carries no tool and is told so", async () => {
    await unverifyAll();
    await verify(MODEL);
    execAvailable = true;
    // Every model needs a paid plan: FREE is refused at the paywall before
    // any turn — and so any tool — is built.
    await signUp("free", "FREE");
    const before = captured.length;
    script = TEXT_SCRIPT;
    const chatRoute = await import("@/app/api/chat/route");
    const refused = await chatRoute.POST(request({ model: MODEL, message: "Compute 6 times 7 in Python." }));
    assert.equal(refused.status, 402);
    assert.equal(((await refused.json()) as { code?: string }).code, "PLAN_REQUIRED");
    assert.equal(captured.length, before, "no model turn was built for FREE");

    execAvailable = false;
    await signUp("down", "PRO");
    const down = await send({ message: "Compute 6 times 7 in Python." }, TEXT_SCRIPT);
    assert.equal(down.turn.toolSpecs, undefined);
    assert.match(down.turn.system, /you cannot run code in this chat/);
    execAvailable = true;
  });

  test("the live row carries phase and progress; the saved row keeps the outcome and run, never the phase", async () => {
    await unverifyAll();
    await verify(MODEL);
    await signUp("live", "PRO");
    const { frames, done } = await send({ message: "Compute 6 times 7 in Python." }, TOOL_SCRIPT);
    const toolRows = frames
      .filter((f) => f.type === "activity")
      .map((f) => (f as unknown as { event: { kind: string; tool?: Record<string, unknown> } }).event)
      .filter((e) => e.kind === "tool" && e.tool);
    assert.ok(toolRows.some((e) => e.tool!.phase === "running" && e.tool!.timeoutMs === 130_000), "the running phase went live");
    assert.ok(
      toolRows.some((e) => JSON.stringify(e.tool!.progress) === JSON.stringify({ lines: [{ stream: "stdout", text: "computing" }], stdoutBytes: 10 })),
      "the progress frame went live",
    );
    const last = toolRows.at(-1)!.tool!;
    assert.equal(last.outcome, "succeeded");
    assert.equal(last.callId, "toolu_1");
    assert.equal(last.phase, undefined);
    assert.equal(last.progress, undefined);

    const { decryptJsonField } = await import("@/lib/field-crypto");
    const saved = await prisma.message.findUnique({ where: { id: done.message.id } });
    const activity = decryptJsonField(saved!.activity) as Array<{ kind: string; tool?: Record<string, unknown> }>;
    const row = activity.find((e) => e.kind === "tool")!;
    assert.equal(row.tool!.callId, "toolu_1");
    assert.equal(row.tool!.outcome, "succeeded");
    assert.deepEqual((row.tool!.run as { files: Array<{ name: string }> }).files.map((f) => f.name), ["chart.png"]);
    assert.equal(row.tool!.phase, undefined);
  });

  test("an earlier tool-using answer reaches the model with its note, enveloped", async () => {
    await unverifyAll();
    await verify(MODEL);
    await signUp("notes", "PRO");
    const first = await send({ message: "Compute 6 times 7 in Python." }, TOOL_SCRIPT);
    const conversationId = (first.frames.find((f) => f.type === "conversation") as { conversation?: { id: string } } | undefined)?.conversation?.id
      ?? (await prisma.message.findUnique({ where: { id: first.done.message.id } }))!.conversationId;
    const { turn } = await send({ conversationId, message: "Now double it." }, TEXT_SCRIPT);
    const assistant = turn.history.find((m) => m.role === "ASSISTANT")!;
    assert.match(assistant.content, /tools used in this earlier turn/);
    assert.match(assistant.content, /- run_code python → exit 0, 1 file: chart\.png/);
    assert.ok(assistant.content.endsWith("It is 42."), "the persisted answer follows the note");
    const { UNTRUSTED_CONTENT_RULE } = await import("@/lib/untrusted-content");
    assert.ok(turn.system.includes(UNTRUSTED_CONTENT_RULE.slice(0, 60)), "the rule that reads the envelope is on");
  });

  test("a transport probe's write keeps the tool round-trip evidence", async () => {
    await unverifyAll();
    await verify(MODEL);
    const { persistModelCapabilityProbe, modelToolCallingVerdict, loadModelCapabilityMap } = await import("@/lib/model-capability");
    const now = new Date();
    const modelId = await catalogId(MODEL);
    await persistModelCapabilityProbe({
      modelId,
      provider: "anthropic",
      status: "passed",
      checkedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      detail: null,
      evidence: { probeVersion: 2, httpStatus: 200 },
    });
    const probes = await loadModelCapabilityMap([modelId]);
    assert.equal((probes.get(modelId)!.evidence as { httpStatus?: number }).httpStatus, 200);
    assert.equal(modelToolCallingVerdict({ id: modelId, provider: "anthropic", api: undefined }, probes), "verified");
  });

  test("nothing left the process", async () => {
    assert.deepEqual(outbound, []);
    await prisma.$disconnect();
  });
}
