import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { ClientActionApproval } from "@/lib/action-approval";
import { createSseSender, MAX_DONE_FRAME_BYTES, parseSseFrame } from "@/lib/chat-stream";
import { parseClientFeatures, WEB_CLIENT_FEATURES, type ClientFeature } from "@/lib/chat/client-features";
import { SourceRegistry } from "@/lib/chat/source-registry";
import { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import { noticeRow } from "@/lib/chat/turn-start-facts";
import { TurnStream } from "@/lib/chat/turn-stream";
import type { TaintSource, TurnTaint } from "@/lib/web/taint";
import type { ClientActivityEvent, ClientMessage, StreamChunk } from "@/types/chat";
import type { LlmEvent } from "@/types/llm";
import { playTurnScript, type PlayedTurn } from "./fixtures/turn-player";
import { TURN_SCRIPTS, turnScript } from "./fixtures/turn-scripts";

/*
 * THE EVENT → FRAME TABLE (SPEC §2.10), driven through the real sender.
 *
 * Every case below plays events into a `TurnStream` whose sender writes real
 * SSE bytes, and reads the frames back the way a client would. The scripted
 * turns come from `tests/fixtures/turn-scripts.ts` through the same player the
 * `/dev/run` gallery and the native conformance test use.
 */

const decoder = new TextDecoder();
const root = process.cwd();

interface Harness {
  turn: TurnStream;
  frames: StreamChunk[];
  acc: GenerationAccumulator;
  sources: SourceRegistry;
  activityLog: ClientActivityEvent[];
  approvals: ClientActionApproval[];
  active: number[];
  taint: Array<{ source: TaintSource; severity?: string }>;
  ledger: string[];
  providerSearches: number;
  usage: number;
}

function harness(features: readonly ClientFeature[], opts: { artifactEdit?: boolean; toolDetailEnabled?: boolean } = {}): Harness {
  const frames: StreamChunk[] = [];
  const controller = {
    enqueue(bytes: Uint8Array) {
      const parsed = parseSseFrame(decoder.decode(bytes).trim());
      if (parsed) frames.push(JSON.parse(parsed.data) as StreamChunk);
    },
  } as unknown as ReadableStreamDefaultController<Uint8Array>;
  const set = parseClientFeatures(features);
  let clock = Date.parse("2026-09-24T10:00:00.000Z");
  const now = () => (clock += 10);
  const sender = createSseSender(controller, { features: set, now });
  const sources = new SourceRegistry();
  const acc = new GenerationAccumulator({ sources });
  const h: Harness = {
    frames,
    acc,
    sources,
    activityLog: sender.activityLog,
    approvals: [],
    active: [],
    taint: [],
    ledger: [],
    providerSearches: 0,
    usage: 0,
    turn: undefined as unknown as TurnStream,
  };
  const taint = {
    mark(source: TaintSource, severity?: string) {
      h.taint.push(severity ? { source, severity } : { source });
    },
    observed: false,
    severity: "none",
  } as unknown as TurnTaint;
  h.turn = new TurnStream({
    sender,
    features: set,
    acc,
    sources,
    ledger: { addText() {}, add: (url: string) => void h.ledger.push(url), match: () => null },
    taint,
    toolDetailEnabled: opts.toolDetailEnabled ?? true,
    onToolActivityChange: (n) => void h.active.push(n),
    onApproval: (approval) => void h.approvals.push(approval),
    onUsage: () => void (h.usage += 1),
    onProviderSearch: () => void (h.providerSearches += 1),
    artifactEdit: opts.artifactEdit ?? false,
    now,
  });
  return h;
}

const TIMELINE: readonly ClientFeature[] = WEB_CLIENT_FEATURES;
const PROFILE_1: readonly ClientFeature[] = [];

function activities(frames: readonly StreamChunk[]): ClientActivityEvent[] {
  return frames.flatMap((frame) => (frame.type === "activity" ? [frame.event] : []));
}

function approval(id: string, overrides: Partial<ClientActionApproval> = {}): ClientActionApproval {
  return {
    id,
    surface: "chat",
    sessionId: "gen_1",
    conversationId: "conv_1",
    connectorId: "github",
    connectorLabel: "GitHub",
    toolName: "create_issue",
    action: "Create issue",
    riskClass: "external_write",
    preview: "Create issue \"Flaky\" in juno/web",
    detail: { title: "Flaky" },
    receiptDigest: `digest_${id}`,
    status: "pending",
    decision: null,
    canAllowScope: true,
    derivedFromUntrusted: false,
    expiresAt: "2026-09-24T10:15:00.000Z",
    decidedAt: null,
    completedAt: null,
    createdAt: "2026-09-24T10:00:00.000Z",
    ...overrides,
  };
}

const call = (callId: string, name: string, round: number, index: number, extra: Partial<Extract<LlmEvent, { type: "tool"; phase: "call" }>> = {}): LlmEvent => ({
  type: "tool",
  phase: "call",
  server: name.includes("__") ? "GitHub" : "Juno",
  name,
  callId,
  round,
  index,
  ...extra,
});

// ── text ─────────────────────────────────────────────────────────────────────

test("text: one write row at the first text, then the delta; timeline frames carry round and phase", () => {
  const h = harness(TIMELINE);
  h.turn.apply({ type: "text", text: "Hello ", round: 0, phase: "answer" });
  h.turn.apply({ type: "text", text: "world.", round: 0, phase: "answer" });
  assert.deepEqual(
    h.frames.map((frame) => frame.type),
    ["activity", "delta", "delta"],
    "exactly one write row (INV-7), before the first delta"
  );
  assert.equal((h.frames[0] as { event: ClientActivityEvent }).event.kind, "write");
  assert.deepEqual(h.frames[1], { type: "delta", text: "Hello ", round: 0, phase: "answer" });
});

test("text: profile 1 gets no round or phase keys, and a separator between two steps' text (INV-8)", () => {
  const h = harness(PROFILE_1);
  h.turn.apply({ type: "text", text: "Let me check.", round: 0 });
  h.turn.apply({ type: "round_end", round: 0, tools: 1, serverTools: 0, final: false, stop: "tool_use" });
  h.turn.apply({ type: "text", text: "The answer.", round: 1 });
  const deltas = h.frames.filter((frame) => frame.type === "delta");
  assert.deepEqual(deltas, [
    { type: "delta", text: "Let me check." },
    { type: "delta", text: "\n\n" },
    { type: "delta", text: "The answer." },
  ]);
});

test("text: no separator when the earlier text already ends in a newline, and never for timeline", () => {
  const p1 = harness(PROFILE_1);
  p1.turn.apply({ type: "text", text: "Line one.\n", round: 0 });
  p1.turn.apply({ type: "text", text: "Line two.", round: 1 });
  assert.deepEqual(
    p1.frames.filter((frame) => frame.type === "delta").map((frame) => (frame as { text: string }).text),
    ["Line one.\n", "Line two."]
  );

  const web = harness(TIMELINE);
  web.turn.apply({ type: "text", text: "a", round: 0 });
  web.turn.apply({ type: "text", text: "b", round: 1 });
  assert.equal(web.frames.filter((frame) => frame.type === "delta").length, 2, "timeline clients place text by round");
});

test("text: an artifact-edit turn streams no deltas, only its write row", () => {
  const h = harness(TIMELINE, { artifactEdit: true });
  h.turn.apply({ type: "text", text: "<patch/>", round: 0 });
  assert.deepEqual(h.frames.map((frame) => frame.type), ["activity"]);
  assert.equal(activities(h.frames)[0].title, "Preparing targeted changes");
});

// ── reasoning ────────────────────────────────────────────────────────────────

test("reasoning: a segment row before each new (round, part), offsets index the flat text", () => {
  const h = harness(TIMELINE);
  h.turn.apply({ type: "reasoning", text: "First.", round: 0 });
  h.turn.apply({ type: "reasoning", text: " More.", round: 0 });
  h.turn.apply({ type: "reasoning", text: "Second step.", round: 1 });
  const segments = activities(h.frames).filter((event) => event.segment);
  assert.deepEqual(
    segments.map((event) => event.segment),
    [
      { round: 0, offset: 0 },
      { round: 1, offset: "First. More.\n\n".length },
    ]
  );
  assert.equal(h.acc.reasoning.slice(segments[1].segment!.offset), "Second step.");
  const reasoningFrames = h.frames.filter((frame) => frame.type === "reasoning");
  assert.deepEqual(reasoningFrames[2], { type: "reasoning", text: "Second step.", round: 1 });
});

test("reasoning: profile 1 records the segment rows but never streams them, nor the round key", () => {
  const h = harness(PROFILE_1);
  h.turn.apply({ type: "reasoning", text: "Thinking.", part: 0, round: 0 });
  assert.deepEqual(h.frames, [{ type: "reasoning", text: "Thinking.", part: 0 }]);
  assert.equal(h.activityLog.length, 1, "the segment is in the persisted log");
  assert.deepEqual(h.activityLog[0].segment, { round: 0, part: 0, offset: 0 });
});

// ── commentary ───────────────────────────────────────────────────────────────

test("round_end with tools: the round's text becomes a commentary row (timeline only live)", () => {
  for (const features of [TIMELINE, PROFILE_1]) {
    const h = harness(features);
    h.turn.apply({ type: "text", text: "Let me look that up.", round: 0 });
    h.turn.apply(call("toolu_1", "web_search", 0, 0));
    h.turn.apply({ type: "round_end", round: 0, tools: 1, serverTools: 0, final: false, stop: "tool_use" });
    const row = h.activityLog.find((event) => event.commentary);
    assert.ok(row, "the commentary row is always recorded");
    assert.deepEqual(row.commentary, { round: 0, text: "Let me look that up.", inline: true });
    assert.equal(row.kind, "reasoning");
    assert.equal(row.title, "Commentary");
    const streamed = activities(h.frames).some((event) => event.commentary);
    assert.equal(streamed, features === TIMELINE, "streamed only to a timeline client");
  }
});

test("round_end without client tools (a provider search inside the response) never demotes text", () => {
  const h = harness(TIMELINE);
  h.turn.apply({ type: "text", text: "Searching first.", round: 0 });
  h.turn.apply({ type: "round_end", round: 0, tools: 0, serverTools: 1, final: false, stop: null });
  h.turn.apply({ type: "text", text: "Found it.", round: 1 });
  const { answer, activity } = h.turn.finish("completed");
  assert.equal(answer, "Searching first.\n\nFound it.");
  assert.equal(activity.some((event) => event.commentary), false);
});

test("an OpenAI commentary item is declared commentary: inline false", () => {
  const h = harness(TIMELINE);
  h.turn.apply({ type: "text", text: "Checking.", round: 0, phase: "commentary" });
  h.turn.apply({ type: "round_end", round: 0, tools: 1, serverTools: 0, final: false, stop: "tool_use" });
  h.turn.apply({ type: "text", text: "Answer.", round: 1, phase: "answer" });
  const { answer, activity } = h.turn.finish("completed");
  assert.equal(answer, "Answer.");
  assert.deepEqual(activity.find((event) => event.commentary)?.commentary, { round: 0, text: "Checking.", inline: false });
});

test("finish: a turn that wrote only commentary falls back to it, and the row is withdrawn (nothing shown twice)", () => {
  const h = harness(TIMELINE);
  h.turn.apply({ type: "text", text: "Let me check.", round: 0 });
  h.turn.apply(call("toolu_1", "web_search", 0, 0));
  h.turn.apply({ type: "round_end", round: 0, tools: 1, serverTools: 0, final: false, stop: "tool_use" });
  assert.ok(h.activityLog.some((event) => event.commentary));
  const { answer, activity } = h.turn.finish("aborted");
  assert.equal(answer, "Let me check.");
  assert.equal(activity.some((event) => event.commentary), false);
});

// ── tools ────────────────────────────────────────────────────────────────────

test("a tool call is one row, updated in place: same id and seq on every re-send", () => {
  const h = harness(TIMELINE);
  h.turn.apply(call("jc_0_0", "web_search", 0, 0, { args: JSON.stringify({ query: "heat pumps" }) }));
  h.turn.apply({ type: "round_end", round: 0, tools: 1, serverTools: 0, final: false, stop: "tool_use" });
  h.turn.apply({ type: "tool", phase: "status", callId: "jc_0_0", status: "queued", present: { query: "heat pumps" }, argsText: "{\"query\":\"heat pumps\"}" });
  h.turn.apply({ type: "tool", phase: "status", callId: "jc_0_0", status: "running", timeoutMs: 15_000 });
  h.turn.apply({
    type: "tool",
    phase: "result",
    server: "Juno",
    name: "web_search",
    callId: "jc_0_0",
    round: 0,
    index: 0,
    result: "[1] A — https://a.example/1",
    ok: true,
    status: "succeeded",
    durationMs: 812,
    figure: { kind: "results", n: 1 },
    web: { query: "heat pumps", results: [{ n: 1, title: "A", url: "https://a.example/1" }] },
  });

  const rows = activities(h.frames).filter((event) => event.call);
  assert.equal(new Set(rows.map((event) => event.id)).size, 1, "one row");
  assert.equal(new Set(rows.map((event) => event.seq)).size, 1, "one seq");
  assert.deepEqual(
    rows.map((event) => event.call!.status),
    ["queued", "queued", "running", "succeeded"]
  );
  const last = rows[rows.length - 1];
  assert.equal(last.kind, "search");
  assert.equal(last.title, "Searching the web");
  assert.equal(last.detail, "heat pumps");
  assert.equal(last.call!.timeoutMs, 15_000);
  assert.deepEqual(last.call!.args, { query: "heat pumps" });
  assert.deepEqual(last.call!.figure, { kind: "results", n: 1 });
  assert.equal(last.call!.durationMs, 812);
  assert.equal(last.tool!.status, "ok", "the legacy detail still carries ok/failed");
  assert.equal(h.activityLog.filter((event) => event.call).length, 1, "the persisted log has the one row");
  assert.deepEqual(h.taint, [{ source: "web_search" }]);
});

test("the §2.4 legacy projection per tool", () => {
  const h = harness(PROFILE_1);
  h.turn.apply(call("a", "web_fetch", 0, 0, { args: JSON.stringify({ url: "https://www.example.com/page" }) }));
  h.turn.apply(call("b", "github__create_issue", 0, 1, { args: "{}" }));
  h.turn.apply(call("c", "calculate", 0, 2, { args: "{\"expression\":\"1+1\"}" }));
  h.turn.apply(call("d", "start_task", 0, 3, { args: JSON.stringify({ title: "Refactor", brief: "…" }) }));
  const rows = h.activityLog.filter((event) => event.call);
  assert.deepEqual(
    rows.map((event) => [event.kind, event.title, event.detail]),
    [
      ["visit", "Visited source", "example.com"],
      ["tool", "Using GitHub", "github__create_issue"],
      ["tool", "Using Calculator", "calculate"],
      ["tool", "Starting a task", rows[3].detail],
    ]
  );
  assert.equal(rows[1].call!.tool, "mcp");
  assert.equal(rows[1].call!.origin, "connector");
  assert.equal(rows[1].call!.connectorLabel, "GitHub");
  assert.equal(rows[1].call!.toolTitle, "Create issue");
  assert.equal(rows[2].call!.origin, "juno");
});

test("a legacy tool name is read through its alias (INV-23)", () => {
  const h = harness(TIMELINE);
  h.turn.apply(call("a", "code_interpreter", 0, 0));
  assert.equal(h.activityLog[0].call!.tool, "run_code");
});

test("a resolver from the toolset names the tool", () => {
  const frames: StreamChunk[] = [];
  const sender = createSseSender({ enqueue: () => {} } as unknown as ReadableStreamDefaultController<Uint8Array>);
  const sources = new SourceRegistry();
  const turn = new TurnStream({
    sender,
    features: parseClientFeatures([...TIMELINE]),
    acc: new GenerationAccumulator({ sources }),
    sources,
    ledger: null,
    taint: { mark() {} } as unknown as TurnTaint,
    toolDetailEnabled: false,
    onToolActivityChange() {},
    onApproval() {},
    onUsage() {},
    onProviderSearch() {},
    artifactEdit: false,
    resolveTool: (name) =>
      name === "linear__make"
        ? { canonical: "mcp", origin: "connector", title: "Create an issue", connectorId: "linear", connectorLabel: "Linear", toolTitle: "Create an issue" }
        : undefined,
  });
  turn.apply({ type: "tool", phase: "call", server: "Linear", name: "linear__make", callId: "x" });
  const row = sender.activityLog[0];
  assert.equal(row.call!.connectorId, "linear");
  assert.equal(row.call!.toolTitle, "Create an issue");
  assert.equal(row.tool, undefined, "no tool detail when detail is off (lockdown)");
  assert.equal(frames.length, 0);
});

test("Anthropic's call carries no arguments: the first queued fills the record, the row and the detail", () => {
  const h = harness(TIMELINE);
  h.turn.apply(call("toolu_1", "web_search", 0, 0));
  assert.equal(h.activityLog[0].tool!.argsNote, "unavailable");
  h.turn.apply({ type: "tool", phase: "status", callId: "toolu_1", status: "queued", present: { query: "mars" }, argsText: "{\"query\":\"mars\"}" });
  const row = h.activityLog[0];
  assert.equal(row.detail, "mars");
  assert.deepEqual(row.call!.args, { query: "mars" });
  assert.match(row.tool!.args ?? "", /mars/);
});

test("approvals: the approval goes to the route; profile 1 also gets one 'needs approval' row per call", () => {
  for (const features of [PROFILE_1, TIMELINE]) {
    const h = harness(features);
    h.turn.apply(call("toolu_2", "github__create_issue", 0, 0, { args: "{\"title\":\"Flaky\"}" }));
    h.turn.apply({ type: "tool", phase: "status", callId: "toolu_2", status: "queued" });
    h.turn.apply({ type: "tool", phase: "status", callId: "toolu_2", status: "awaiting_approval", approval: approval("apr_1") });
    h.turn.apply({ type: "tool", phase: "status", callId: "toolu_2", status: "awaiting_approval", approval: approval("apr_1") });
    h.turn.apply({ type: "tool", phase: "status", callId: "toolu_2", status: "running", timeoutMs: 60_000 });
    h.turn.apply({ type: "tool", phase: "result", server: "GitHub", name: "github__create_issue", callId: "toolu_2", result: "Created #1.", ok: true, status: "succeeded" });

    assert.equal(h.approvals.length, 2, "every awaiting status reaches the route's approval frame");
    const legacyRows = h.activityLog.filter((event) => event.title === "GitHub needs approval");
    assert.equal(legacyRows.length, features === PROFILE_1 ? 1 : 0, "once per call, profile 1 only (INV-7)");
    if (legacyRows[0]) {
      assert.equal(legacyRows[0].kind, "tool");
      assert.equal(legacyRows[0].detail, "Create issue \"Flaky\" in juno/web");
    }
    const record = h.activityLog.find((event) => event.call)!.call!;
    assert.equal(record.approval!.id, "apr_1");
    assert.equal(record.approval!.status, "executed", "the receipt as of the call's end (INV-18)");
    assert.deepEqual(h.active, [1, 0], "waiting, then running, then done: active 1 throughout");
  }
});

test("approvals: a denied call records deny; a Stop during the wait records superseded", () => {
  const h = harness(TIMELINE);
  h.turn.apply(call("a", "github__create_issue", 0, 0));
  h.turn.apply(call("b", "github__create_issue", 0, 1));
  h.turn.apply({ type: "tool", phase: "status", callId: "a", status: "awaiting_approval", approval: approval("apr_a") });
  h.turn.apply({ type: "tool", phase: "result", server: "GitHub", name: "github__create_issue", callId: "a", result: "Declined.", ok: false, status: "denied", error: { code: "denied" } });
  h.turn.apply({ type: "tool", phase: "status", callId: "b", status: "awaiting_approval", approval: approval("apr_b") });
  const { activity } = h.turn.finish("aborted");
  const [a, b] = activity.filter((event) => event.call).map((event) => event.call!);
  assert.equal(a.status, "denied");
  assert.equal(a.approval!.status, "denied");
  assert.equal(a.approval!.decision, "deny");
  assert.equal(b.status, "cancelled");
  assert.deepEqual(b.error, { code: "cancelled" });
  assert.equal(b.approval!.status, "superseded");
});

test("onToolActivityChange counts calls running or awaiting approval (INV-33)", () => {
  const h = harness(TIMELINE);
  h.turn.apply(call("a", "web_fetch", 0, 0));
  h.turn.apply(call("b", "web_fetch", 0, 1));
  h.turn.apply({ type: "tool", phase: "status", callId: "a", status: "queued" });
  h.turn.apply({ type: "tool", phase: "status", callId: "b", status: "queued" });
  assert.deepEqual(h.active, [], "queued calls are not active");
  h.turn.apply({ type: "tool", phase: "status", callId: "a", status: "running" });
  h.turn.apply({ type: "tool", phase: "status", callId: "b", status: "running" });
  h.turn.apply({ type: "tool", phase: "result", server: "Juno", name: "web_fetch", callId: "a", result: "x", ok: true, status: "succeeded" });
  h.turn.apply({ type: "tool", phase: "result", server: "Juno", name: "web_fetch", callId: "b", result: "", ok: false, status: "failed", error: { code: "timeout" } });
  assert.deepEqual(h.active, [1, 2, 1, 0]);
  assert.equal(h.turn.activeCalls, 0);
});

test("finish closes open calls as cancelled and says so in the detail", () => {
  const h = harness(TIMELINE);
  h.turn.apply(call("a", "run_code", 0, 0, { args: "{\"code\":\"x\"}" }));
  h.turn.apply({ type: "tool", phase: "status", callId: "a", status: "running", timeoutMs: 130_000 });
  const { activity } = h.turn.finish("aborted");
  const row = activity.find((event) => event.call)!;
  assert.equal(row.call!.status, "cancelled");
  assert.deepEqual(row.call!.error, { code: "cancelled" });
  assert.ok(row.call!.endedAt);
  assert.equal(row.tool!.resultNote, "unfinished");
  assert.deepEqual(h.active, [1, 0]);
  assert.equal(h.turn.finish("completed"), h.turn.finish("aborted"), "finish is idempotent");
});

test("an unpaired result is dropped, not turned into an orphan row", () => {
  const h = harness(TIMELINE);
  h.turn.apply({ type: "tool", phase: "result", server: "Juno", name: "web_fetch", callId: "ghost", result: "x", ok: true });
  assert.equal(h.activityLog.length, 0);
});

test("taint: fetched pages, searches with results, chats found, documents and connector output mark it", () => {
  const h = harness(TIMELINE);
  const done = (callId: string, name: string, extra: Partial<Extract<LlmEvent, { type: "tool"; phase: "result" }>>) =>
    h.turn.apply({ type: "tool", phase: "result", server: "Juno", name, callId, result: "x", ok: true, status: "succeeded", ...extra });
  for (const [id, name] of [["1", "web_fetch"], ["2", "web_search"], ["3", "search_chats"], ["4", "read_document"], ["5", "gh__x"], ["6", "web_search"], ["7", "calculate"]] as const) {
    h.turn.apply(call(id, name, 0, Number(id)));
  }
  done("1", "web_fetch", { web: { injection: "hostile" } });
  done("2", "web_search", { figure: { kind: "results", n: 3 } });
  done("3", "search_chats", { figure: { kind: "chats", n: 2 } });
  done("4", "read_document", {});
  done("5", "gh__x", { server: "GitHub" });
  done("6", "web_search", { figure: { kind: "results", n: 0 } });
  done("7", "calculate", {});
  assert.deepEqual(h.taint, [
    { source: "web_fetch", severity: "hostile" },
    { source: "web_search" },
    { source: "search_chats" },
    { source: "read_document" },
    { source: "connector" },
  ]);
});

// ── provider search and sources ──────────────────────────────────────────────

test("server_tool: a search row with a typed provider record; its result marks the taint and counts the search", () => {
  const h = harness(TIMELINE);
  h.turn.apply({ type: "server_tool", phase: "call", tool: "provider_web_search", callId: "srvtoolu_1", round: 0 });
  h.turn.apply({ type: "server_tool", phase: "call", tool: "provider_web_search", callId: "srvtoolu_1", round: 0, query: "ev sales" });
  h.turn.apply({ type: "server_tool", phase: "result", tool: "provider_web_search", callId: "srvtoolu_1", round: 0, results: 5, ok: true });
  const row = h.activityLog[0];
  assert.equal(row.kind, "search");
  assert.equal(row.title, "Searching the web");
  assert.equal(row.detail, "ev sales");
  assert.equal(row.call!.origin, "provider");
  assert.equal(row.call!.status, "succeeded");
  assert.deepEqual(row.call!.figure, { kind: "results", n: 5 });
  assert.deepEqual(h.taint, [{ source: "provider_search" }]);
  assert.equal(h.providerSearches, 1);
  assert.deepEqual(h.active, [], "a provider search is the provider's own work: the watchdog keeps watching");
});

test("sources: normalised, numbered once, framed whole; visit rows only for provider sources; ledger and taint", () => {
  const h = harness(PROFILE_1);
  h.turn.apply({
    type: "sources",
    origin: "provider_search",
    sources: [
      { title: "", url: "https://news.example.com/a", snippet: "x" },
      { title: "Bad", url: "javascript:alert(1)", snippet: "" },
    ],
  });
  h.turn.apply({ type: "sources", origin: "juno_search", sources: [{ title: "Line\nbreak", url: "https://b.example/", snippet: "" }] });
  h.turn.apply({ type: "sources", origin: "provider_grounding", sources: [{ title: "G", url: "https://vertex.example/redirect", snippet: "" }] });

  const frames = h.frames.filter((frame) => frame.type === "sources") as Array<{ sources: Array<{ title: string; url: string; origin?: string }> }>;
  assert.equal(frames.length, 3);
  assert.deepEqual(
    frames[2].sources.map((source) => [source.title, source.url, source.origin]),
    [
      ["news.example.com", "https://news.example.com/a", "provider_search"],
      ["Line break", "https://b.example/", "juno_search"],
      ["G", "https://vertex.example/redirect", "provider_grounding"],
    ]
  );
  const visits = h.activityLog.filter((event) => event.kind === "visit");
  assert.deepEqual(visits.map((event) => event.url), ["https://news.example.com/a", "https://vertex.example/redirect"]);
  assert.deepEqual(h.ledger, ["https://news.example.com/a", "https://b.example/"], "grounding URLs never join the ledger");
  assert.deepEqual(h.taint.map((mark) => mark.source), ["provider_search", "provider_search"]);
  assert.deepEqual(h.acc.sources.map((source) => source.url), frames[2].sources.map((source) => source.url), "one list");
});

test("usage reaches onUsage; finish reaches the accumulator; the dead approval member is ignored", () => {
  const h = harness(TIMELINE);
  h.turn.apply({ type: "usage", input: 10, output: 2, round: 0 });
  h.turn.apply({ type: "finish", reason: "length" });
  h.turn.apply({ type: "approval", approval: approval("dead") });
  assert.equal(h.usage, 1);
  assert.equal(h.acc.finishReason, "length");
  assert.equal(h.approvals.length, 0);
  assert.equal(h.frames.length, 0);
});

test("apply never throws on malformed input", () => {
  const h = harness(TIMELINE);
  for (const bad of [null, undefined, 3, {}, { type: "text" }, { type: "tool", phase: "call" }, { type: "round_end", round: -1 }, { type: "sources", sources: "x" }]) {
    assert.doesNotThrow(() => h.turn.apply(bad as unknown as LlmEvent));
  }
});

// ── notices ──────────────────────────────────────────────────────────────────

test("informational notices ride kind:context; only the must-act codes are warnings", () => {
  const h = harness(PROFILE_1);
  h.turn.emitActivity(noticeRow({ code: "tool_budget" }));
  h.turn.emitActivity(noticeRow({ code: "web_off_lockdown" }));
  h.turn.emitActivity(noticeRow({ code: "finish_length" }));
  h.turn.emitActivity(noticeRow({ code: "hostile_content" }));
  assert.deepEqual(
    activities(h.frames).map((event) => [event.notice!.code, event.kind]),
    [
      ["tool_budget", "context"],
      ["web_off_lockdown", "context"],
      ["finish_length", "warning"],
      ["hostile_content", "warning"],
    ]
  );
});

// ── the scripted turns ───────────────────────────────────────────────────────

const NEW_FRAME_TYPES = new Set(["handoff"]);

function framesOf(played: PlayedTurn): StreamChunk[] {
  return played.frames.map((frame) => frame.chunk);
}

test("profile 1 never receives round, phase, handoff, or the timeline-only rows — for every script", () => {
  for (const script of TURN_SCRIPTS) {
    if (script.legacy) continue;
    const played = playTurnScript(script, { features: [] });
    // A hand-off exists only for a client that declared `research_background`.
    const comparable = !script.handoffRunId;
    for (const chunk of framesOf(played)) {
      assert.ok(!NEW_FRAME_TYPES.has(chunk.type), `${script.id}: ${chunk.type} reached profile 1`);
      if (chunk.type === "delta" || chunk.type === "reasoning") {
        assert.ok(!("round" in chunk) && !("phase" in chunk), `${script.id}: round/phase on a profile-1 frame`);
      }
      if (chunk.type === "activity") {
        assert.ok(!chunk.event.segment && !chunk.event.commentary && chunk.event.fact?.key !== "tools", `${script.id}: timeline-only row streamed`);
      }
    }
    if (!comparable) continue;
    // …and yet the persisted activity is the same for both profiles, seq for seq.
    const web = playTurnScript(script);
    const shape = (events: readonly ClientActivityEvent[]) =>
      events.filter((event) => event.title !== "GitHub needs approval").map((event) => [event.kind, event.segment, event.commentary, event.fact?.key, event.call?.status]);
    assert.deepEqual(shape(played.record.activity), shape(web.record.activity), `${script.id}: persisted activity differs by profile`);
  }
});

test("every scripted turn: exactly one write row when it wrote text, one done row, seq 1-based and fixed", () => {
  for (const script of TURN_SCRIPTS) {
    if (script.legacy || script.handoffRunId) continue;
    const played = playTurnScript(script);
    const log = played.record.activity;
    const wrote = script.steps.some((step) => step.event.type === "text");
    assert.equal(log.filter((event) => event.kind === "write").length, wrote ? 1 : 0, `${script.id}: write rows`);
    assert.equal(log.filter((event) => event.kind === "done").length, 1, `${script.id}: done rows`);
    assert.deepEqual(
      log.map((event) => event.seq),
      [...log.map((event) => event.seq)].sort((a, b) => a! - b!),
      `${script.id}: seq follows emission order`
    );
    assert.equal(log[0].seq, 1);
    // Re-sent rows keep their id and seq.
    const byId = new Map<string, number>();
    for (const frame of framesOf(played)) {
      if (frame.type !== "activity") continue;
      const seen = byId.get(frame.event.id);
      if (seen !== undefined) assert.equal(frame.event.seq, seen, `${script.id}: seq changed on a re-send`);
      byId.set(frame.event.id, frame.event.seq!);
    }
    // Nothing in the persisted record is still running.
    for (const event of log) {
      if (event.call) assert.ok(["succeeded", "failed", "denied", "expired", "cancelled"].includes(event.call.status), `${script.id}: ${event.call.status}`);
    }
  }
});

test("the answers the scripts persist: commentary out, every round's answer in, never glued", () => {
  assert.equal(playTurnScript(turnScript(11)).answer, "One euro buys about 162 yen today [1].");
  assert.equal(playTurnScript(turnScript(12)).answer, "Node 26 was released in April 2026 [1].");
  assert.equal(playTurnScript(turnScript(18)).answer, "Let me search for the latest numbers.\n\nEV sales in Europe rose about 18% in 2026, led by Norway and Denmark.");
  assert.equal(playTurnScript(turnScript(23)).answer, "The rover reached the delta's rim last week [1].");
  const reEntry = playTurnScript(turnScript(27));
  assert.equal(reEntry.answer, "The northern region closes a week earlier, on 23 October [1].");
  assert.equal(reEntry.record.activity.filter((event) => event.commentary).length, 2);
});

test("the scripted turns report activity, approvals and searches to the route", () => {
  const approvals = playTurnScript(turnScript(9));
  assert.equal(approvals.approvals.length, 2);
  assert.deepEqual(approvals.activeCounts, [1, 0, 1, 0]);
  const quiet = playTurnScript(turnScript(24));
  assert.deepEqual(quiet.activeCounts, [1, 0], "a 60 s run_code keeps the watchdog paused throughout");
  const provider = playTurnScript(turnScript(18));
  assert.equal(provider.providerSearches, 1);
  assert.ok(provider.taintMarks.some((mark) => mark.source === "provider_search"));
  const unavailable = playTurnScript(turnScript(7));
  const notice = unavailable.record.activity.find((event) => event.notice?.code === "connector_unavailable");
  assert.equal(notice?.kind, "warning");
  const budget = playTurnScript(turnScript(14));
  assert.equal(budget.record.activity.find((event) => event.notice)?.notice?.code, "tool_budget");
});

test("the research hand-off ends a web request with `handoff` and writes no assistant row", () => {
  const played = playTurnScript(turnScript(21));
  const last = played.frames[played.frames.length - 1].chunk;
  assert.deepEqual(last, { type: "handoff", to: "research", runId: "run_fixture_21", userMessageId: "msg_user_fixture" });
  assert.equal(played.done, null);
  assert.ok(!framesOf(playTurnScript(turnScript(21), { features: [] })).some((chunk) => chunk.type === "handoff"));
});

test("playing a script is deterministic: the same frames every time", () => {
  for (const script of TURN_SCRIPTS) {
    if (script.legacy) continue;
    assert.deepEqual(framesOf(playTurnScript(script)), framesOf(playTurnScript(script)), script.id);
  }
});

test("every /dev/run fixture's frames equal TurnStream over its script", async (t) => {
  /*
   * The gallery's fixtures (WS5, `src/app/dev/run/fixtures.ts`) are generated
   * by playing these scripts, never hand-written (SPEC §11.1). Until that file
   * lands on this branch there is nothing to compare, and the test says so
   * rather than passing silently.
   */
  const file = path.join(root, "src/app/dev/run/fixtures.ts");
  if (!existsSync(file)) {
    t.skip("src/app/dev/run/fixtures.ts is not on this branch yet (WS5)");
    return;
  }
  const mod = (await import(file)) as Record<string, unknown>;
  const lists = Object.values(mod).filter(
    (value): value is Array<{ id: string; frames: Array<{ atMs: number; chunk: StreamChunk }>; features?: ClientFeature[] }> =>
      Array.isArray(value) && value.every((item) => item && typeof item === "object" && "frames" in item && "id" in item)
  );
  assert.ok(lists.length > 0, "fixtures.ts exports its fixture list");
  let compared = 0;
  for (const fixture of lists[0]) {
    const script = TURN_SCRIPTS.find((candidate) => candidate.id === fixture.id);
    if (!script || script.legacy) continue;
    const played = playTurnScript(script, fixture.features ? { features: fixture.features } : {});
    assert.deepEqual(
      fixture.frames.map((frame) => frame.chunk),
      framesOf(played),
      `/dev/run fixture ${fixture.id} does not match TurnStream over its script`
    );
    compared += 1;
  }
  assert.ok(compared > 0, "at least one fixture was compared");
});

// ── INV-4 ────────────────────────────────────────────────────────────────────

function sendDone(message: ClientMessage, artifactBytes: number): Extract<StreamChunk, { type: "done" }> {
  const frames: Uint8Array[] = [];
  const sender = createSseSender({ enqueue: (bytes: Uint8Array) => void frames.push(bytes) } as unknown as ReadableStreamDefaultController<Uint8Array>);
  const artifacts = artifactBytes
    ? [{ id: "art", identifier: "i", type: "CODE", title: "t", currentVersion: 1, content: "y".repeat(artifactBytes), versions: [], createdAt: "", updatedAt: "" }]
    : [];
  sender.send({
    type: "done",
    message,
    artifacts: artifacts as never,
    memoryUpdated: false,
    quota: { plan: "PRO", used: 1, limit: null, remaining: null },
  });
  assert.equal(frames.length, 1);
  assert.ok(frames[0].length <= MAX_DONE_FRAME_BYTES + 64, "the frame fits");
  return JSON.parse(parseSseFrame(decoder.decode(frames[0]).trim())!.data) as Extract<StreamChunk, { type: "done" }>;
}

test("the done frame stays under 4.5 MiB: activity goes first, then artifacts (INV-4)", () => {
  const MiB = 1024 * 1024;
  const message: ClientMessage = {
    id: "m",
    role: "ASSISTANT",
    content: "answer",
    createdAt: "2026-09-24T10:00:00.000Z",
    attachments: [],
    activity: [{ id: "a", kind: "tool", title: "Using X", createdAt: "2026-09-24T10:00:00.000Z", detail: "x".repeat(3 * MiB) }],
  };

  const first = sendDone(message, 2 * MiB);
  assert.equal(first.message.activity === undefined, true, "activity dropped from the frame first");
  assert.equal(first.artifacts.length, 1, "the artifacts fit once the activity is gone");
  assert.equal(first.message.content, "answer", "the answer itself is never dropped");
  assert.equal(message.activity?.length, 1, "the persisted message keeps its activity");

  const second = sendDone(message, 5 * MiB);
  assert.equal(second.message.activity === undefined, true);
  assert.equal(Array.isArray(second.artifacts) && second.artifacts.length, 0, "then artifacts, still an array (INV-2)");

  const small = sendDone(message, 0);
  assert.equal(small.message.activity?.length, 1, "a frame under the bound is untouched");
});

test("a delta over 64 KiB is split into frames that each fit (INV-4)", () => {
  const h = harness(TIMELINE);
  const text = "é".repeat(40_000); // 80,000 bytes
  h.turn.apply({ type: "text", text, round: 0 });
  const deltas = h.frames.filter((frame) => frame.type === "delta") as Array<{ text: string; round?: number }>;
  assert.ok(deltas.length >= 2);
  assert.equal(deltas.map((delta) => delta.text).join(""), text);
  for (const delta of deltas) {
    assert.ok(new TextEncoder().encode(delta.text).length <= 64 * 1024);
    assert.equal(delta.round, 0, "every piece keeps its keys");
  }
});

// ── harness rule 1 ───────────────────────────────────────────────────────────

test("the turn stream keeps server-only out of its static import graph", () => {
  const source = readFileSync(path.join(root, "src/lib/chat/turn-stream.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
  assert.doesNotMatch(source, /from "@\/lib\/(prisma|llm|mcp|action-approval-store|tool-audit|serializers)"/);
});

test("a Mac folder call is recorded as local_folder, with its action and location on the row", () => {
  const h = harness(TIMELINE);
  h.turn.apply(call("toolu_f", "folder_read_file", 0, 0));
  h.turn.apply({
    type: "tool",
    phase: "status",
    callId: "toolu_f",
    status: "queued",
    present: { action: "read", path: "2026/march.csv" },
    argsText: "{\"path\":\"2026/march.csv\"}",
  });
  h.turn.apply({ type: "tool", phase: "status", callId: "toolu_f", status: "running", timeoutMs: 720_000 });
  const rows = activities(h.frames).filter((event) => event.call);
  const last = rows[rows.length - 1];
  assert.equal(last.call!.tool, "local_folder");
  assert.equal(last.call!.origin, "juno");
  assert.deepEqual(last.call!.args, { action: "read", path: "2026/march.csv" });
  assert.equal(last.call!.status, "running");
});
