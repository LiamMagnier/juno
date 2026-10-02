import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_TOOL_BUDGET,
  FINAL_ROUND_NOTE,
  LEGACY_TOOL_BUDGET,
  STRUCTURED_BUDGET,
  createLoopController,
  defaultLoopBudget,
  providerSearchCapFor,
  roundBudgetFor,
} from "@/lib/llm/loop";
import {
  callIdIssuer,
  legacyChatToolset,
  legacyToolRound,
  stampCallId,
  toolRoundRunner,
  undispatchedToolsetReason,
} from "@/lib/llm/tool-round";
import type { McpToolset, ToolExecution } from "@/lib/mcp";
import type { BatchContext, ToolCallInput } from "@/lib/tools/dispatch";
import type { ChatToolset } from "@/lib/tools/types";
import { wrapUntrusted } from "@/lib/untrusted-content";
import type { LlmEvent } from "@/types/llm";

/*
 * The policy every adapter's tool loop shares (SPEC §4.1, §4.3, §4.6): how many
 * provider requests a turn gets, when the last one is the tools-off one, which
 * id a call is known by, and which runner a round's calls go to. The adapters
 * are tested against a scripted transport in their own files; this pins the
 * pieces they all read.
 */

test("the loop modules stay free of server-only", () => {
  // SPEC §13 harness rule 1: `node_modules/server-only` throws under tsx.
  for (const file of ["src/lib/llm/loop.ts", "src/lib/llm/tool-round.ts", "src/lib/llm/types.ts"]) {
    assert.doesNotMatch(readFileSync(file, "utf8"), /^import "server-only";/m, file);
  }
});

// ── Budgets ───────────────────────────────────────────────────────────────────

test("the round budget scales with effort: 4 / 10 / 16 / 24 (DECISIONS T5)", () => {
  const table: Array<[Parameters<typeof roundBudgetFor>[0], number]> = [
    ["minimal", 4],
    ["low", 4],
    ["medium", 10],
    [null, 10],
    [undefined, 10],
    ["high", 16],
    ["xhigh", 24],
    ["max", 24],
  ];
  for (const [effort, budget] of table) assert.equal(roundBudgetFor(effort, false), budget, String(effort));
});

test("voice keeps its seven requests whatever the effort", () => {
  for (const effort of ["minimal", "low", "medium", "high", "max", null] as const) {
    assert.equal(roundBudgetFor(effort, true), 7);
  }
});

test("the budget counts provider requests, the final tools-off one included", () => {
  // Ten requests at the default: nine that may call tools, then the one that
  // may not. A turn whose model keeps calling tools makes exactly `budget`
  // requests and no more.
  const loop = createLoopController({ budget: roundBudgetFor("medium", false) });
  const finals: boolean[] = [];
  while (loop.requests < loop.budget) finals.push(loop.beginRequest().final);
  assert.equal(finals.length, 10);
  assert.deepEqual(finals.slice(0, 9), Array(9).fill(false));
  assert.equal(finals[9], true);
  assert.equal(loop.finalReason, "rounds");
});

test("a spend-guard or search-cap verdict makes the next request the last", () => {
  const loop = createLoopController({ budget: 16 });
  loop.beginRequest();
  loop.beginRequest();
  assert.equal(loop.nextIsFinal(), false);
  loop.requestFinal("budget");
  assert.equal(loop.nextIsFinal(), true);
  assert.deepEqual(loop.beginRequest(), { index: 2, final: true });
  assert.equal(loop.finalReason, "budget");
});

test("the provider-search cap follows the budget, voice counting as the default (SPEC §6.6)", () => {
  assert.equal(providerSearchCapFor(4), 3);
  assert.equal(providerSearchCapFor(7), 6);
  assert.equal(providerSearchCapFor(10), 6);
  assert.equal(providerSearchCapFor(16), 10);
  assert.equal(providerSearchCapFor(24), 16);
  // Never the round budget: at `max` that would be ~550 searches a turn.
  assert.ok(providerSearchCapFor(24) < 24);
});

test("a call with no loop of its own gets what its kind of call needs", () => {
  const none = { toolset: false, legacyTools: false, webSearch: false, structured: false };
  assert.equal(defaultLoopBudget(none), 1, "a plain completion is one request");
  assert.equal(defaultLoopBudget({ ...none, toolset: true }), DEFAULT_TOOL_BUDGET);
  assert.equal(DEFAULT_TOOL_BUDGET, 10);
  // The old toolset keeps today's six tool rounds and the forced final request.
  assert.equal(defaultLoopBudget({ ...none, legacyTools: true }), LEGACY_TOOL_BUDGET);
  assert.equal(LEGACY_TOOL_BUDGET, 7);
  // Provider search alone still needs requests: Claude's `pause_turn`.
  assert.equal(defaultLoopBudget({ ...none, webSearch: true }), LEGACY_TOOL_BUDGET);
  // A structured call: one answer, one corrective retry, whatever else is set.
  assert.equal(defaultLoopBudget({ ...none, structured: true, toolset: true }), STRUCTURED_BUDGET);
  assert.equal(STRUCTURED_BUDGET, 2);
});

