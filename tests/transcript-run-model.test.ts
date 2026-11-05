import assert from "node:assert/strict";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { compactTrace } from "@/lib/chat/compact-trace";
import { STEP_LABEL, buildRun, isPageSource, previewLine } from "@/components/chat/thought-process-model";
import { ApprovalCard, pastActionPhrase } from "@/components/chat/approval-card";
import type { ClientActionApproval } from "@/lib/action-approval";
import type { ClientActivityEvent } from "@/types/chat";

/*
 * The transcript's run model and the approval receipt, as the final-screens
 * critique left them: a memory save is never a web source, an untitled page
 * says its domain once, previews end on a word, a cut-short answer says where
 * it stopped, an in-flight call is the run's live row, and a decided approval
 * is a one-line receipt.
 */

// The icon set is written for the automatic JSX runtime; tsx compiles classic.
(globalThis as { React?: typeof React }).React = React;

const T0 = Date.parse("2026-10-25T10:00:00.000Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const ev = (over: Partial<ClientActivityEvent> & Pick<ClientActivityEvent, "id" | "kind" | "title">): ClientActivityEvent => ({
  createdAt: at(0),
  ...over,
});

const MEMORY_SAVED = ev({
  id: "mem-saved",
  kind: "context",
  title: "Memory updated",
  detail: "Halvorsen is the user's largest renewal this quarter.",
  url: "/memory?entry=mem-halvorsen",
  createdAt: at(10),
  memoryWrite: { saved: [{ id: "mem-halvorsen", content: "Halvorsen is the user's largest renewal this quarter.", category: "projects" }] },
});

test("a memory save is never a source: it is a 'Saved to memory' step after the answer", () => {
  const run = buildRun(
    [
      ev({ id: "t1", kind: "tool", title: "Using Stripe", detail: "list subscriptions", createdAt: at(2), tool: { server: "Stripe", name: "stripe__list_subscriptions", args: "{}", result: "…", status: "ok" } }),
      ev({ id: "w", kind: "write", title: "Writing", createdAt: at(8) }),
      MEMORY_SAVED,
      ev({ id: "u", kind: "usage", title: "Token usage recorded", detail: "1,200 input · 300 output", createdAt: at(11) }),
      ev({ id: "d", kind: "done", title: "Finished response", createdAt: at(11) }),
    ],
    null,
  );
  assert.equal(run.sourceCount, 0, "the memory page is not a page the run read");
  assert.deepEqual(run.sources, []);
  assert.equal(run.steps.some((s) => s.kind === "source"), false);
  assert.equal(run.phases.some((p) => p.key === "research"), false, "no Research section for a turn that read nothing");

  const kinds = run.steps.map((s) => s.kind);
  const saved = run.steps.find((s) => s.kind === "remember");
  assert.ok(saved, "the save is a step of its own");
  assert.equal(saved.label, STEP_LABEL.savedMemory);
  assert.equal(saved.detail, "Halvorsen is the user's largest renewal this quarter.");
  assert.equal(saved.href, "/memory?entry=mem-halvorsen");
  assert.equal(saved.icon, "memory");
  assert.equal(saved.phase, "write");
  assert.ok(kinds.indexOf("remember") > kinds.indexOf("write"), "saved after the answer was written");
  assert.equal(run.facts.find((f) => f.label === "Context"), undefined, "a memory write is not the run's context");

  // The inline trace keeps it as its own row, not under Sources or Memories used.
  const rows = compactTrace(run);
  assert.equal(rows.some((r) => r.kind === "sources"), false);
  assert.equal(rows.some((r) => r.kind === "memory"), false);
  assert.ok(rows.some((r) => r.kind === "step" && r.stepKind === "remember" && r.label === STEP_LABEL.savedMemory));
});

