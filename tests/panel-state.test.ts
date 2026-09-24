import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import type { ClientActionApproval } from "@/lib/action-approval";
import { phraseText } from "@/lib/i18n-phrase";
import type { PhraseSpec, RunItem, RunView } from "@/lib/run/types";
import { ALL_PANEL_PHRASES, PANEL_COPY } from "@/components/chat/panel/copy";
import { PANEL_COPY_DE } from "@/components/chat/panel/copy-de";
import { sendApprovalDecision, approvalChoices, answeredPhrase } from "@/components/chat/panel/panel-approval";
import {
  activityTabs,
  approvalReceiptPhrase,
  argumentsOf,
  askToRunAgainSpec,
  canAskToRunAgain,
  clampLines,
  contextLine,
  detailsModel,
  hasDetails,
  noticeLine,
  panelHeaderModel,
  panelLoopItemKey,
  pendingApprovalFor,
  resolveActivityTab,
  splitHeadline,
  toolNamePhrases,
  toolRowState,
} from "@/components/chat/panel/panel-model";
import {
  EMPTY_RIGHT_COLUMN,
  reconcileRightPanel,
  researchPanelFromUrl,
  rightColumnReducer,
  rightPanelReducer,
  type RightPanelState,
} from "@/components/chat/panel/panel-state";
import { createPanelMessageSelector, samePanelMessage, type PanelMessage } from "@/components/chat/panel/use-panel-message";
import { RUN_NOTICE_CODES, TOOL_CALL_STATUSES, type ToolCallRecord } from "@/types/run";

/*
 * The right column's state (SPEC §8.5) and what the Activity panel decides
 * about a run before anything is drawn (§8.3): which tabs, which header, which
 * rows can be answered or retried, which message it follows and when it
 * re-renders. Owned by WS6. Views are hand-built here, as the spec asks, so
 * none of this waits on the run UI's view builder.
 */

const root = process.cwd();
const read = (rel: string) => readFileSync(path.join(root, rel), "utf8");
const PANEL_DIR = "src/components/chat/panel";

// ── Harness ─────────────────────────────────────────────────────────────────

test("the panel's modules keep server-only out of their static graph", () => {
  for (const rel of [
    `${PANEL_DIR}/panel-state.ts`,
    `${PANEL_DIR}/panel-model.ts`,
    `${PANEL_DIR}/panel-approval.ts`,
    `${PANEL_DIR}/use-panel-message.ts`,
    `${PANEL_DIR}/shell-focus.ts`,
    `${PANEL_DIR}/copy.ts`,
  ]) {
    const source = read(rel);
    assert.doesNotMatch(source, /^import "server-only";/m, rel);
    // action-approval.ts pulls in node:crypto: the panel may only take its types.
    assert.doesNotMatch(source, /^import (?!type )[^;]*from "@\/lib\/action-approval";/m, rel);
  }
});

