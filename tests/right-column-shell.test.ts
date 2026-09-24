import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ActivityDetailsTab } from "@/components/chat/panel/activity-details-tab";
import { ActivityPanel } from "@/components/chat/panel/activity-panel";
import { ActivitySourcesTab } from "@/components/chat/panel/activity-sources-tab";
import { PanelPortsProvider, type PanelPorts } from "@/components/chat/panel/panel-ports";
import { RightColumnShell, type RightColumnShellProps } from "@/components/chat/panel/right-column-shell";
import {
  createExitWatcher,
  createShellFocus,
  EXIT_FALLBACK_SLACK_MS,
  exitFallbackMs,
  parseCssDuration,
  type FocusTarget,
  type TimerPorts,
} from "@/components/chat/panel/shell-focus";
import { PanelMessagesProvider, type PanelMessage } from "@/components/chat/panel/use-panel-message";
import type { SplitPane } from "@/hooks/use-split-pane";
import { splitSources } from "@/lib/panel/sources-split";
import type { PhraseLine, RunItem, RunView, ToolPresentation } from "@/lib/run/types";
import type { ToolCallRecord } from "@/types/run";

/*
 * The right-column shell (SPEC §8.2), restated against the pure
 * `shell-focus.ts` (§13 harness rule 4: no DOM): where focus goes on open and
 * close, and when the exit counts as finished. Then what the shell and the
 * Activity panel render, through `renderToStaticMarkup` with hand-built views
 * and fake run-UI ports. Owned by WS6.
 */

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

