"use client";

import * as React from "react";

import { ActivityPanel } from "@/components/chat/panel/activity-panel";
import { PANEL_COPY } from "@/components/chat/panel/copy";
import { PanelPortsProvider, type PanelPorts } from "@/components/chat/panel/panel-ports";
import { RightColumnShell } from "@/components/chat/panel/right-column-shell";
import { PanelMessagesProvider, type PanelMessage } from "@/components/chat/panel/use-panel-message";
import { THOUGHT_DEFAULT_WIDTH, thoughtWidthBounds } from "@/components/chat/split-layout";
import { useSplitPane } from "@/hooks/use-split-pane";
import type { ClientActionApproval } from "@/lib/action-approval";
import type { ClientActivityEvent } from "@/types/chat";
import type { ToolCallRecord } from "@/types/run";

/*
 * The Activity panel's states for the `/dev/run` gallery (SPEC §11.1): the
 * gallery's "panel open" toggle mounts the shell and the panel beside the
 * transcript from here, on the message the player is driving (`messages`), or
 * on one of the fixed panel states below when the gallery names one by its
 * `renderKey`.
 *
 * The fixed states are persisted-shape messages — typed activity with `seq`,
 * facts, notices, approvals — so they go through the real run view like any
 * reloaded message, and cover what a script cannot reach quickly: a pending
 * approval with its decision control, every failure shape with its detail, a
 * page that carried injected instructions, the Details rows with memory, and a
 * pre-rework message through the legacy adapter.
 */

export interface RunPanelStatesProps {
  open: boolean;
  /** The renderKey of the message the panel follows; null closes it. */
  renderKey: string | null;
  mode: "column" | "sheet";
  onClose(): void;
  /** The player's live list. Absent: the panel shows the fixed state named by `renderKey`. */
  messages?: ReadonlyArray<PanelMessage>;
  /** Overrides for the panel's run-UI ports (e.g. a fixed clock for screenshots). */
  ports?: Partial<PanelPorts>;
  /** The gallery's `@container/split` box, whose width bounds the column's drag (chat-view's layout root). */
  containerRef?: React.RefObject<HTMLElement | null>;
}

// ── Fixed panel states ────────────────────────────────────────────────────────

const START = Date.UTC(2026, 8, 24, 10, 0, 0);
const at = (seconds: number) => new Date(START + seconds * 1000).toISOString();

function events(list: Array<Omit<ClientActivityEvent, "id" | "createdAt" | "seq"> & { t: number }>, id: string) {
  return list.map(({ t, ...event }, i): ClientActivityEvent => ({
    id: `${id}-${i + 1}`,
    seq: i + 1,
    createdAt: at(t),
    ...event,
  }));
}

function call(partial: Partial<ToolCallRecord> & Pick<ToolCallRecord, "callId" | "tool" | "status">, t: number): ToolCallRecord {
  return {
    v: 1,
    origin: partial.tool === "mcp" ? "connector" : partial.tool.startsWith("provider_") ? "provider" : "juno",
    title: "",
    round: 1,
    index: 0,
    startedAt: at(t),
    ...partial,
  };
}

const facts = (t: number) => [
  {
    t,
    kind: "model" as const,
    title: "Selected model",
    fact: { key: "model" as const, modelId: "anthropic:claude-fable-5-1", provider: "anthropic", label: "Claude Fable 5.1" },
  },
  { t, kind: "reasoning" as const, title: "Reasoning mode enabled", fact: { key: "effort" as const, effort: "high" as const, auto: false } },
  {
    t,
    kind: "context" as const,
    title: "Tools ready",
    fact: {
      key: "tools" as const,
      offered: ["web_search", "web_fetch", "run_code", "calculate", "current_time", "mcp"] as ToolCallRecord["tool"][],
      nativeSearch: false,
      roundBudget: 12,
    },
  },
];

