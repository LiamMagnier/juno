import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createSseSender, parseSseFrame } from "@/lib/chat-stream";
import { parseClientFeatures, WEB_CLIENT_FEATURES } from "@/lib/chat/client-features";
import { noticeRow, turnStartFacts, type TurnStartFactsInput } from "@/lib/chat/turn-start-facts";
import { sendRunActivity } from "@/lib/chat/turn-stream";
import { RUN_NOTICE_CODES } from "@/types/run";
import type { StreamChunk } from "@/types/chat";

/*
 * THE FACTS A TURN STARTS WITH (SPEC §2.12), and RC-3: a connector that failed
 * to connect says so, and "Connected tools ready" lists only the ones that
 * really connected.
 */

function input(overrides: Partial<TurnStartFactsInput> = {}): TurnStartFactsInput {
  return {
    features: parseClientFeatures([...WEB_CLIENT_FEATURES]),
    model: { key: "model", modelId: "anthropic:claude-opus", provider: "anthropic", label: "Anthropic · Claude Opus" },
    effort: { key: "effort", effort: "high", auto: false },
    context: { key: "context", historyMessages: 6, attachments: 1, projectFiles: 0 },
    connectors: null,
    tools: { key: "tools", offered: ["web_search", "web_fetch", "calculate"], nativeSearch: false, roundBudget: 16 },
    notices: [],
    ...overrides,
  };
}

test("the facts come in order, each with its legacy kind, title and detail (INV-7)", () => {
  const rows = turnStartFacts(input());
  assert.deepEqual(
    rows.map((row) => [row.fact?.key, row.kind, row.title, row.detail]),
    [
      ["model", "model", "Selected model", "Anthropic · Claude Opus"],
      ["effort", "reasoning", "Reasoning mode enabled", "High effort"],
      ["context", "context", "Reading the conversation context", "6 messages · 1 attachment"],
      ["tools", "context", "Tools ready", "web_search, web_fetch, calculate"],
    ]
  );
  assert.deepEqual(rows[3].fact, { key: "tools", offered: ["web_search", "web_fetch", "calculate"], nativeSearch: false, roundBudget: 16 });
});

test("the route's own legacy lines win where it has them; Auto thinking keeps its wording", () => {
  const rows = turnStartFacts(
    input({
      effort: { key: "effort", effort: "instant", auto: true },
      legacy: { modelDetail: "Auto chose Claude Sonnet", contextTitle: "Rebuilding the conversation context", contextDetail: "6 messages · 2 memories" },
      toolTitles: { web_search: "Web search", web_fetch: "Web page reader", calculate: "Calculator" },
    })
  );
  assert.equal(rows[0].detail, "Auto chose Claude Sonnet");
  assert.deepEqual([rows[1].title, rows[1].detail], ["Auto thinking", "Instant — no extra reasoning for this prompt"]);
  assert.deepEqual([rows[2].title, rows[2].detail], ["Rebuilding the conversation context", "6 messages · 2 memories"]);
  assert.equal(rows[3].detail, "Web search, Web page reader, Calculator");
  assert.equal(turnStartFacts(input({ effort: null })).some((row) => row.fact?.key === "effort"), false);
});

test("RC-3: 'Connected tools ready' lists only ready connectors; one warning per failed connector", () => {
  const rows = turnStartFacts(
    input({
      connectors: {
        key: "connectors",
        ready: [
          { id: "linear", label: "Linear", tools: 12 },
          { id: "notion", label: "Notion", tools: 8 },
        ],
        failed: [
          { id: "github", label: "GitHub", reason: "auth_expired" },
          { id: "slack", label: "Slack", reason: "timeout" },
        ],
      },
    })
  );
  const ready = rows.find((row) => row.fact?.key === "connectors")!;
  assert.equal(ready.kind, "tool");
  assert.equal(ready.title, "Connected tools ready");
  assert.equal(ready.detail, "Linear · Notion", "only the connectors that connected");
  const warnings = rows.filter((row) => row.notice?.code === "connector_unavailable");
  assert.deepEqual(
    warnings.map((row) => [row.kind, row.title, row.notice!.params]),
    [
      ["warning", "GitHub unavailable", { connector: "GitHub", reason: "auth_expired" }],
      ["warning", "Slack unavailable", { connector: "Slack", reason: "timeout" }],
    ]
  );
  // Order: the connectors fact and its warnings come after context, before tools.
  const keys = rows.map((row) => row.fact?.key ?? row.notice?.code);
  assert.deepEqual(keys, ["model", "effort", "context", "connectors", "connector_unavailable", "connector_unavailable", "tools"]);
});

test("RC-3: when nothing connected, the row never claims anything is ready", () => {
  const rows = turnStartFacts(
    input({ connectors: { key: "connectors", ready: [], failed: [{ id: "github", label: "GitHub", reason: "unreachable" }] } })
  );
  const fact = rows.find((row) => row.fact?.key === "connectors")!;
  assert.notEqual(fact.title, "Connected tools ready");
  assert.equal(rows.filter((row) => row.notice?.code === "connector_unavailable").length, 1);
  assert.equal(turnStartFacts(input({ connectors: { key: "connectors", ready: [], failed: [] } })).some((row) => row.fact?.key === "connectors"), false);
});

test("the context notices close the list, on kind:context", () => {
  const rows = turnStartFacts(input({ notices: [{ code: "web_off_lockdown" }, { code: "private_tools_limited" }, { code: "tools_capped", params: { offered: 64 } }] }));
  const tail = rows.slice(-3);
  assert.deepEqual(tail.map((row) => [row.notice!.code, row.kind]), [
    ["web_off_lockdown", "context"],
    ["private_tools_limited", "context"],
    ["tools_capped", "context"],
  ]);
});

test("every notice code has a legacy row, and only the must-act codes are warnings (SPEC §2.4)", () => {
  const mustAct = new Set(["finish_length", "usage_limit", "connector_unavailable", "hostile_content", "research_skipped"]);
  for (const code of RUN_NOTICE_CODES) {
    const row = noticeRow({ code });
    assert.ok(row.title.length > 0, code);
    assert.equal(row.kind, mustAct.has(code) ? "warning" : "context", code);
  }
  assert.equal(noticeRow({ code: "model_changed", params: { detail: "Fell back to Sonnet" } }).detail, "Fell back to Sonnet");
});

test("streamed: every fact reaches a timeline client; the tools fact is recorded but not streamed for profile 1", () => {
  for (const declared of [[...WEB_CLIENT_FEATURES], []]) {
    const frames: StreamChunk[] = [];
    const features = parseClientFeatures(declared);
    const sender = createSseSender(
      { enqueue: (bytes: Uint8Array) => void frames.push(JSON.parse(parseSseFrame(new TextDecoder().decode(bytes).trim())!.data)) } as unknown as ReadableStreamDefaultController<Uint8Array>,
      { features }
    );
    for (const row of turnStartFacts(input({ features }))) sendRunActivity(sender, features, row);
    assert.equal(sender.activityLog.length, 4, "all recorded");
    assert.deepEqual(sender.activityLog.map((row) => row.seq), [1, 2, 3, 4]);
    assert.ok(sender.activityLog.every((row) => row.id.startsWith("activity-") && row.createdAt), "the sender stamps every row");
    const streamedTools = frames.some((frame) => frame.type === "activity" && frame.event.fact?.key === "tools");
    assert.equal(streamedTools, declared.length > 0);
  }
});

test("the builder stays free of server-only (harness rule 1)", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/chat/turn-start-facts.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
});