test("shell-focus stays pure: no DOM globals, no server-only", () => {
  const source = read("src/components/chat/panel/shell-focus.ts");
  assert.doesNotMatch(source, /^import "server-only";/m);
  assert.doesNotMatch(source.replace(/\/\*[\s\S]*?\*\//g, ""), /\bdocument\.|\bwindow\./);
});

// ── Focus ───────────────────────────────────────────────────────────────────

function target(name: string, log: string[], connected = true): FocusTarget {
  return {
    focus: (options) => {
      log.push(`${name}${options?.preventScroll ? " (no scroll)" : ""}`);
    },
    isConnected: connected,
  };
}

const scopeOf = (...inside: unknown[]) => ({ contains: (node: unknown) => inside.includes(node) });

test("open moves focus to the heading and remembers the opener; close hands it back", () => {
  const log: string[] = [];
  const focus = createShellFocus();
  const opener = target("run line", log);
  const heading = target("h2", log);
  focus.open(opener, heading);
  assert.deepEqual(log, ["h2 (no scroll)"], "the chat must not scroll when focus moves into the column");
  assert.equal(focus.returnTo, opener);

  // Focus is inside the panel when it closes: it goes back to the opener.
  const closeButton = {};
  assert.equal(focus.close(closeButton, scopeOf(closeButton)), opener);
  assert.deepEqual(log, ["h2 (no scroll)", "run line (no scroll)"]);
  assert.equal(focus.returnTo, null);
});

test("a second open keeps the first opener; focus left elsewhere stays where the reader put it", () => {
  const log: string[] = [];
  const focus = createShellFocus();
  const opener = target("run line", log);
  const heading = target("h2", log);
  focus.open(opener, heading);
  // A tab switch or a new run re-opens while open: the way back is unchanged.
  focus.open(target("tab", log), heading);
  assert.equal(focus.returnTo, opener);

  // The reader clicked into the composer, then the panel closed: keep the composer.
  const composer = {};
  assert.equal(focus.close(composer, scopeOf()), null);
  assert.ok(!log.includes("run line (no scroll)"));
});

test("close returns focus when nothing had it, and never to an opener that is gone", () => {
  const log: string[] = [];
  const body = {};
  const focus = createShellFocus();
  focus.open(target("run line", log), target("h2", log));
  assert.ok(focus.close(body, scopeOf(), body), "focus on <body> counts as nowhere");
  assert.ok(log.includes("run line (no scroll)"));

  const gone = createShellFocus();
  gone.open(target("removed row", log, false), target("h2", log));
  assert.equal(gone.close(null, scopeOf()), null);
  assert.ok(!log.includes("removed row (no scroll)"));

  const first = createShellFocus();
  const heading = target("h2", log);
  first.open(heading, heading);
  assert.equal(first.returnTo, null, "the heading is not its own way back");
});

// ── Exit ────────────────────────────────────────────────────────────────────

function fakeTimers() {
  let next = 1;
  const pending = new Map<number, { callback: () => void; ms: number }>();
  const ports: TimerPorts = {
    setTimeout: (callback, ms) => {
      const id = next++;
      pending.set(id, { callback, ms });
      return id;
    },
    clearTimeout: (handle) => {
      pending.delete(handle as number);
    },
  };
  const fire = () => {
    for (const [id, timer] of [...pending]) {
      pending.delete(id);
      timer.callback();
    }
  };
  return { ports, pending, fire };
}

test("the exit ends on the shell's own opacity transition, once", () => {
  let exited = 0;
  const timers = fakeTimers();
  const watcher = createExitWatcher(() => exited++, timers.ports);
  const shell = {};
  watcher.start(210);
  assert.equal(watcher.pending, true);
  assert.deepEqual([...timers.pending.values()].map((timer) => timer.ms), [210]);

  // A row's own fade bubbling up, and the shell's translate: not the exit.
  watcher.transitionEnd({ propertyName: "opacity", target: {}, currentTarget: shell });
  watcher.transitionEnd({ propertyName: "translate", target: shell, currentTarget: shell });
  assert.equal(exited, 0);

  watcher.transitionEnd({ propertyName: "opacity", target: shell, currentTarget: shell });
  assert.equal(exited, 1);
  assert.equal(timers.pending.size, 0, "the fallback is cleared");
  timers.fire();
  watcher.transitionEnd({ propertyName: "opacity", target: shell, currentTarget: shell });
  assert.equal(exited, 1, "exactly once");
});

test("with no transition (reduced motion, Safari before 17.4) the fallback timer ends the exit", () => {
  let exited = 0;
  const timers = fakeTimers();
  const watcher = createExitWatcher(() => exited++, timers.ports);
  watcher.start(exitFallbackMs("160ms"));
  assert.deepEqual([...timers.pending.values()].map((timer) => timer.ms), [160 + EXIT_FALLBACK_SLACK_MS]);
  timers.fire();
  assert.equal(exited, 1);
  assert.equal(watcher.pending, false);
});

test("reopening before the exit finishes cancels it", () => {
  let exited = 0;
  const timers = fakeTimers();
  const watcher = createExitWatcher(() => exited++, timers.ports);
  watcher.start(210);
  watcher.cancel();
  timers.fire();
  assert.equal(exited, 0);
  assert.equal(timers.pending.size, 0);
});

test("the fallback reads --dur-exit, and survives a value it cannot read", () => {
  assert.equal(parseCssDuration(" 160ms "), 160);
  assert.equal(parseCssDuration("0.2s"), 200);
  assert.equal(parseCssDuration("var(--x)"), null);
  assert.equal(parseCssDuration("-5ms"), null);
  assert.equal(exitFallbackMs("0.3s"), 300 + EXIT_FALLBACK_SLACK_MS);
  assert.equal(exitFallbackMs(""), 160 + EXIT_FALLBACK_SLACK_MS, "the generated --dur-exit token");
  assert.equal(exitFallbackMs(null), 160 + EXIT_FALLBACK_SLACK_MS);
});

// ── Rendering ───────────────────────────────────────────────────────────────

/*
 * `tsx` compiles JSX the classic way (the tsconfig says `preserve`, which is
 * Next's to handle), so a module that never imports React, as the icon set
 * need not, looks for it globally (the pattern of download-feed.test.ts).
 */
const scope = globalThis as { React?: typeof React };
scope.React ??= React;

const pane: SplitPane = {
  width: null,
  bounds: { minWidth: 400, maxWidth: 800 },
  resizing: false,
  reset: () => {},
  reclamp: () => {},
  separatorProps: {
    role: "separator",
    "aria-orientation": "vertical",
    "aria-valuenow": 480,
    "aria-valuemin": 400,
    "aria-valuemax": 800,
    onPointerDown: () => {},
    onPointerMove: () => {},
    onPointerUp: () => {},
    onPointerCancel: () => {},
    onLostPointerCapture: () => {},
    onDoubleClick: () => {},
    onKeyDown: () => {},
  },
};

function shell(props: Partial<RightColumnShellProps> = {}, children: React.ReactNode = "body") {
  return renderToStaticMarkup(
    React.createElement(
      RightColumnShell,
      { open: true, label: "Activity", header: null, onClose: () => {}, pane, mode: "column", ...props },
      children
    )
  );
}

test("the shell is a labelled aside whose h2 is the stable panel name", () => {
  const html = shell({ header: React.createElement("span", { id: "status" }, "Thought for 12s") });
  assert.match(html, /^<aside aria-label="Activity" data-open="" data-mode="column"/);
  assert.match(html, /<h2 tabindex="-1"[^>]*><span data-no-auto-translate="true">Activity<\/span><\/h2>/);
  assert.match(html, /<span id="status">Thought for 12s<\/span>/);
  assert.match(html, /class="[^"]*right-shell /);
  // In flow beside the split, the thought pane's width, no ad-hoc z-40.
  assert.match(html, /@\[50rem\]\/split:w-\[30rem\]/);
  assert.doesNotMatch(html, /\bz-40\b/);
  assert.match(html, /aria-label="Close panel"/);
  assert.match(html, /role="separator"[^>]*aria-label="Resize panel"/);
  assert.doesNotMatch(html, /Back to chat/);
});

test("below the split the shell is a sheet with a back button, on the panel rung", () => {
  const html = shell({ mode: "sheet" });
  assert.match(html, /data-mode="sheet"/);
  assert.match(html, /z-\[var\(--z-panel\)\]/);
  assert.match(html, /surface-float/);
  assert.match(html, /aria-label="Back to chat"/);
  assert.doesNotMatch(html, /aria-label="Close panel"/);
  assert.doesNotMatch(html, /role="separator"/, "nothing to resize in a sheet");
});

test("closed, the shell stays mounted, inert, for its exit", () => {
  const html = shell({ open: false });
  assert.match(html, /^<aside aria-label="Activity" data-mode="column" inert=""/);
  assert.doesNotMatch(html, /data-open/);
  assert.match(html, />body</);
});

test("tabs are Radix tabs with counts, never a row of plain buttons", () => {
  const html = shell({
    tabs: [
      { id: "timeline", label: "Timeline" },
      { id: "sources", label: "Sources", count: 5 },
    ],
    activeTab: "sources",
  });
  assert.match(html, /role="tablist"/);
  assert.equal(html.match(/role="tab"/g)?.length, 2);
  assert.match(html, /aria-selected="true"[^>]*>(?:(?!<\/button>).)*Sources(?:(?!<\/button>).)*>5<\/span>/);
  assert.match(html, /role="tabpanel"/);
});

test("header actions render inline and in the overflow for narrow panels", () => {
  const html = shell({ headerActions: React.createElement("button", { type: "button" }, "Pause") });
  assert.match(html, /@\[28rem\]\/shell:flex[^"]*"><button type="button">Pause<\/button>/);
  assert.match(html, /aria-label="More actions"/);
});

// ── The Activity panel, on a hand-built view ────────────────────────────────

const T0 = Date.UTC(2026, 8, 24, 10, 0, 0);
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();

function record(partial: Partial<ToolCallRecord> & Pick<ToolCallRecord, "callId" | "tool" | "status">): ToolCallRecord {
  return { v: 1, origin: partial.tool === "mcp" ? "connector" : "juno", title: "", round: 1, index: 0, startedAt: iso(1), ...partial };
}

const failedCall = record({
  callId: "c1",
  tool: "mcp",
  status: "failed",
  connectorLabel: "GitHub",
  toolTitle: "List pull requests",
  durationMs: 2_000,
  error: { code: "tool_error", detail: "HTTP 502 from api.github.com" },
});
const runningCall = record({ callId: "c2", tool: "web_fetch", status: "running", startedAt: iso(5), args: { url: "https://example.com/a" } });

const items: RunItem[] = [
  { kind: "reasoning", key: "r1", seq: 1, round: 1, text: "**Planning**\nFirst paragraph.\n\nSecond paragraph.", live: false },
  { kind: "tool", key: "t1", seq: 2, round: 1, call: failedCall, live: false },
  { kind: "notice", key: "n1", seq: 3, notice: { code: "connector_unavailable", params: { connector: "Linear", reason: "timeout" } }, legacyTitle: "Linear is unavailable" },
  { kind: "tool", key: "t2", seq: 4, round: 2, call: runningCall, live: true },
];

const handBuiltView: RunView = {
  typed: true,
  items,
  tools: items.filter((item): item is Extract<RunItem, { kind: "tool" }> => item.kind === "tool"),
  facts: { memory: [] },
  counts: { sources: 0, searches: 0, codeRuns: 0, filesCreated: 0, connectorsUsed: ["GitHub"], filesRead: [], failedTools: 1, warnings: 1 },
  hasReasoning: true,
  timing: { startedAt: T0, firstAnswerAt: null, endedAt: null, workedMs: null },
  pendingApprovalIds: [],
  latestStepKeys: ["t1", "t2"],
};

const line = (text: string): PhraseLine => [{ parts: [{ phrase: text }] }];
const presentation: ToolPresentation = {
  icon: "connector",
  running: (call) => line(`running ${call.callId}`),
  done: (call) => line(`done ${call.callId}`),
  failed: (call) => line(`failed ${call.callId}`),
  figure: () => null,
};

const claims: Array<[string, number]> = [];
const ports: Partial<PanelPorts> = {
  buildRunView: () => handBuiltView,
  presentTool: () => presentation,
  phaseOf: () => "reading",
  claimLoop: (id, priority) => {
    claims.push([id, priority]);
    return () => {};
  },
  useLoopOwner: (id) => id === "panel:t2",
  modelInfo: () => null,
  now: () => T0 + 6_000,
};

const liveMessage: PanelMessage = {
  id: "tmp-9",
  renderKey: "tmp-9",
  role: "ASSISTANT",
  content: "",
  createdAt: iso(0),
  attachments: [],
  activity: [],
  streaming: true,
};

function panel(message: PanelMessage, props: Partial<React.ComponentProps<typeof ActivityPanel>> = {}) {
  return renderToStaticMarkup(
    React.createElement(
      PanelPortsProvider,
      { ports },
      React.createElement(
        PanelMessagesProvider,
        { messages: [message] },
        React.createElement(ActivityPanel, {
          renderKey: message.renderKey ?? message.id,
          onClose: () => {},
          coversChat: () => false,
          seedDraft: () => {},
          ...props,
        })
      )
    )
  );
}

test("the Timeline renders the run's own order, failures in the warning ink", () => {
  const html = panel(liveMessage);
  const order = ["Planning", "failed c1", "⁨Linear⁩|Linear", "running c2"].map((needle) =>
    html.search(new RegExp(needle))
  );
  assert.ok(order.every((at) => at >= 0), `every item renders: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "chronological");
  assert.match(html, /<h3 translate="no" lang="" dir="auto"[^>]*>Planning<\/h3>/, "a provider headline is an h3");
  assert.match(html, /<p [^>]*>First paragraph\.<\/p>/);
  assert.match(html, /text-warning-foreground[^"]*"><span data-no-auto-translate="true">failed c1/);
  assert.doesNotMatch(html, /text-destructive/, "one failure ink");
  assert.doesNotMatch(html, /Linear is unavailable/, "a typed notice never shows its legacy title");
});

test("the running call's marker owns the loop; rows are closed disclosures", () => {
  const html = panel(liveMessage);
  assert.match(html, /class="run-marker[^"]*" data-state="running" data-run-loop-owner=""/);
  assert.equal(html.match(/data-run-loop-owner/g)?.length, 1, "exactly one loop owner");
  assert.equal(html.match(/aria-expanded="false"/g)?.length, 2);
  assert.doesNotMatch(html, /What went wrong/, "collapsed detail is not in the DOM");
  assert.match(html, /data-call-id="c1"/);
});

test("a focused call opens expanded, with its error detail verbatim and Ask to run again", () => {
  const html = panel(liveMessage, { focusCallId: "c1" });
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /What went wrong/);
  assert.match(html, /<p translate="no" lang="" dir="auto" data-no-auto-translate="true" [^>]*>HTTP 502 from api\.github\.com<\/p>/);
  assert.match(html, /Ask to run again/);
});

test("an empty live run says steps are coming; no message renders nothing", () => {
  const empty: RunView = { ...handBuiltView, items: [], tools: [] };
  const html = renderToStaticMarkup(
    React.createElement(
      PanelPortsProvider,
      { ports: { ...ports, buildRunView: () => empty } },
      React.createElement(
        PanelMessagesProvider,
        { messages: [liveMessage] },
        React.createElement(ActivityPanel, { renderKey: "tmp-9", onClose: () => {}, coversChat: () => false })
      )
    )
  );
  assert.match(html, /No steps yet/);
  assert.match(html, /Steps appear here as Juno works\./);
  assert.equal(panel(liveMessage, { renderKey: "someone-else" }), "");
});

test("a waiting row carries its own decision control, named after the call", () => {
  const waiting = record({
    callId: "c3",
    tool: "mcp",
    status: "awaiting_approval",
    connectorLabel: "GitHub",
    toolTitle: "Create issue",
    approval: { id: "ap1", status: "pending", riskClass: "external_write" },
  });
  const waitingView: RunView = {
    ...handBuiltView,
    items: [{ kind: "tool", key: "t3", seq: 1, round: 1, call: waiting, live: false }],
    tools: [{ kind: "tool", key: "t3", seq: 1, round: 1, call: waiting, live: false }],
  };
  const approvalFrame = {
    id: "ap1",
    surface: "chat",
    sessionId: "s",
    conversationId: null,
    connectorId: "github",
    connectorLabel: "GitHub",
    toolName: "create_issue",
    action: "Create issue",
    riskClass: "external_write" as const,
    preview: "Create issue",
    detail: {},
    receiptDigest: "digest",
    status: "pending" as const,
    decision: null,
    canAllowScope: false,
    derivedFromUntrusted: false,
    expiresAt: iso(900),
    decidedAt: null,
    completedAt: null,
    createdAt: iso(1),
  };
  const render = (canAllowScope: boolean) =>
    renderToStaticMarkup(
      React.createElement(
        PanelPortsProvider,
        { ports: { ...ports, buildRunView: () => waitingView, phaseOf: () => "waiting" } },
        React.createElement(
          PanelMessagesProvider,
          { messages: [{ ...liveMessage, approvals: [{ ...approvalFrame, canAllowScope }] }] },
          React.createElement(ActivityPanel, { renderKey: "tmp-9", onClose: () => {}, coversChat: () => true })
        )
      )
    );
  const html = render(false);
  assert.match(html, /role="group" aria-label="Approve this call\. running c3" data-no-auto-translate="true"/);
  assert.match(html, /Allow once/);
  assert.match(html, /Decline/);
  assert.doesNotMatch(html, /Always allow/, "offered only where the card would offer it");
  assert.match(render(true), /Always allow/);
  assert.match(html, /class="run-marker[^"]*" data-state="waiting"/, "the accent ring, not the loop");
  assert.doesNotMatch(html, /data-run-loop-owner/);
});

test("an opened page read says when it carried instructions aimed at the assistant", () => {
  const fetched = record({
    callId: "f9",
    tool: "web_fetch",
    status: "succeeded",
    args: { url: "https://lab.example.org/a" },
    web: { requestedUrl: "https://lab.example.org/a", finalUrl: "https://lab.example.org/a", chars: 5_120, totalChars: 9_000, injection: "suspicious" },
  });
  const fetchView: RunView = {
    ...handBuiltView,
    items: [{ kind: "tool", key: "t9", seq: 1, round: 1, call: fetched, live: false }],
    tools: [{ kind: "tool", key: "t9", seq: 1, round: 1, call: fetched, live: false }],
  };
  const html = renderToStaticMarkup(
    React.createElement(
      PanelPortsProvider,
      { ports: { ...ports, buildRunView: () => fetchView, phaseOf: () => "done" } },
      React.createElement(
        PanelMessagesProvider,
        { messages: [{ ...liveMessage, streaming: false }] },
        React.createElement(ActivityPanel, { renderKey: "tmp-9", focusCallId: "f9", onClose: () => {}, coversChat: () => false })
      )
    )
  );
  assert.match(html, /Contained instructions aimed at the assistant; they were ignored/);
  assert.match(html, /href="https:\/\/lab\.example\.org\/a" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Shown<\/span> <span data-no-auto-translate="true">5,120<\/span>/);
  assert.match(html, /Full length<\/span> <span data-no-auto-translate="true">9,000<\/span>/);
});

test("Sources: cited rows with their numbers, then the pages read, opening in a new tab", () => {
  const split = splitSources({
    sources: [
      { title: "Module record", url: "https://www.example-solar.com/news", snippet: "", cited: true, origin: "juno_search" },
      { title: "Grounded page", url: "https://grounded.example/p", snippet: "", cited: true, origin: "provider_grounding" },
    ],
    content: "Record [1].",
    activity: [],
  });
  const html = renderToStaticMarkup(React.createElement(ActivitySourcesTab, { split }));
  assert.ok(html.indexOf("Cited") < html.indexOf("Also read"));
  assert.match(html, /href="https:\/\/www\.example-solar\.com\/news" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /<bdi [^>]*translate="no" lang="" data-no-auto-translate="true">example-solar\.com<\/bdi>/);
  assert.match(html, /Cited as<\/span><\/span><span [^>]*>1<\/span>/);
  assert.doesNotMatch(html, /Found/);
  const empty = renderToStaticMarkup(React.createElement(ActivitySourcesTab, { split: { cited: [], alsoRead: [], found: [] } }));
  assert.match(empty, /No sources/);
});

test("Details: model, effort, context against the window, connectors and memory with Forget", () => {
  const html = renderToStaticMarkup(
    React.createElement(ActivityDetailsTab, {
      details: {
        model: { label: "Claude Fable 5.1", provider: "anthropic", routed: false },
        effort: { rung: "xhigh", auto: true },
        context: { kind: "tokens", used: 18_000, window: 1_000_000 },
        tools: { offered: ["web_search", "run_code"], nativeSearch: false, roundBudget: 12 },
        connectors: {
          key: "connectors",
          ready: [{ id: "gh", label: "GitHub", tools: 9 }],
          failed: [{ id: "ln", label: "Linear", reason: "auth_expired" }],
        },
        memory: [{ id: "m1", content: "Prefers metric units.", sourceRef: "conv-1" }],
      },
    })
  );
  assert.match(html, /Claude Fable 5\.1/);
  assert.match(html, /Anthropic · Claude/);
  assert.match(html, /Extra high/);
  assert.match(html, /Chosen automatically/);
  assert.match(html, /Context used<\/span> <span data-no-auto-translate="true">18,000<\/span> <span data-no-auto-translate="true">tokens/);
  assert.match(html, /Tools available<\/span> <span data-no-auto-translate="true">2<\/span>/);
  assert.match(html, /Up to<\/span> <span data-no-auto-translate="true">12<\/span> <span data-no-auto-translate="true">steps/);
  assert.match(html, /text-warning-foreground[^>]*>(?:(?!<\/li>).)*Couldn’t connect(?:(?!<\/li>).)*Sign in again in Settings/);
  assert.match(html, /Prefers metric units\./);
  assert.match(html, /href="\/chat\/conv-1"/);
  assert.match(html, />Forget</);
  assert.doesNotMatch(html, /€|\$\d/, "no money in the Activity panel");
});