/** Source with comments removed, so an assertion about code cannot trip on the prose explaining it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("the panel never branches on an English title or hand-rolls a plural (INV-28, §10.1)", () => {
  for (const file of readdirSync(path.join(root, PANEL_DIR))) {
    const source = withoutComments(read(`${PANEL_DIR}/${file}`));
    assert.doesNotMatch(source, /\.title\.startsWith\(/, file);
    assert.doesNotMatch(source, /===\s*1\s*\?/, file);
  }
});

// ── rightPanelReducer ────────────────────────────────────────────────────────

test("opening is idempotent and a second open on the same target re-renders nothing", () => {
  const none: RightPanelState = { kind: "none" };
  const open = rightPanelReducer(none, { type: "open-activity", renderKey: "tmp-1" });
  assert.deepEqual(open, { kind: "activity", renderKey: "tmp-1" });
  assert.equal(rightPanelReducer(open, { type: "open-activity", renderKey: "tmp-1" }), open);
  const focused = rightPanelReducer(open, { type: "open-activity", renderKey: "tmp-1", focusCallId: "c1" });
  assert.deepEqual(focused, { kind: "activity", renderKey: "tmp-1", focusCallId: "c1" });
  assert.equal(rightPanelReducer(none, { type: "close" }), none);
  assert.deepEqual(rightPanelReducer(focused, { type: "close" }), none);
  assert.deepEqual(rightPanelReducer(focused, { type: "conversation-changed" }), none);
});

test("research keeps the view the reader is on when the same run is opened again", () => {
  const research = rightPanelReducer({ kind: "none" }, { type: "open-research", runId: "r1" });
  assert.deepEqual(research, { kind: "research", runId: "r1", view: "progress" });
  const onReport = rightPanelReducer(research, { type: "open-research", runId: "r1", view: "report" });
  assert.equal(rightPanelReducer(onReport, { type: "open-research", runId: "r1" }), onReport);
  assert.deepEqual(rightPanelReducer(onReport, { type: "open-research", runId: "r2" }), {
    kind: "research",
    runId: "r2",
    view: "progress",
  });
  // Switching kind inside the open shell: Activity replaces Research outright.
  assert.deepEqual(rightPanelReducer(onReport, { type: "open-activity", renderKey: "m1" }), {
    kind: "activity",
    renderKey: "m1",
  });
});

// ── reconcileRightPanel (bug B1) ─────────────────────────────────────────────

test("the panel stays open across the temp → server id swap at done", () => {
  const state = rightPanelReducer({ kind: "none" }, { type: "open-activity", renderKey: "tmp-42" });
  const streaming = [
    { id: "u1", renderKey: "tmp-41" },
    { id: "tmp-42", renderKey: "tmp-42" },
  ];
  assert.equal(reconcileRightPanel(state, streaming), state);
  // `done`: the server row replaces the temp one, and use-chat carries the key.
  const done = [
    { id: "u1", renderKey: "tmp-41" },
    { id: "msg_server_7", renderKey: "tmp-42" },
  ];
  assert.equal(reconcileRightPanel(state, done), state, "same object: nothing re-renders");
  // The message leaves the list (deleted, regenerated away): the panel closes.
  assert.deepEqual(reconcileRightPanel(state, [{ id: "u1" }]), { kind: "none" });
});

test("a message loaded from history has no renderKey and is matched by its id", () => {
  const state = rightPanelReducer({ kind: "none" }, { type: "open-activity", renderKey: "msg_old" });
  assert.equal(reconcileRightPanel(state, [{ id: "msg_old" }]), state);
  const research: RightPanelState = { kind: "research", runId: "r1", view: "report" };
  assert.equal(reconcileRightPanel(research, []), research, "a run is not a message");
});

// ── Coexistence: newest wins ────────────────────────────────────────────────

test("the shell, the canvas and the file viewer: whichever opened last is the one open", () => {
  const panel = rightColumnReducer(EMPTY_RIGHT_COLUMN, { type: "open-activity", renderKey: "m1" });
  assert.equal(panel.panel.kind, "activity");
  const artifact = rightColumnReducer(panel, { type: "open-artifact", artifactId: "a1" });
  assert.deepEqual(artifact, { panel: { kind: "none" }, artifactId: "a1", documentId: null });
  const document = rightColumnReducer(artifact, { type: "open-document", documentId: "d1" });
  assert.deepEqual(document, { panel: { kind: "none" }, artifactId: null, documentId: "d1" });
  const research = rightColumnReducer(document, { type: "open-research", runId: "r1" });
  assert.deepEqual(research, { panel: { kind: "research", runId: "r1", view: "progress" }, artifactId: null, documentId: null });
  assert.equal(rightColumnReducer(research, { type: "open-research", runId: "r1" }), research);
  assert.equal(rightColumnReducer(research, { type: "close-artifact" }), research);
  assert.deepEqual(rightColumnReducer(research, { type: "conversation-changed" }), EMPTY_RIGHT_COLUMN);
});

test("voice closes a docked column below the split and leaves it beside the split", () => {
  const open = rightColumnReducer(EMPTY_RIGHT_COLUMN, { type: "open-activity", renderKey: "m1" });
  assert.equal(rightColumnReducer(open, { type: "voice-opened", split: true }), open);
  assert.deepEqual(rightColumnReducer(open, { type: "voice-opened", split: false }), EMPTY_RIGHT_COLUMN);
});

test("?researchRun opens the Research panel on the report or the progress", () => {
  assert.deepEqual(researchPanelFromUrl("?researchRun=abc", { completed: true }), {
    type: "open-research",
    runId: "abc",
    view: "report",
  });
  assert.deepEqual(researchPanelFromUrl(new URLSearchParams({ researchRun: " abc " })), {
    type: "open-research",
    runId: "abc",
    view: "progress",
  });
  assert.equal(researchPanelFromUrl("?researchRun="), null);
  assert.equal(researchPanelFromUrl("?other=1"), null);
});

// ── Copy ────────────────────────────────────────────────────────────────────

test("every panel phrase has its German gallery fixture, and the fixture nothing else", () => {
  const missing = ALL_PANEL_PHRASES.filter((phrase) => !(phrase in PANEL_COPY_DE));
  assert.deepEqual(missing, []);
  const extra = Object.keys(PANEL_COPY_DE).filter((phrase) => !ALL_PANEL_PHRASES.includes(phrase));
  assert.deepEqual(extra, []);
});

test("the copy object holds phrases only: no keys, no ids, no template holes", () => {
  for (const phrase of ALL_PANEL_PHRASES) {
    assert.doesNotMatch(phrase, /^juno:|\{|\}|\$\{/, phrase);
    assert.equal(phrase, phrase.trim(), phrase);
  }
  // The copy file must stay a `*_COPY` object for the extractor (§10.1 rule 1).
  assert.match(read(`${PANEL_DIR}/copy.ts`), /export const PANEL_COPY = \{/);
  assert.doesNotMatch(read(`${PANEL_DIR}/copy-de.ts`), /const \w*(?:Copy|COPY) =/i);
});

/** At most one bare phrase per spec, and only first or last (the one-phrase rule, §7.6). */
function assertOnePhrase(spec: PhraseSpec, context: string) {
  const at = spec.parts.flatMap((part, i) => ("phrase" in part ? [i] : []));
  assert.ok(at.length <= 1, `${context}: ${at.length} phrases in one spec`);
  if (at.length === 1) assert.ok(at[0] === 0 || at[0] === spec.parts.length - 1, `${context}: phrase in the middle`);
  for (const part of spec.parts) if ("phrase" in part) assert.ok(ALL_PANEL_PHRASES.includes(part.phrase), part.phrase);
}

