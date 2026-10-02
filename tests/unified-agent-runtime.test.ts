import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { UnifiedAgentRegistry, detectAutomaticEscalation, openUnifiedAgentToolset } from "../src/lib/agent/runtime";
import { browserPageBody } from "../src/lib/agent/browser";
import {
  BROWSER_TOOL_ID,
  CODE_INTERPRETER_TOOL_ID,
  INSPECT_IMAGE_TOOL_ID,
  READ_DOCUMENT_TOOL_ID,
  chatRuntimeToolAllowlist,
} from "../src/lib/chat/tool-policy";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "../src/lib/untrusted-content";

test("UnifiedAgentRegistry exposes only hosted-safe tools and emits valid provider schemas", () => {
  const registry = new UnifiedAgentRegistry();

  assert.equal(registry.getTool("python_interpreter"), undefined);
  assert.ok(registry.getTool("browser_agent"));
  assert.equal(registry.getTool("computer_use"), undefined);

  // The two attachment tools are registered but, like the browser tool, are
  // only ever ATTACHED by an explicit allowlist — see the tests below.
  assert.ok(registry.getTool(READ_DOCUMENT_TOOL_ID));
  assert.ok(registry.getTool(INSPECT_IMAGE_TOOL_ID));
  assert.ok(registry.getTool(CODE_INTERPRETER_TOOL_ID));

  const schemas = registry.toProviderToolSchemas();
  assert.deepEqual(schemas.map((schema) => schema.function.name), [
    "browser_agent",
    READ_DOCUMENT_TOOL_ID,
    INSPECT_IMAGE_TOOL_ID,
    CODE_INTERPRETER_TOOL_ID,
  ]);
  // Every registered tool must carry an object schema with properties, or the
  // stricter providers reject the whole request rather than the one tool.
  for (const schema of schemas) {
    assert.equal((schema.function.parameters as { type?: string }).type, "object");
    assert.ok((schema.function.parameters as { properties?: object }).properties);
  }
});

/*
 * The registry is built at module load, so anything `server-only` in a tool's
 * STATIC import graph takes the whole registry down outside a react-server
 * runtime — which is how this very file first failed. Both attachment tools
 * therefore reach Prisma, storage and the rasteriser through `await import()`
 * inside `execute`. This pins that, because the symptom is far away from the
 * cause.
 */
