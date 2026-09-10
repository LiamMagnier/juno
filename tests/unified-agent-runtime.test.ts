import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { UnifiedAgentRegistry, detectAutomaticEscalation, openUnifiedAgentToolset } from "../src/lib/agent/runtime";
import { browserPageBody } from "../src/lib/agent/browser";
import { BROWSER_TOOL_ID, chatRuntimeToolAllowlist } from "../src/lib/chat/tool-policy";
import { UNTRUSTED_CLOSE, UNTRUSTED_OPEN } from "../src/lib/untrusted-content";

test("UnifiedAgentRegistry exposes only hosted-safe tools and emits valid provider schemas", () => {
  const registry = new UnifiedAgentRegistry();

  assert.equal(registry.getTool("python_interpreter"), undefined);
  assert.ok(registry.getTool("browser_agent"));
  assert.equal(registry.getTool("computer_use"), undefined);

  const schemas = registry.toProviderToolSchemas();
  assert.deepEqual(schemas.map((schema) => schema.function.name), ["browser_agent"]);
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

test("streamChat never forwards an absent allowlist to the registry", () => {
  // The registry's "undefined = everything" contract is kept (the test above
  // this file pins it), so the opt-in default has to live in streamChat.
  const llm = readFileSync(new URL("../src/lib/llm.ts", import.meta.url), "utf8");
  assert.match(llm, /allowedToolIds: opts\.allowedTools \?\? \[\.\.\.NO_RUNTIME_TOOLS\]/);
  const route = readFileSync(new URL("../src/app/api/chat/route.ts", import.meta.url), "utf8");
  assert.match(route, /allowedTools: chatRuntimeToolAllowlist\(\{ webSearch: useWebSearch \}\)/);
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
