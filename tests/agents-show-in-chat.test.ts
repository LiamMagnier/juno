import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkRunPanel } from "@/components/chat/work-run-panel";
import type { ConversationWork } from "@/components/chat/use-conversation-work";
import type { ClientWorkRun, ClientWorkSession } from "@/lib/work/serializers";

/*
 * An agent profile's "Show in chat" / "Answer in chat" closes the profile and
 * scrolls the thread to the task. It looked for `[data-work-run-panel]` and
 * `[data-work-task-card]`, and no element anywhere carried either, so the
 * button closed the profile and scrolled nowhere. The task's panel now names
 * itself with the session it draws, and the profile looks for that.
 */

// `tsx` compiles JSX with the classic runtime, and a few leaf components the
// panel draws (the icon set) use JSX without importing React themselves.
(globalThis as { React?: typeof React }).React = React;

const AGENT_PANEL = readFileSync(new URL("../src/components/agents/agent-panel.tsx", import.meta.url), "utf8");

const SESSION = {
  id: "session_42",
  projectId: null,
  conversationId: "conv_1",
  title: "Reconcile Q3 invoices",
  titleSource: "model",
  goal: "Reconcile Q3 invoices",
  status: "running",
  needsAttention: false,
  requestedTarget: "automatic",
  preferredHostId: null,
  requestedModel: null,
  reasoningEffort: null,
  permissionPolicy: "balanced",
  pinned: false,
  archived: false,
  lastActivityAt: "2026-09-30T10:00:00.000Z",
  createdAt: "2026-09-30T09:50:00.000Z",
  updatedAt: "2026-09-30T10:00:00.000Z",
} as ClientWorkSession;

const RUN = {
  id: "run_1",
  sessionId: SESSION.id,
  attempt: 1,
  origin: "manual",
  scheduleId: null,
  status: "running",
  terminalReason: null,
  terminalDetail: null,
  requestedTarget: "automatic",
  effectiveTarget: "cloud",
  hostId: null,
  requestedModel: null,
  effectiveModel: "claude-sonnet-5",
  requiredCapabilities: [],
  availableCapabilities: [],
  degradation: [],
  approvalMode: "balanced",
  approvalModeNarrowedByHost: false,
  planVersion: 1,
  budget: { maxCostMicroUsd: 2_000_000, maxTokens: 400_000, maxRuntimeMs: 1_800_000 },
  usage: { costMicroUsd: 184_000, inputTokens: 120_000, outputTokens: 9_400 },
  inputSensitivity: "internal",
  outputSensitivity: "internal",
  lastSeq: 0,
  startedAt: "2026-09-30T09:51:00.000Z",
  finishedAt: null,
  createdAt: "2026-09-30T09:50:00.000Z",
  updatedAt: "2026-09-30T10:00:00.000Z",
} as unknown as ClientWorkRun;

const noop = async () => true;

const WORK: ConversationWork = {
  session: SESSION,
  run: RUN,
  events: [],
  plan: [],
  questions: [],
  openApprovals: [],
  currentAction: null,
  pendingSteers: [],
  documents: { artifacts: [], failed: false, reload: () => {} } as unknown as ConversationWork["documents"],
  busy: false,
  steering: null,
  decide: noop,
  answer: noop,
  adopt: () => {},
};

/** Every `[data-…]` attribute the profile's scroll looks for. */
function queriedAttributes(source: string): string[] {
  return [...source.matchAll(/querySelector(?:All)?(?:<[^>]+>)?\("([^"]+)"\)/g)]
    .flatMap((match) => [...match[1].matchAll(/\[(data-[a-z-]+)/g)].map((attr) => attr[1]));
}

test("the task panel in the transcript carries the attribute and its session", () => {
  const html = renderToStaticMarkup(React.createElement(WorkRunPanel, { work: WORK }));
  assert.match(html, /<section[^>]*\bdata-work-run-panel="session_42"/);
});

test("the profile looks only for attributes that a rendered panel carries", () => {
  const html = renderToStaticMarkup(React.createElement(WorkRunPanel, { work: WORK }));
  const queried = queriedAttributes(AGENT_PANEL);
  assert.ok(queried.includes("data-work-run-panel"), "expected Show in chat to look for the task panel");
  for (const attribute of queried) {
    assert.match(html, new RegExp(`\\b${attribute}=`), `agent-panel.tsx looks for [${attribute}], which nothing renders`);
  }
  // The attribute that never existed must not come back as a silent no-op.
  assert.doesNotMatch(AGENT_PANEL, /data-work-task-card/);
});

test("Show in chat prefers the panel of the agent's own task", () => {
  assert.match(AGENT_PANEL, /panel\.dataset\.workRunPanel === task\?\.sessionId/);
});