test("every notice code has a line, with and without its params, obeying the one-phrase rule", () => {
  const params: Record<string, Record<string, string | number>> = {
    model_changed: { model: "Claude Fable 5.1" },
    skill_not_applied: { skill: "Weekly report" },
    connector_unavailable: { connector: "Linear", reason: "auth_expired" },
    tool_budget: { reason: "rounds", steps: 8 },
    hostile_content: { host: "evil.example" },
    search_degraded: { engine: "tavily" },
    research_skipped: { reason: "budget", resetsOn: "2026-10-01" },
    tools_capped: { dropped: 3 },
  };
  for (const code of RUN_NOTICE_CODES) {
    for (const notice of [{ code }, { code, params: params[code] }]) {
      const line = noticeLine(notice);
      assert.ok(line.length > 0, code);
      for (const spec of line) assertOnePhrase(spec, code);
    }
  }
  assert.equal(
    phraseText(noticeLine({ code: "connector_unavailable", params: { connector: "Linear", reason: "auth_expired" } })),
    "⁨Linear⁩ couldn’t connect. Sign in again in Settings"
  );
  assert.equal(phraseText(noticeLine({ code: "tool_budget", params: { reason: "searches" } })), "Reached this turn’s search limit");
});

// ── Hand-built run views ────────────────────────────────────────────────────

const T0 = Date.UTC(2026, 8, 24, 10, 0, 0);
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

function record(partial: Partial<ToolCallRecord> & Pick<ToolCallRecord, "callId" | "tool" | "status">): ToolCallRecord {
  return { v: 1, origin: partial.tool === "mcp" ? "connector" : "juno", title: "", round: 1, index: 0, startedAt: iso(1), ...partial };
}

function toolItem(call: ToolCallRecord, seq: number): Extract<RunItem, { kind: "tool" }> {
  return { kind: "tool", key: `tool:${call.callId}`, seq, round: call.round, call, live: call.status === "running" };
}