test("the attachment tools keep server-only modules out of the registry's graph", () => {
  for (const file of ["document", "image"]) {
    const source = readFileSync(new URL(`../src/lib/agent/${file}.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /^import "server-only";/m, `${file}.ts must not import server-only`);
    assert.doesNotMatch(
      source,
      /^import \{[^}]*\} from "@\/lib\/(prisma|storage|media\/raster|agent\/attachments|knowledge\/documents)"/m,
      `${file}.ts must reach its server-only deps through a dynamic import`,
    );
  }
});

test("an explicit empty allowlist is treated as no hosted native tools", () => {
  const runtime = readFileSync(new URL("../src/lib/agent/runtime.ts", import.meta.url), "utf8");
  assert.match(runtime, /Array\.isArray\(options\?\.allowedToolIds\)/);
  assert.doesNotMatch(runtime, /allowedToolIds\.length > 0/);
});

test("detectAutomaticEscalation identifies data analysis, research, and work queries", () => {
  const dataQuery = detectAutomaticEscalation("Can you load this CSV and plot a chart using matplotlib?");
  assert.equal(dataQuery.recommendedMode, "data");
  assert.ok(!dataQuery.suggestedTools.includes("python_interpreter"));

  const researchQuery = detectAutomaticEscalation("Conduct deep research comparing all MacBook Pro M-series processors");
  assert.equal(researchQuery.recommendedMode, "research");
  assert.ok(researchQuery.suggestedTools.includes("browser_agent"));

  const workQuery = detectAutomaticEscalation("Create a plan and generate deliverable presentation slides for the roadmap");
  assert.equal(workQuery.recommendedMode, "work");
  assert.ok(workQuery.suggestedTools.includes("work_plan"));

  const normalQuery = detectAutomaticEscalation("Hello, what is the capital of France?");
  assert.equal(normalQuery.recommendedMode, undefined);
  assert.equal(normalQuery.suggestedTools.length, 0);
});

/*
 * H1 regression: the browser tool was attached to every saved chat turn.
 *
 * `openUnifiedAgentToolset` reads an ABSENT allowlist as "every registered
 * tool", and the chat route never passed one — so `browser_agent` (risk class
 * read_only, which the approval broker auto-allows) rode along on every turn
 * with no toggle. The chat route now derives the allowlist from the request's
 * feature toggles and `streamChat` defaults it to empty.
 */

const agentContext = {
  userId: "user-1",
  sessionId: "gen-1",
  mode: "chat" as const,
  environment: "server_sandbox" as const,
};

test("a saved chat with no connectors and no web toggle attaches zero tools", async () => {
  const toolset = await openUnifiedAgentToolset([], agentContext, {
    allowedToolIds: chatRuntimeToolAllowlist({ webSearch: false }),
  });
  try {
    assert.equal(toolset.tools.length, 0);
  } finally {
    await toolset.close();
  }
});

test("switching web access on is what attaches the browser tool", async () => {
  const allow = chatRuntimeToolAllowlist({ webSearch: true });
  assert.deepEqual(allow, [BROWSER_TOOL_ID]);
  const toolset = await openUnifiedAgentToolset([], agentContext, { allowedToolIds: allow });
  try {
    assert.deepEqual(toolset.tools.map((t) => t.function.name), [BROWSER_TOOL_ID]);
  } finally {
    await toolset.close();
  }
});

/*
 * The attachment tools ride the attachments, not a user-facing toggle — but
 * each one still rides its OWN condition. A turn carrying a PDF must not be
 * handed the image inspector on a model that cannot see, and a turn carrying
 * only a photo must not be handed the document reader: both would spend a
 * round discovering there is nothing for them to do.
 */
test("each attachment tool is attached only by its own condition", async () => {
  assert.deepEqual(chatRuntimeToolAllowlist({ webSearch: false }), []);
  assert.deepEqual(chatRuntimeToolAllowlist({ webSearch: false, documents: true }), [
    READ_DOCUMENT_TOOL_ID,
  ]);
  assert.deepEqual(chatRuntimeToolAllowlist({ webSearch: false, images: true }), [
    INSPECT_IMAGE_TOOL_ID,
  ]);
  assert.deepEqual(
    chatRuntimeToolAllowlist({ webSearch: true, documents: true, images: true, code: true }),
    [BROWSER_TOOL_ID, READ_DOCUMENT_TOOL_ID, INSPECT_IMAGE_TOOL_ID, CODE_INTERPRETER_TOOL_ID],
  );

  const toolset = await openUnifiedAgentToolset([], agentContext, {
    allowedToolIds: chatRuntimeToolAllowlist({ webSearch: false, documents: true }),
  });
  try {
    assert.deepEqual(toolset.tools.map((t) => t.function.name), [READ_DOCUMENT_TOOL_ID]);
    // Read-only, so the approval broker lets it through without a prompt —
    // which is exactly why the allowlist above has to be the narrow gate.
    assert.equal(toolset.accessFor(READ_DOCUMENT_TOOL_ID), "read");
  } finally {
    await toolset.close();
  }
});

test("streamChat never forwards an absent allowlist to the registry", () => {
  // The registry's "undefined = everything" contract is kept (the test above
  // this file pins it), so the opt-in default has to live in streamChat.
  const llm = readFileSync(new URL("../src/lib/llm.ts", import.meta.url), "utf8");
  assert.match(llm, /allowedToolIds: opts\.allowedTools \?\? \[\.\.\.NO_RUNTIME_TOOLS\]/);
  const route = readFileSync(new URL("../src/app/api/chat/route.ts", import.meta.url), "utf8");
  // The allowlist is still built from the turn's own toggles and is still
  // always an array. It is now wrapped by the skill narrowing, which filters
  // this list and can only ever return a subset of it — so the property this
  // test exists for ("the route never forwards `undefined`") is unchanged, and
  // the shape is pinned in a way that would notice the wrapper being swapped
  // for something that computes the list itself.
  assert.match(
    route,
    /allowedTools: narrowRuntimeToolsForSkill\(\s*chatRuntimeToolAllowlist\(\{\s*webSearch: useWebSearch,\s*\.\.\.attachmentToolToggles,\s*\}\),\s*appliedSkill,?\s*\)/,
  );
});

test("a fetched page reaches the model whole, with its closing marker", () => {
  // The old body was `wrapUntrusted(...).slice(0, 1000)`: the cut landed inside
  // the envelope, so the closing marker never arrived and 15,000 extracted
  // chars became 1,000 delivered ones.
  const page = "x".repeat(15_000);
  const body = browserPageBody("https://example.com/page", page);
  assert.ok(body.startsWith(`${UNTRUSTED_OPEN} source=https://example.com/page`));
  assert.ok(body.endsWith(UNTRUSTED_CLOSE));
  assert.ok(body.includes(page), "the whole page must be delivered, not a prefix");

  const browser = readFileSync(new URL("../src/lib/agent/browser.ts", import.meta.url), "utf8");
  assert.doesNotMatch(browser, /defendedContent\.slice\(/);
});

/*
 * THE SAFETY INVARIANT, AND IT IS THE ONE WORTH A TEST OF ITS OWN.
 *
 * `UnifiedCodeInterpreter.execute` falls back to `sandbox/python.ts` — a child
 * process on THIS host — whenever no remote sandbox answers. The code this
 * tool runs is written by a model reading documents supplied by strangers, so
 * that fallback would turn a prompt injection inside a PDF into arbitrary
 * execution beside the provider keys and every other tenant's files. The tool
 * therefore calls the microVM adapter directly and is not offered at all when
 * none is configured.
 */
test("model-written code never runs on this host", async () => {
  const source = readFileSync(new URL("../src/lib/agent/code.ts", import.meta.url), "utf8");

  /*
   * Checked on what the file IMPORTS, not on what it mentions: the header
   * names `sandbox/python.ts` precisely in order to explain why it is never
   * used, and a test that cannot tell an explanation from a dependency fails
   * on its own documentation.
   */
  const imports = source
    .split("\n")
    .filter((line) => /(^import |await import\()/.test(line))
    .join("\n");
  assert.doesNotMatch(imports, /UnifiedCodeInterpreter|codeInterpreter\b/, "the falling-back wrapper");
  assert.doesNotMatch(imports, /sandbox\/python|LocalIsolatedSandboxAdapter|executePythonSandbox/, "the host subprocess");
  // Only the remote backend, and never a preference that could fall back to one.
  assert.match(imports, /MicroVMSandboxAdapter/);
  assert.doesNotMatch(source, /preferredBackend/);

  const { isCodeInterpreterConfigured } = await import("../src/lib/agent/code");
  const url = process.env.CODE_INTERPRETER_URL;
  const token = process.env.CODE_INTERPRETER_TOKEN;
  const e2b = process.env.E2B_API_KEY;
  try {
    delete process.env.CODE_INTERPRETER_URL;
    delete process.env.CODE_INTERPRETER_TOKEN;
    delete process.env.E2B_API_KEY;
    assert.equal(isCodeInterpreterConfigured(), false, "no sandbox means no capability");
    // An endpoint without a token is not a sandbox either.
    process.env.CODE_INTERPRETER_URL = "https://sandbox.example";
    assert.equal(isCodeInterpreterConfigured(), false);
    process.env.CODE_INTERPRETER_TOKEN = "t";
    assert.equal(isCodeInterpreterConfigured(), true);
  } finally {
    if (url === undefined) delete process.env.CODE_INTERPRETER_URL; else process.env.CODE_INTERPRETER_URL = url;
    if (token === undefined) delete process.env.CODE_INTERPRETER_TOKEN; else process.env.CODE_INTERPRETER_TOKEN = token;
    if (e2b === undefined) delete process.env.E2B_API_KEY; else process.env.E2B_API_KEY = e2b;
  }
});

/*
 * Uploads must not read files any more. The whole class of "COULDN'T READ THIS
 * FILE" came from an extractor that ran before anybody had asked anything and
 * whose verdict then stuck, so the ordering is the fix and deserves pinning:
 * a caller that re-adds eager ingest does not fail loudly, it just quietly
 * restores the old behaviour.
 */
test("a chat attachment is not read when it is uploaded", () => {
  const ingest = readFileSync(new URL("../src/lib/knowledge/index.ts", import.meta.url), "utf8");
  // The gate lives in scheduleIngest so no upload path can forget it.
  assert.match(ingest, /if \(!input\.projectId\) return;/);
  assert.match(ingest, /export async function ensureAttachmentText/);

  const upload = readFileSync(new URL("../src/app/api/upload/route.ts", import.meta.url), "utf8");
  assert.match(upload, /scheduleIngest\(/, "project files still index, through the same gate");

  const route = readFileSync(new URL("../src/app/api/chat/route.ts", import.meta.url), "utf8");
  assert.match(route, /await ensureAttachmentText\(/, "reading happens when the turn does");
});

/*
 * L1 review: which runtime calls may run beside others. Every registry tool
 * passes the broker, which asks about a read too under "Always ask", and two
 * approval cards at once break the stall watchdog (its pause is a flag); two
 * of the registry reads also load whole files into an 887 MB web process. So
 * registry tools are never parallel, and a provider spec is parallel only as
 * a pure, unbrokered read.
 */
test("registry tools run one at a time; only an unbrokered read spec runs in parallel", async () => {
  const { resolvedRegistryTool, resolvedSpecTool, specIsBrokered } = await import("../src/lib/agent/runtime");
  const registry = new UnifiedAgentRegistry();
  for (const tool of registry.listTools()) {
    assert.equal(resolvedRegistryTool(tool).parallelSafe, false, `${tool.id} must not run in parallel`);
  }
  const spec = {
    id: "read_skill_file",
    title: "Read a skill file",
    description: "Reads a file.",
    input: { type: "object" as const, properties: {} },
    risk: "read" as const,
    parallelSafe: true,
    timeoutMs: 1_000,
    broker: "none" as const,
    dedupe: true,
    execute: async () => ({ status: "succeeded" as const, text: "", body: "" }),
  };
  assert.equal(resolvedSpecTool(spec).parallelSafe, true);
  assert.equal(resolvedSpecTool({ ...spec, broker: "juno_runtime" }).parallelSafe, false, "a brokered read can ask a person");
  // A provider never waives its own authorisation: only a read may skip the broker.
  assert.equal(specIsBrokered(spec), false);
  assert.equal(specIsBrokered({ ...spec, risk: "write" }), true);
  assert.equal(specIsBrokered({ ...spec, risk: "destructive" }), true);
});