test("the final-round note is one English line addressed to the model", () => {
  assert.match(FINAL_ROUND_NOTE, /^\[Juno: .*\]$/);
  assert.doesNotMatch(FINAL_ROUND_NOTE, /\n/);
});

// ── Call ids (SPEC §4.3) ──────────────────────────────────────────────────────

test("a call keeps the provider's id, or gets jc_<round>_<index> when it has none", () => {
  const none = new Set<string>();
  assert.equal(stampCallId("toolu_1", 0, 0, none), "toolu_1");
  assert.equal(stampCallId(undefined, 2, 1, none), "jc_2_1");
  assert.equal(stampCallId("", 3, 0, none), "jc_3_0");
});

test("a provider id seen before in the turn is suffixed, never reused", () => {
  // Kimi numbers `functions.<name>:<idx>` and several compat hosts restart
  // every response; a reused id would replay the broker's old receipt.
  const issue = callIdIssuer(new Set(["functions.search:0"]));
  assert.equal(issue("functions.search:0", 1, 0), "functions.search:0#1.0");
  assert.equal(issue("functions.fetch:1", 1, 1), "functions.fetch:1");
  // Two calls in one response carrying the same id still come out distinct.
  assert.equal(issue("dup", 2, 0), "dup");
  assert.equal(issue("dup", 2, 1), "dup#2.1");
  assert.equal(issue(undefined, 2, 2), "jc_2_2");
});

// ── Which runner a round's calls go to ────────────────────────────────────────

function fakeToolset(execute: McpToolset["execute"]): McpToolset {
  return {
    tools: [
      { type: "function", function: { name: "github__list_issues", description: "List issues", parameters: { type: "object", properties: {} } } },
      { type: "function", function: { name: "github__close_issue", description: "Close an issue", parameters: { type: "object", properties: {} } } },
    ],
    labelFor: () => "GitHub",
    accessFor: (name) => (name.includes("list") ? "read" : "write"),
    execute,
    close: async () => undefined,
  };
}

async function drain<R>(gen: AsyncGenerator<LlmEvent, R>): Promise<{ events: LlmEvent[]; value: R }> {
  const events: LlmEvent[] = [];
  for (;;) {
    const step = await gen.next();
    if (step.done) return { events, value: step.value };
    events.push(step.value);
  }
}

const call = (over: Partial<ToolCallInput> = {}): ToolCallInput => ({
  name: "github__list_issues",
  callId: "toolu_1",
  providerCallId: "toolu_1",
  round: 0,
  index: 0,
  argsText: '{"repo":"juno"}',
  ...over,
});

test("no toolset, or an empty one, means no runner", () => {
  assert.equal(toolRoundRunner({}), null);
  const empty = legacyChatToolset({ ...fakeToolset(async () => ({ text: "", body: "", ok: true })), tools: [] });
  assert.equal(toolRoundRunner({ toolset: empty }), null);
});

test("an opened toolset without its batch context is refused, never run around the dispatcher", () => {
  const executed: string[] = [];
  const legacy = legacyChatToolset(
    fakeToolset(async (name) => {
      executed.push(name);
      return { text: "", body: "", ok: true };
    }),
  );
  // A toolset the route opened: the same shape, but not the self-authorising wrapper.
  const opened: ChatToolset = { ...legacy };
  assert.throws(() => toolRoundRunner({ toolset: opened }), /without its batch context/);
  assert.equal(executed.length, 0);
  assert.match(undispatchedToolsetReason({ toolset: opened, dispatches: true }) ?? "", /batch context/);

  // With its batch, only an adapter that dispatches may take it.
  const batch = { seenCallIds: new Set<string>() } as unknown as NonNullable<Parameters<typeof toolRoundRunner>[0]["batch"]>;
  assert.equal(undispatchedToolsetReason({ toolset: opened, batch, dispatches: true }), null);
  assert.match(undispatchedToolsetReason({ toolset: opened, batch, dispatches: false }) ?? "", /dispatcher/);

  // The pre-rework toolset authorises inside execute, so it still runs without one.
  assert.ok(toolRoundRunner({ toolset: legacy }));
  assert.equal(undispatchedToolsetReason({ toolset: legacy, dispatches: false }), null);
  assert.equal(undispatchedToolsetReason({ dispatches: false }), null);
});