function view(partial: Partial<RunView> = {}): RunView {
  const items = partial.items ?? [];
  return {
    typed: true,
    items,
    tools: items.filter((item): item is Extract<RunItem, { kind: "tool" }> => item.kind === "tool"),
    facts: { memory: [] },
    counts: { sources: 0, searches: 0, codeRuns: 0, filesCreated: 0, connectorsUsed: [], filesRead: [], failedTools: 0, warnings: 0 },
    hasReasoning: false,
    timing: { startedAt: T0, firstAnswerAt: T0 + 12_000, endedAt: T0 + 14_000, workedMs: 12_000 },
    pendingApprovalIds: [],
    latestStepKeys: [],
    ...partial,
  };
}

// ── Tabs ────────────────────────────────────────────────────────────────────

test("a tab with nothing to show is omitted; Timeline is always there", () => {
  assert.deepEqual(activityTabs({ sources: 0, details: false }).map((tab) => tab.id), ["timeline"]);
  const all = activityTabs({ sources: 5, details: true });
  assert.deepEqual(all.map((tab) => [tab.id, tab.count]), [
    ["timeline", undefined],
    ["sources", 5],
    ["details", undefined],
  ]);
  assert.equal(resolveActivityTab("details", all), "details");
  assert.equal(resolveActivityTab("details", activityTabs({ sources: 2, details: false })), "timeline");
  assert.equal(resolveActivityTab("nonsense", all), "timeline");
  assert.equal(resolveActivityTab("sources", all, { focusCall: true }), "timeline", "a focused call opens where it is");
});

// ── Header ──────────────────────────────────────────────────────────────────

test("the header: a static phase word while working, the summary lead at rest", () => {
  const reasoned = view({ hasReasoning: true });
  const live = panelHeaderModel(reasoned, "searching");
  assert.deepEqual(live, { kind: "live", word: PANEL_COPY.phase.searching, since: T0 });
  assert.notEqual(PANEL_COPY.phase.searching, "Searching", "a status word is not the tool rows' verb prefix");

  const rest = panelHeaderModel(reasoned, "done");
  assert.equal(rest.kind, "rest");
  assert.equal(phraseText(rest.kind === "rest" ? rest.line : { parts: [] }), "Thought for 12s");
  assert.equal(panelHeaderModel(reasoned, "answering").kind, "rest", "the answer has started: the lead shows");

  const ranACall = view({ items: [toolItem(record({ callId: "c", tool: "calculate", status: "succeeded" }), 1)] });
  assert.match(phraseText((panelHeaderModel(ranACall, "done") as { line: PhraseSpec }).line), /^Thought for/);
  assert.match(phraseText((panelHeaderModel(view(), "done") as { line: PhraseSpec }).line), /^Answered in/);
  assert.match(phraseText((panelHeaderModel(reasoned, "stopped") as { line: PhraseSpec }).line), /^Stopped after/);
  const failed = panelHeaderModel(reasoned, "failed");
  assert.ok(failed.kind === "rest" && failed.failed);

  const research = { key: "research" as const, runId: "r", title: "T", workedMs: 95_000, cited: 4, read: 9, pages: 12, leadModel: "m", state: "completed" as const };
  assert.equal(phraseText((panelHeaderModel(view(), "done", research) as { line: PhraseSpec }).line), "Researched for 1m 35s");

  // No measured time: no invented duration.
  const untimed = view({ timing: { startedAt: null, firstAnswerAt: null, endedAt: null, workedMs: null } });
  assert.deepEqual(panelHeaderModel(untimed, "done"), { kind: "none" });
  assert.equal(phraseText((panelHeaderModel(untimed, "failed") as { line: PhraseSpec }).line), "Couldn’t finish");
  assert.deepEqual(panelHeaderModel(null, "thinking"), { kind: "none" });
});

// ── Rows ────────────────────────────────────────────────────────────────────

test("a denial or an expiry is a decision, never a failure", () => {
  const states = Object.fromEntries(TOOL_CALL_STATUSES.map((status) => [status, toolRowState({ status })]));
  assert.deepEqual(states, {
    queued: "working",
    awaiting_approval: "waiting",
    running: "working",
    succeeded: "succeeded",
    failed: "failed",
    denied: "declined",
    expired: "declined",
    cancelled: "cancelled",
  });
});