test("a forget reads as removed from memory, and a real page is still a source", () => {
  const run = buildRun(
    [
      ev({ id: "v1", kind: "visit", title: "Read source", detail: "Peace of Westphalia", url: "https://en.wikipedia.org/wiki/Peace_of_Westphalia" }),
      ev({ id: "w", kind: "write", title: "Writing", createdAt: at(4) }),
      ev({ id: "f", kind: "context", title: "Forgotten", detail: "where I work", url: "/memory", createdAt: at(6), memoryWrite: { saved: [], forgotten: ["where I work"] } }),
      ev({ id: "u", kind: "usage", title: "Token usage recorded", createdAt: at(7) }),
    ],
    null,
  );
  assert.equal(run.sourceCount, 1);
  assert.equal(run.sources[0].url, "https://en.wikipedia.org/wiki/Peace_of_Westphalia");
  const removed = run.steps.find((s) => s.kind === "remember");
  assert.equal(removed?.label, STEP_LABEL.forgotMemory);
  assert.equal(removed?.href, "/memory");

  assert.equal(isPageSource({ kind: "visit", url: "https://a.org/x" }), true);
  assert.equal(isPageSource({ kind: "visit", url: "/memory?entry=1" }), false, "an in-app path is not a web page");
  assert.equal(isPageSource({ kind: "context", url: "https://a.org/x" }), false);
  assert.equal(isPageSource({ kind: "visit" }), false);
});

test("an untitled page says its domain once", () => {
  const run = buildRun(
    [
      ev({ id: "v1", kind: "visit", title: "Read source", url: "https://docs.anthropic.com/en/x" }),
      ev({ id: "v2", kind: "visit", title: "Listed source", url: "https://anthropic.com/news" }),
      ev({ id: "v3", kind: "visit", title: "Read source", detail: "Pricing", url: "https://anthropic.com/pricing" }),
      ev({ id: "v4", kind: "visit", title: "Listed source", detail: "Models", url: "https://anthropic.com/models" }),
    ],
    null,
  );
  const detail = (id: string) => run.steps.find((s) => s.id === id)?.detail;
  assert.equal(run.steps.find((s) => s.id === "v1")?.label, "docs.anthropic.com");
  assert.equal(detail("v1"), null);
  assert.equal(detail("v2"), "listed");
  assert.equal(detail("v3"), "anthropic.com");
  assert.equal(detail("v4"), "anthropic.com · listed");
});

test("a reasoning preview ends on a whole word with the ellipsis set tight", () => {
  assert.equal(previewLine("  Short   and\n\nsweet. "), "Short and sweet.");
  assert.equal(previewLine(""), null);
  assert.equal(previewLine(null), null);
  const long = "The user wants a comparison of three plans, so I should give the pricing shape first and then the caveats that matter.";
  const cut = previewLine(long, 90);
  assert.ok(cut);
  assert.ok(cut.length <= 91);
  assert.ok(cut.endsWith("…"));
  assert.ok(!/\s…$/.test(cut), "no stray space before the ellipsis");
  assert.ok(long.startsWith(cut.slice(0, -1)), "a prefix of the text");
  assert.ok(long.charAt(cut.length - 1) === " " || /[,;:.]/.test(long.charAt(cut.length - 1)), "cut at a word boundary, not mid-word");
  // A part's detail line is the preview.
  const run = buildRun([], null, null, { reasoningParts: [`**Pricing**\n\n${long}`] });
  assert.equal(run.steps[0].detail, cut);
});

test("an answer the finish cut short says where it stopped", () => {
  const events = (warning: string | null) => [
    ev({ id: "w", kind: "write", title: "Writing", createdAt: at(2) }),
    ...(warning ? [ev({ id: "x", kind: "warning", title: warning, createdAt: at(9) })] : []),
    ev({ id: "u", kind: "usage", title: "Token usage recorded", createdAt: at(9) }),
  ];
  const cut = buildRun(events("Response hit the token limit"), null).steps.find((s) => s.kind === "write");
  assert.equal(cut?.label, STEP_LABEL.stoppedWriting);
  assert.equal(cut?.failed, true);
  const stopped = buildRun(events("Stopped by user"), null).steps.find((s) => s.kind === "write");
  assert.equal(stopped?.label, STEP_LABEL.stoppedWriting);
  const clean = buildRun(events(null), null).steps.find((s) => s.kind === "write");
  assert.equal(clean?.label, STEP_LABEL.wrote);
  assert.equal(clean?.failed, false);
  // A non-fatal warning is not a cut.
  const other = buildRun(events("Linear did not respond"), null).steps.find((s) => s.kind === "write");
  assert.equal(other?.label, STEP_LABEL.wrote);
});