const SOURCES_STATE: PanelMessage = {
  id: "panel-sources",
  renderKey: "panel-sources",
  role: "ASSISTANT",
  createdAt: at(0),
  attachments: [],
  model: "anthropic:claude-fable-5-1",
  promptTokens: 18_420,
  reasoning:
    "**Planning the search**\nThe question is about this year's panel efficiency records, so I should look for the lab announcements first.\n\nTwo results look like primary sources; I will read both before answering.",
  content:
    "The record for a commercial-size module is now 27.1 % [1], while laboratory tandem cells have passed 34 % [2]. Both figures come from the manufacturers' own announcements [1][2].",
  sources: [
    { title: "Module efficiency record confirmed", url: "https://www.example-solar.com/news/record", snippet: "", cited: true, origin: "juno_search" },
    { title: "Tandem cells pass 34 percent", url: "https://lab.example.org/tandem-34", snippet: "", cited: true, origin: "juno_search" },
    { title: "Efficiency tables, version 68", url: "https://journal.example.net/tables-68", snippet: "", cited: true, origin: "juno_search" },
  ],
  activity: events(
    [
      ...facts(0),
      { t: 1, kind: "reasoning", title: "Thinking", segment: { round: 1, offset: 0 } },
      {
        t: 4,
        kind: "search",
        title: "Searching the web",
        detail: "solar module efficiency record 2026",
        call: call(
          {
            callId: "s1",
            tool: "web_search",
            status: "succeeded",
            title: "Web search",
            endedAt: at(5),
            durationMs: 1_240,
            args: { query: "solar module efficiency record 2026" },
            figure: { kind: "results", n: 3 },
            web: {
              query: "solar module efficiency record 2026",
              engine: "tavily",
              results: [
                { n: 1, title: "Module efficiency record confirmed", url: "https://www.example-solar.com/news/record" },
                { n: 2, title: "Tandem cells pass 34 percent", url: "https://lab.example.org/tandem-34" },
                { n: 3, title: "Efficiency tables, version 68", url: "https://journal.example.net/tables-68" },
              ],
            },
          },
          4
        ),
      },
      {
        t: 6,
        kind: "visit",
        title: "Visited source",
        detail: "Module efficiency record confirmed",
        url: "https://www.example-solar.com/news/record",
        call: call(
          {
            callId: "f1",
            tool: "web_fetch",
            status: "succeeded",
            round: 2,
            title: "Read web page",
            endedAt: at(8),
            durationMs: 1_900,
            args: { url: "https://www.example-solar.com/news/record" },
            figure: { kind: "chars", n: 8_000 },
            web: {
              requestedUrl: "https://www.example-solar.com/news/record",
              finalUrl: "https://www.example-solar.com/news/record",
              contentType: "html",
              chars: 8_000,
              totalChars: 21_400,
            },
          },
          6
        ),
      },
      {
        t: 6,
        kind: "visit",
        title: "Visited source",
        detail: "lab.example.org",
        url: "https://lab.example.org/tandem-34",
        call: call(
          {
            callId: "f2",
            tool: "web_fetch",
            status: "succeeded",
            round: 2,
            index: 1,
            title: "Read web page",
            endedAt: at(9),
            durationMs: 2_600,
            args: { url: "https://lab.example.org/tandem-34" },
            figure: { kind: "chars", n: 5_120 },
            web: {
              requestedUrl: "https://lab.example.org/tandem-34",
              finalUrl: "https://lab.example.org/tandem-34",
              contentType: "html",
              chars: 5_120,
              totalChars: 5_120,
              injection: "suspicious",
            },
          },
          6
        ),
      },
      { t: 11, kind: "write", title: "Writing the answer" },
      { t: 14, kind: "done", title: "Done" },
    ],
    "panel-sources"
  ),
};

const PENDING_APPROVAL: ClientActionApproval = {
  id: "approval-1",
  surface: "chat",
  sessionId: "panel-approval",
  conversationId: null,
  connectorId: "github",
  connectorLabel: "GitHub",
  toolName: "create_issue",
  action: "Create issue",
  riskClass: "external_write",
  preview: "Create an issue titled “Panel exits too early” in juno/web",
  detail: { repository: "juno/web", title: "Panel exits too early" },
  receiptDigest: "digest-1",
  status: "pending",
  decision: null,
  canAllowScope: true,
  derivedFromUntrusted: false,
  expiresAt: new Date(START + 15 * 60_000).toISOString(),
  decidedAt: null,
  completedAt: null,
  createdAt: at(3),
};