test("Ask to run again: failed third-party calls only, never a refusal", () => {
  const failed = record({ callId: "c", tool: "mcp", status: "failed", error: { code: "tool_error" }, toolTitle: "Create issue", connectorLabel: "GitHub" });
  assert.equal(canAskToRunAgain(failed), true);
  assert.equal(canAskToRunAgain({ ...failed, error: { code: "blocked" } }), false);
  assert.equal(canAskToRunAgain({ ...failed, status: "denied", error: { code: "denied" } }), false);
  assert.equal(canAskToRunAgain({ ...failed, status: "expired", error: { code: "expired" } }), false);
  assert.equal(canAskToRunAgain({ ...failed, origin: "juno", tool: "web_fetch" }), false);
  assert.equal(phraseText(askToRunAgainSpec(failed)), "Try again: ⁨Create issue⁩");
  assertOnePhrase(askToRunAgainSpec(failed), "askToRunAgain");
});

const approval = (partial: Partial<ClientActionApproval> = {}): ClientActionApproval => ({
  id: "ap1",
  surface: "chat",
  sessionId: "s",
  conversationId: null,
  connectorId: "github",
  connectorLabel: "GitHub",
  toolName: "create_issue",
  action: "Create issue",
  riskClass: "external_write",
  preview: "Create issue",
  detail: {},
  receiptDigest: "digest",
  status: "pending",
  decision: null,
  canAllowScope: false,
  derivedFromUntrusted: false,
  expiresAt: iso(900),
  decidedAt: null,
  completedAt: null,
  createdAt: iso(1),
  ...partial,
});

test("a waiting row answers only the live approval its record names", () => {
  const waiting = record({
    callId: "c",
    tool: "mcp",
    status: "awaiting_approval",
    approval: { id: "ap1", status: "pending", riskClass: "external_write" },
  });
  assert.equal(pendingApprovalFor(waiting, [approval()])?.id, "ap1");
  assert.equal(pendingApprovalFor(waiting, [approval({ id: "other" })]), null, "the frame has not arrived yet");
  assert.equal(pendingApprovalFor(waiting, [approval({ status: "allowed" })]), null, "answered on another surface");
  assert.equal(pendingApprovalFor({ ...waiting, status: "running" }, [approval()]), null);

  assert.deepEqual(approvalChoices(approval(), { kind: "idle" }), { allowOnce: true, alwaysAllow: false, decline: true });
  assert.equal(approvalChoices(approval({ canAllowScope: true }), { kind: "idle" }).alwaysAllow, true);
  assert.equal(
    approvalChoices(approval({ canAllowScope: true }), { kind: "refused", phrase: "", retry: true, scopeRefused: true }).alwaysAllow,
    false,
    "a refused standing permission is not offered again"
  );
});

test("receipts say what was decided", () => {
  assert.equal(approvalReceiptPhrase({ status: "executed", decision: "allow_once" }), "Allowed once");
  assert.equal(approvalReceiptPhrase({ status: "allowed", decision: "allow_scope" }), "Always allowed");
  assert.equal(approvalReceiptPhrase({ status: "denied", decision: "deny" }), "You declined this");
  assert.equal(approvalReceiptPhrase({ status: "expired" }), "Approval expired");
  assert.equal(approvalReceiptPhrase({ status: "superseded" }), "Cancelled");
  assert.equal(answeredPhrase("deny"), "You declined this");
});