test("a call in flight is the run's live row, in the present tense", () => {
  const live = buildRun(
    [
      ev({ id: "r", kind: "reasoning", title: "Thinking", createdAt: at(1) }),
      ev({ id: "t1", kind: "tool", title: "Using Stripe", detail: "search subscriptions", createdAt: at(2), tool: { server: "Stripe", name: "stripe__search_subscriptions", args: "{}" } }),
    ],
    T0 + 5000,
  );
  const call = live.steps.find((s) => s.id === "t1");
  assert.equal(call?.running, true);
  assert.equal(call?.ms, null);
  assert.equal(live.steps.filter((s) => s.running).length, 1, "one running row");
  assert.equal(live.steps.some((s) => s.id === "running"), false, "no generic Thinking row beside it");

  const answered = buildRun(
    [
      ev({ id: "t1", kind: "tool", title: "Using Stripe", createdAt: at(2), tool: { server: "Stripe", name: "stripe__search_subscriptions", args: "{}", result: "[]", status: "ok", durationMs: 800 } }),
    ],
    T0 + 5000,
  );
  assert.equal(answered.steps.find((s) => s.id === "t1")?.running, false);
  assert.equal(answered.steps.find((s) => s.id === "t1")?.ms, 800);
  assert.equal(answered.steps.find((s) => s.id === "running")?.label, STEP_LABEL.thinking);

  // Settled, nothing runs.
  const settled = buildRun(
    [ev({ id: "t1", kind: "tool", title: "Using Stripe", createdAt: at(2), tool: { server: "Stripe", name: "stripe__search_subscriptions", args: "{}" } })],
    null,
  );
  assert.equal(settled.steps.some((s) => s.running), false);
});

const SLACK_POST = "Q3 renewals: Stripe is €26,000 under forecast.";
function approval(over: Partial<ClientActionApproval>): ClientActionApproval {
  return {
    id: "ap-slack",
    surface: "chat",
    sessionId: "s",
    conversationId: "c",
    connectorId: "slack",
    connectorLabel: "Slack",
    toolName: "slack__post_message",
    action: "connector.slack.post_message",
    riskClass: "external_write",
    preview: `#design in Northwind Slack, as you: ${SLACK_POST}`,
    detail: { channel: "#design", text: SLACK_POST },
    receiptDigest: "digest",
    status: "pending",
    decision: null,
    canAllowScope: true,
    derivedFromUntrusted: false,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    decidedAt: null,
    completedAt: null,
    createdAt: at(0),
    ...over,
  } as ClientActionApproval;
}

test("a decided approval is a one-line receipt, past tense, with what was sent behind a disclosure", () => {
  assert.equal(pastActionPhrase("slack__post_message", "Slack"), "Posted message in Slack");
  assert.equal(pastActionPhrase("linear__create_issue", "Linear"), "Created issue in Linear");
  assert.equal(pastActionPhrase("drive__frobnicate", "Drive"), null);

  const done = renderToStaticMarkup(
    React.createElement(ApprovalCard, { approval: approval({ status: "executed", decision: "allow_once", decidedAt: at(40), completedAt: at(41) }) }),
  );
  assert.match(done, /Posted message in Slack/);
  assert.match(done, /What was sent/);
  assert.ok(!done.includes("cannot take it back"), "the pre-decision warning is gone");
  assert.ok(!done.includes("Exactly what will be sent"), "no future tense on a finished action");
  assert.ok(!done.includes(SLACK_POST), "the payload waits behind the disclosure");
  assert.match(done, /aria-expanded="false"/);

  const denied = renderToStaticMarkup(
    React.createElement(ApprovalCard, { approval: approval({ status: "denied", decision: "deny", decidedAt: at(40) }) }),
  );
  assert.match(denied, /Post message in Slack/);
  assert.match(denied, /You declined this/);
  assert.match(denied, /What would have been sent/);

  // The question itself is unchanged: the payload, the consequence, the verbs.
  const pending = renderToStaticMarkup(React.createElement(ApprovalCard, { approval: approval({}) }));
  assert.match(pending, /Needs your approval/);
  assert.ok(pending.includes(SLACK_POST));
  assert.match(pending, /cannot take it back/);
  assert.match(pending, /Exactly what will be sent/);
});