const APPROVAL_STATE: PanelMessage = {
  id: "panel-approval",
  renderKey: "panel-approval",
  role: "ASSISTANT",
  createdAt: at(0),
  attachments: [],
  streaming: true,
  content: "",
  reasoning: "The person asked me to file this as an issue, so I will create it in the web repository.",
  approvals: [PENDING_APPROVAL],
  activity: events(
    [
      ...facts(0),
      { t: 1, kind: "reasoning", title: "Thinking", segment: { round: 1, offset: 0 } },
      {
        t: 3,
        kind: "tool",
        title: "Using GitHub",
        detail: "github__create_issue",
        call: call(
          {
            callId: "c1",
            tool: "mcp",
            status: "awaiting_approval",
            title: "Create issue",
            connectorId: "github",
            connectorLabel: "GitHub",
            toolTitle: "Create issue",
            timeoutMs: 60_000,
            approval: { id: "approval-1", status: "pending", riskClass: "external_write", expiresAt: PENDING_APPROVAL.expiresAt },
          },
          3
        ),
        tool: {
          server: "GitHub",
          name: "github__create_issue",
          args: JSON.stringify({ repository: "juno/web", title: "Panel exits too early" }, null, 2),
          resultNote: "pending",
        },
      },
    ],
    "panel-approval"
  ),
};

const FAILURES_STATE: PanelMessage = {
  id: "panel-failures",
  renderKey: "panel-failures",
  role: "ASSISTANT",
  createdAt: at(0),
  attachments: [],
  content: "I couldn’t reach GitHub, and the page you linked would not open, so this answer is from what I already know.",
  activity: events(
    [
      ...facts(0),
      {
        t: 0,
        kind: "warning",
        title: "Linear is unavailable",
        notice: { code: "connector_unavailable", params: { connector: "Linear", reason: "auth_expired" } },
      },
      {
        t: 2,
        kind: "tool",
        title: "Using GitHub",
        detail: "github__list_pull_requests",
        call: call(
          {
            callId: "c1",
            tool: "mcp",
            status: "failed",
            title: "List pull requests",
            connectorId: "github",
            connectorLabel: "GitHub",
            toolTitle: "List pull requests",
            endedAt: at(4),
            durationMs: 2_010,
            error: { code: "tool_error", detail: "HTTP 502 from api.github.com" },
          },
          2
        ),
        tool: {
          server: "GitHub",
          name: "github__list_pull_requests",
          args: JSON.stringify({ repository: "juno/web", state: "open" }, null, 2),
          result: "upstream connect error or disconnect/reset before headers",
          status: "failed",
          durationMs: 2_010,
        },
      },
      {
        t: 5,
        kind: "visit",
        title: "Visited source",
        detail: "intranet.example.com",
        call: call(
          {
            callId: "f1",
            tool: "web_fetch",
            status: "failed",
            round: 2,
            title: "Read web page",
            endedAt: at(6),
            args: { url: "https://intranet.example.com/roadmap" },
            error: { code: "url_not_accessible", detail: "HTTP 403" },
            web: { requestedUrl: "https://intranet.example.com/roadmap" },
          },
          5
        ),
      },
      {
        t: 7,
        kind: "tool",
        title: "Using GitHub",
        detail: "github__close_issue",
        call: call(
          {
            callId: "c2",
            tool: "mcp",
            status: "denied",
            round: 2,
            index: 1,
            title: "Close issue",
            connectorId: "github",
            connectorLabel: "GitHub",
            toolTitle: "Close issue",
            endedAt: at(20),
            error: { code: "denied" },
            approval: {
              id: "approval-2",
              status: "denied",
              riskClass: "destructive_or_sensitive",
              decision: "deny",
              decidedAt: at(20),
            },
          },
          7
        ),
      },
      { t: 21, kind: "context", title: "Stopped using tools", notice: { code: "tool_budget", params: { reason: "rounds", steps: 3 } } },
      { t: 22, kind: "write", title: "Writing the answer" },
      { t: 25, kind: "done", title: "Done" },
    ],
    "panel-failures"
  ),
};

const DETAILS_STATE: PanelMessage = {
  id: "panel-details",
  renderKey: "panel-details",
  role: "ASSISTANT",
  createdAt: at(0),
  attachments: [],
  model: "anthropic:claude-fable-5-1",
  promptTokens: 42_310,
  content: "Your standing preference is metric units, so the figures below are in kilometres.",
  activity: events(
    [
      ...facts(0),
      { t: 0, kind: "context", title: "Context", fact: { key: "context", historyMessages: 12, attachments: 1, projectFiles: 3 } },
      {
        t: 0,
        kind: "tool",
        title: "Connected tools ready",
        detail: "GitHub",
        fact: {
          key: "connectors",
          ready: [{ id: "github", label: "GitHub", tools: 14 }],
          failed: [{ id: "linear", label: "Linear", reason: "auth_expired" }],
        },
      },
      {
        t: 0,
        kind: "context",
        title: "Memory used",
        detail: "2 memories",
        fact: { key: "memory" },
        memoryReceipt: [
          { id: "mem-1", content: "Prefers metric units.", category: "preference", sourceRef: "manual" },
          { id: "mem-2", content: "Is training for a half marathon in November.", category: "goal", sourceRef: "conv-123" },
        ],
      },
      { t: 1, kind: "write", title: "Writing the answer" },
      { t: 3, kind: "done", title: "Done" },
    ],
    "panel-details"
  ),
};

