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
import { chatTurnSource } from "./chat-turn-source";

test("UnifiedAgentRegistry exposes only hosted-safe tools and emits valid provider schemas", () => {
  const registry = new UnifiedAgentRegistry();

  assert.equal(registry.getTool("python_interpreter"), undefined);
  // The page reader left chat before the broker began trusting declared risk
  // (DECISIONS §4b); `web_fetch` replaces it through the chat toolset.
  assert.equal(registry.getTool(BROWSER_TOOL_ID), undefined);
  assert.equal(registry.getTool("computer_use"), undefined);

  // The attachment tools are registered but only ever ATTACHED by an explicit
  // allowlist — see the tests below.
  assert.ok(registry.getTool(READ_DOCUMENT_TOOL_ID));
  assert.ok(registry.getTool(INSPECT_IMAGE_TOOL_ID));
  assert.ok(registry.getTool(CODE_INTERPRETER_TOOL_ID));

  const schemas = registry.toProviderToolSchemas();
  assert.deepEqual(schemas.map((schema) => schema.function.name), [
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

test("switching web access on no longer attaches the retired page reader", async () => {
  // Web tools arrive through the chat toolset (`web_search`, `web_fetch`), not
  // through this runtime; even a stale allowlist naming it attaches nothing.
  const allow = chatRuntimeToolAllowlist({ webSearch: true });
  assert.deepEqual(allow, []);
  const toolset = await openUnifiedAgentToolset([], agentContext, { allowedToolIds: [BROWSER_TOOL_ID] });
  try {
    assert.deepEqual(toolset.tools.map((t) => t.function.name), []);
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
    [READ_DOCUMENT_TOOL_ID, INSPECT_IMAGE_TOOL_ID, CODE_INTERPRETER_TOOL_ID],
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
  const route = chatTurnSource();
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
 * The code this tool runs is written by a model reading documents supplied by
 * strangers, so running it on THIS host would turn a prompt injection inside a
 * PDF into arbitrary execution beside the provider keys and every other
 * tenant's files. The old `UnifiedCodeInterpreter` fell back to exactly that (a
 * child process, `sandbox/python.ts`) whenever no remote sandbox answered. It
 * is retired: the tool is a bridge onto the hosted runtime (src/lib/exec),
 * which only speaks HTTP to the execution host, and with none configured the
 * tool is not offered at all.
 */
test("model-written code never runs on this host", async () => {
  const { existsSync, readdirSync } = await import("node:fs");
  assert.equal(existsSync(new URL("../src/lib/code-interpreter.ts", import.meta.url)), false, "the falling-back wrapper is gone");
  const sandbox = readFileSync(new URL("../src/lib/sandbox/python.ts", import.meta.url), "utf8");
  assert.doesNotMatch(sandbox, /child_process|spawn\(|execFile/, "no host executor remains");

  const source = readFileSync(new URL("../src/lib/agent/code.ts", import.meta.url), "utf8");
  const imports = source
    .split("\n")
    .filter((line) => /(^import |await import\()/.test(line))
    .join("\n");
  assert.doesNotMatch(imports, /sandbox\/python|code-interpreter/, "no path to a host subprocess");
  assert.match(imports, /@\/lib\/exec\/runtime/, "the hosted runtime only");

  // Nothing in the runtime can start a process here: it is an HTTP client.
  for (const file of readdirSync(new URL("../src/lib/exec/", import.meta.url))) {
    const text = readFileSync(new URL(`../src/lib/exec/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /from "node:child_process"|require\("child_process"\)/, `${file} must not spawn processes`);
  }

  const { isCodeInterpreterConfigured } = await import("../src/lib/agent/code");
  const saved = {
    url: process.env.CODE_INTERPRETER_URL,
    token: process.env.CODE_INTERPRETER_TOKEN,
    e2b: process.env.E2B_API_KEY,
    flag: process.env.TOOL_RUNTIME,
  };
  try {
    delete process.env.CODE_INTERPRETER_URL;
    delete process.env.CODE_INTERPRETER_TOKEN;
    process.env.E2B_API_KEY = "e2b-key-that-no-longer-counts-as-a-sandbox-000000";
    process.env.TOOL_RUNTIME = "1";
    assert.equal(isCodeInterpreterConfigured(), false, "no sandbox means no capability (an E2B key is not one)");
    process.env.CODE_INTERPRETER_URL = "https://exec.example";
    assert.equal(isCodeInterpreterConfigured(), false, "an endpoint without a token is not a sandbox");
    process.env.CODE_INTERPRETER_TOKEN = "short";
    assert.equal(isCodeInterpreterConfigured(), false, "a weak token is refused");
    process.env.CODE_INTERPRETER_TOKEN = "t".repeat(40);
    assert.equal(isCodeInterpreterConfigured(), true);
    process.env.CODE_INTERPRETER_URL = "http://exec.example";
    assert.equal(isCodeInterpreterConfigured(), false, "plain HTTP only to a loopback address");
    process.env.CODE_INTERPRETER_URL = "http://127.0.0.1:3178";
    assert.equal(isCodeInterpreterConfigured(), true);
    delete process.env.TOOL_RUNTIME;
    assert.equal(isCodeInterpreterConfigured(), false, "the owner's feature switch is required");
  } finally {
    for (const [name, value] of [["CODE_INTERPRETER_URL", saved.url], ["CODE_INTERPRETER_TOKEN", saved.token], ["E2B_API_KEY", saved.e2b], ["TOOL_RUNTIME", saved.flag]] as const) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
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

  const route = chatTurnSource();
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