test("streamChat checks the toolset before anything is opened or sent", () => {
  // llm.ts is server-only (SPEC §13 harness rule 1), so this reads it as text.
  const source = readFileSync("src/lib/llm.ts", "utf8");
  const check = source.indexOf("undispatchedToolsetReason({ toolset: opts.toolset, batch: opts.batch");
  assert.ok(check > 0, "streamChat asks whether the toolset would skip the dispatcher");
  assert.ok(check < source.indexOf("openUnifiedAgentToolset(active"), "before the old toolset opens");
  assert.ok(check < source.indexOf("yield* streamAnthropic(request)"), "and before any adapter runs");
});

test("the opened toolset with its batch context goes to the dispatcher, with nextIsFinal stamped", async () => {
  const toolset = legacyChatToolset(fakeToolset(async () => ({ text: "", body: "", ok: true })));
  const batch = { seenCallIds: new Set<string>() } as unknown as NonNullable<Parameters<typeof toolRoundRunner>[0]["batch"]>;
  let seen: BatchContext | null = null;
  const runner = toolRoundRunner({ toolset, batch }, async function* (_calls, _signal, ctx) {
    seen = ctx;
    return [];
  });
  assert.ok(runner);
  await drain(runner([call()], new AbortController().signal, true));
  assert.ok(seen);
  const ctx = seen as BatchContext;
  assert.equal(ctx.toolset, toolset);
  assert.equal(ctx.nextIsFinal, true);
  assert.equal(ctx.seenCallIds, batch.seenCallIds);
});

test("the old toolset runs its calls in order and hands the model the ENVELOPED text (INV-30)", async () => {
  const executed: Array<{ name: string; args: Record<string, unknown>; callId?: string }> = [];
  const toolset = fakeToolset(async (name, args, _signal, callId) => {
    executed.push({ name, args, callId });
    const body = `issues for ${String(args.repo)}`;
    return { text: wrapUntrusted("GitHub", body), body, ok: true, durationMs: 12 } satisfies ToolExecution;
  });
  const { events, value } = await drain(
    legacyToolRound(toolset)(
      [call(), call({ name: "github__close_issue", callId: "toolu_2", providerCallId: "toolu_2", index: 1, argsText: '{"n":1}' })],
      new AbortController().signal,
      false,
    ),
  );
  assert.deepEqual(
    executed.map((e) => [e.name, e.callId]),
    [
      ["github__list_issues", "toolu_1"],
      ["github__close_issue", "toolu_2"],
    ],
  );
  assert.equal(value.length, 2);
  // The model gets the envelope; the panel gets the body.
  assert.equal(value[0].text, wrapUntrusted("GitHub", "issues for juno"));
  const results = events.filter((e): e is Extract<LlmEvent, { type: "tool"; phase: "result" }> => e.type === "tool" && e.phase === "result");
  assert.equal(results[0].result, "issues for juno");
  assert.equal(results[0].status, "succeeded");
  assert.equal(results[0].round, 0);
  assert.equal(results[0].index, 0);
  assert.equal(results[0].durationMs, 12);
  assert.equal(value[0].providerCallId, "toolu_1");
});

test("the old toolset's failures are results the model can read, and the last one carries the final note", async () => {
  const toolset = fakeToolset(async () => ({ text: "Denied by you.", body: "Denied by you.", ok: false, status: "denied", error: { code: "denied" } }));
  const { events, value } = await drain(legacyToolRound(toolset)([call()], new AbortController().signal, true));
  assert.equal(value[0].isError, true);
  assert.equal(value[0].errorCode, "denied");
  assert.equal(value[0].text, `Denied by you.\n\n${FINAL_ROUND_NOTE}`);
  const result = events.find((e) => e.type === "tool" && e.phase === "result");
  assert.ok(result && result.type === "tool" && result.phase === "result");
  assert.equal(result.ok, false);
  assert.equal(result.status, "denied");
  assert.deepEqual(result.error, { code: "denied" });
});

test("the old toolset seen through the new contract resolves every tool as a connector tool", () => {
  const chat: ChatToolset = legacyChatToolset(fakeToolset(async () => ({ text: "", body: "", ok: true })));
  const read = chat.resolve("github__list_issues");
  assert.equal(read?.origin, "connector");
  assert.equal(read?.risk, "read");
  assert.equal(chat.resolve("github__close_issue")?.risk, "external");
  assert.equal(chat.resolve("nope"), undefined);
  assert.equal(chat.labelFor("github__list_issues"), "GitHub");
});