/** A pre-rework row: no `seq`, English titles, glued content (INV-20). */
const LEGACY_STATE: PanelMessage = {
  id: "panel-legacy",
  renderKey: "panel-legacy",
  role: "ASSISTANT",
  createdAt: at(0),
  attachments: [],
  model: "openai:gpt-5.5",
  reasoning: "Looking for the release notes first.",
  content: "Let me look that up.The release shipped on 12 September.",
  sources: [{ title: "Release notes", url: "https://example.com/releases", snippet: "" }],
  activity: [
    { id: "l1", kind: "search", title: "Searching the web", detail: "release notes september", createdAt: at(1) },
    { id: "l2", kind: "visit", title: "Visited source", url: "https://example.com/releases", createdAt: at(2) },
    {
      id: "l3",
      kind: "tool",
      title: "Using GitHub",
      detail: "github__list_releases",
      createdAt: at(3),
      tool: { server: "GitHub", name: "github__list_releases", argsNote: "empty", result: "[]", status: "ok", durationMs: 640 },
    },
    { id: "l4", kind: "warning", title: "Search was limited", detail: "One engine did not answer.", createdAt: at(4) },
    { id: "l5", kind: "write", title: "Writing the answer", createdAt: at(5) },
    { id: "l6", kind: "done", title: "Done", createdAt: at(6) },
  ],
};

/** Every fixed panel state, by `renderKey`. */
export const PANEL_STATE_FIXTURES: ReadonlyArray<{ renderKey: string; title: string; message: PanelMessage }> = [
  { renderKey: "panel-sources", title: "Search, two reads, cited answer", message: SOURCES_STATE },
  { renderKey: "panel-approval", title: "Waiting for approval", message: APPROVAL_STATE },
  { renderKey: "panel-failures", title: "Failures, a denial and notices", message: FAILURES_STATE },
  { renderKey: "panel-details", title: "Details with memory", message: DETAILS_STATE },
  { renderKey: "panel-legacy", title: "Pre-rework message", message: LEGACY_STATE },
];

const FIXTURE_MESSAGES: ReadonlyArray<PanelMessage> = PANEL_STATE_FIXTURES.map((fixture) => fixture.message);

const NO_PORTS: Partial<PanelPorts> = {};

export function RunPanelStates({
  open,
  renderKey,
  mode,
  onClose,
  messages,
  ports = NO_PORTS,
  containerRef: splitRef,
}: RunPanelStatesProps) {
  const ownRef = React.useRef<HTMLElement | null>(null);
  const containerRef = splitRef ?? ownRef;
  const [shownKey, setShownKey] = React.useState(renderKey);
  // Keep the last message's content through the exit, as chat-view does.
  if (renderKey && renderKey !== shownKey) setShownKey(renderKey);
  const pane = useSplitPane({
    storageKey: "juno:dev-run-panel-width",
    containerRef,
    bounds: thoughtWidthBounds,
    resetWidth: () => null,
    cssWidth: THOUGHT_DEFAULT_WIDTH,
    applies: () => mode === "column",
    active: open,
  });
  const shown = open && renderKey != null;

  return (
    <PanelPortsProvider ports={ports}>
        <PanelMessagesProvider messages={messages ?? FIXTURE_MESSAGES}>
          <RightColumnShell
            open={shown}
            label={PANEL_COPY.activity}
            header={null}
            onClose={onClose}
            pane={pane}
            mode={mode}
            onExited={() => {
              if (!renderKey) setShownKey(null);
            }}
          >
            {shownKey ? (
              <ActivityPanel renderKey={shownKey} onClose={onClose} coversChat={() => mode === "sheet"} seedDraft={() => {}} />
            ) : null}
          </RightColumnShell>
        </PanelMessagesProvider>
    </PanelPortsProvider>
  );
}