function fakeFetch(respond: () => Promise<Response> | Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

test("the approval control posts the decision with the digest to the card's endpoint", async () => {
  const ok = fakeFetch(() => new Response(JSON.stringify({ ok: true, approval: approval({ status: "allowed" }) }), { status: 200 }));
  const state = await sendApprovalDecision(approval({ id: "a/b" }), "allow_once", ok.impl);
  assert.equal(ok.calls[0].url, "/api/approvals/a%2Fb");
  assert.equal(ok.calls[0].init?.method, "POST");
  assert.deepEqual(JSON.parse(String(ok.calls[0].init?.body)), { decision: "allow_once", receiptDigest: "digest" });
  assert.equal(state.kind, "answered");
  assert.equal(state.kind === "answered" && state.approval?.status, "allowed");

  const offline = await sendApprovalDecision(approval(), "deny", (async () => {
    throw new TypeError("offline");
  }) as unknown as typeof fetch);
  assert.deepEqual(offline, { kind: "refused", phrase: PANEL_COPY.approval.unreachable, retry: true, scopeRefused: false });

  const decided = fakeFetch(() => new Response(JSON.stringify({ ok: false, code: "already_decided" }), { status: 409 }));
  assert.deepEqual(await sendApprovalDecision(approval(), "allow_once", decided.impl), {
    kind: "refused",
    phrase: PANEL_COPY.approval.alreadyAnswered,
    retry: false,
    scopeRefused: false,
  });
  const scope = fakeFetch(() => new Response(JSON.stringify({ error: "not_scope_allowable" }), { status: 400 }));
  const refusedScope = await sendApprovalDecision(approval(), "allow_scope", scope.impl);
  assert.ok(refusedScope.kind === "refused" && refusedScope.scopeRefused && refusedScope.retry);
  const broken = fakeFetch(() => new Response("oops", { status: 502 }));
  const refused = await sendApprovalDecision(approval(), "allow_once", broken.impl);
  assert.ok(refused.kind === "refused" && refused.retry && refused.phrase === PANEL_COPY.approval.refused);
});

test("the running call owns the panel's loop, else the live reasoning, else nothing", () => {
  const reasoning: RunItem = { kind: "reasoning", key: "r1", seq: 1, round: 1, text: "…", live: true };
  const older = toolItem(record({ callId: "a", tool: "web_fetch", status: "running", startedAt: iso(2) }), 2);
  const newer = toolItem(record({ callId: "b", tool: "web_fetch", status: "running", startedAt: iso(3) }), 3);
  assert.equal(panelLoopItemKey(view({ items: [reasoning, older, newer] }), true), newer.key);
  assert.equal(panelLoopItemKey(view({ items: [reasoning] }), true), "r1");
  assert.equal(panelLoopItemKey(view({ items: [reasoning, older] }), false), null, "nothing loops at rest");
  assert.equal(panelLoopItemKey(null, true), null);
});

test("arguments: the recorded redacted text, else the safe present params, else the reason", () => {
  const call = record({ callId: "c", tool: "web_search", status: "succeeded", args: { query: "heat pumps" } });
  assert.deepEqual(argumentsOf(call, undefined), { text: '{\n  "query": "heat pumps"\n}', truncated: false, noteKey: null });
  assert.deepEqual(argumentsOf(call, { server: "S", name: "n", args: "{}", argsTruncated: true }), { text: "{}", truncated: true, noteKey: null });
  assert.deepEqual(argumentsOf(record({ callId: "d", tool: "mcp", status: "failed" }), { server: "S", name: "n", argsNote: "over_budget" }), {
    text: null,
    truncated: false,
    noteKey: "over_budget",
  });
  assert.deepEqual(clampLines("a\nb\nc", 2), { head: "a\nb", hidden: 1 });
  assert.deepEqual(clampLines("a\nb", 2), { head: "a\nb", hidden: 0 });
  assert.deepEqual(splitHeadline("**Planning the search**\nBody text."), { headline: "Planning the search", body: "Body text." });
  assert.deepEqual(splitHeadline("No headline **here**"), { headline: null, body: "No headline **here**" });
});

// ── Details ─────────────────────────────────────────────────────────────────

test("Details: the model's window when both numbers are known, else the turn's input counts", () => {
  const catalog = (id: string) => (id === "anthropic:claude-fable-5-1" ? { name: "Claude Fable 5.1", contextWindow: 1_000_000 } : null);
  const facts: RunView["facts"] = {
    model: { key: "model", modelId: "anthropic:claude-fable-5-1", provider: "anthropic", label: "Claude Fable 5.1", routed: true },
    effort: { key: "effort", effort: "xhigh", auto: true },
    context: { key: "context", historyMessages: 4, attachments: 0, projectFiles: 2 },
    tools: { key: "tools", offered: ["web_search", "web_fetch", "web_search", "mcp"], nativeSearch: true, roundBudget: 12 },
    connectors: { key: "connectors", ready: [{ id: "gh", label: "GitHub", tools: 9 }], failed: [] },
    memory: [{ id: "m1", content: "Prefers metric units." }],
  };
  const details = detailsModel(view({ facts }), { promptTokens: 18_000, model: null }, catalog);
  assert.deepEqual(details.model, { label: "Claude Fable 5.1", provider: "anthropic", routed: true });
  assert.deepEqual(details.effort, { rung: "xhigh", auto: true });
  assert.deepEqual(details.context, { kind: "tokens", used: 18_000, window: 1_000_000 });
  assert.equal(phraseText(contextLine(details.context!)), "Context used 18,000 tokens. Window 1,000,000 tokens");
  assert.deepEqual(details.tools?.offered, ["web_search", "web_fetch", "mcp"]);
  assert.ok(hasDetails(details));

  const noUsage = detailsModel(view({ facts }), { promptTokens: null, model: null }, catalog);
  assert.deepEqual(noUsage.context, { kind: "counts", historyMessages: 4, attachments: 0, projectFiles: 2 });
  assert.equal(phraseText(contextLine(noUsage.context!)), "4 earlier messages. 2 project files");

  // A message from before facts: the stored model id through the catalog, nothing invented.
  const legacy = detailsModel(view(), { promptTokens: 900, model: "anthropic:claude-fable-5-1" }, catalog);
  assert.deepEqual(legacy.model, { label: "Claude Fable 5.1", provider: null, routed: false });
  assert.deepEqual(legacy.context, { kind: "tokens", used: 900, window: 1_000_000 });
  assert.equal(hasDetails(detailsModel(view(), { promptTokens: null, model: null }, catalog)), false);
});

test("the tool list is phrases, never raw tool ids (INV-28)", () => {
  const names = toolNamePhrases(["web_search", "provider_web_search", "mcp", "run_code"]);
  assert.deepEqual(names, ["Search the web", "The model’s own web search", "Connector tools", "Run code"]);
  for (const name of names) assert.doesNotMatch(name, /_/);
});

// ── Which message, and when the panel re-renders ─────────────────────────────

const message = (partial: Partial<PanelMessage> = {}): PanelMessage => ({
  id: "tmp-1",
  renderKey: "tmp-1",
  role: "ASSISTANT",
  content: "",
  createdAt: iso(0),
  attachments: [],
  activity: [],
  streaming: true,
  ...partial,
});

test("answer tokens alone never hand the panel a new message (U5)", () => {
  const select = createPanelMessageSelector("tmp-1");
  const first = message({ content: "The" });
  const a = select([first]);
  assert.equal(a.message, first);
  // A token: a new message object and a new list, only `content` changed.
  const b = select([{ ...first, content: "The answer" }]);
  assert.equal(b, a, "same selection object: the panel does not re-render");
  // A new activity event: re-render.
  const withEvent = { ...first, content: "The answer", activity: [{ id: "e", kind: "done" as const, title: "Done", createdAt: iso(1) }] };
  const c = select([withEvent]);
  assert.notEqual(c, a);
  assert.equal(c.message, withEvent);
  // A citation appearing in the answer: re-render (the Sources split reads it).
  const cited = { ...withEvent, sources: [{ title: "S", url: "https://s.example/", snippet: "", cited: true }] };
  const d = select([cited]);
  const e = select([{ ...cited, content: "The answer [1]" }]);
  assert.notEqual(e, d);
  assert.equal(select([{ ...cited, content: "The answer [1], and more" }]), e);
});

test("the panel follows its message across the id swap and exits with its last content", () => {
  const select = createPanelMessageSelector("tmp-1");
  const live = message({ activity: [] });
  select([live]);
  const done = message({ id: "msg_server", renderKey: "tmp-1", streaming: false });
  const after = select([done]);
  assert.equal(after.message?.id, "msg_server");
  assert.equal(after.present, true);
  const gone = select([]);
  assert.equal(gone.present, false);
  assert.equal(gone.message, after.message, "the last content stays for the exit");
  assert.equal(select([]), gone);
  assert.ok(!samePanelMessage(live, { ...live, streaming: false }), "the ending changes the header");
  assert.ok(samePanelMessage(live, { ...live }));
});
