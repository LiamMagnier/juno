import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ActivityBody, ActivityRow, ActivitySkeleton } from "@/components/activity/activity-view";
import { ActivityNeedsYouBadge, ActivityStatusMark } from "@/components/activity/activity-status-mark";
import { ACTIVITY_REFRESH_EVENTS, pollIntervalFor } from "@/components/activity/use-activity";
import { ACTIVITY_COPY } from "@/components/activity/activity-copy";
import { WORK_LIVE_POLL_MS, WORK_POLL_MS } from "@/components/work/work-transport";
import { groupActivity, type ActivityItem } from "@/lib/activity/model";

(globalThis as { React?: typeof React }).React = React;

/*
 * The Activity page's components (G70), rendered to markup: the four groups in
 * reading order with glyph AND word, rows that link to the owning surface,
 * Stop only where it can work, the empty state, the keyboard contract, and the
 * cadence that keeps an idle page from polling.
 */

const NOW = Date.parse("2026-10-18T12:00:00.000Z");

function item(partial: Partial<ActivityItem> & Pick<ActivityItem, "id" | "state">): ActivityItem {
  const [kind, sourceId] = partial.id.split(":") as [ActivityItem["kind"], string];
  return {
    kind,
    sourceId,
    title: `Item ${sourceId}`,
    need: null,
    status: "running",
    needSummary: null,
    startedAt: new Date(NOW - 4 * 60_000).toISOString(),
    updatedAt: new Date(NOW - 60_000).toISOString(),
    href: `/work/${sourceId}`,
    conversationId: null,
    runId: null,
    canStop: false,
    ...partial,
  };
}

const ITEMS: ActivityItem[] = [
  item({ id: "work:a", state: "needs_you", need: "approval", needSummary: "Send the invoice to Sam?", status: "waiting_approval" }),
  item({ id: "code:b", state: "running", canStop: true, href: "/code/conv-b", status: "running" }),
  item({ id: "research:c", state: "ready", need: "review", href: "/research/c", status: "completed" }),
  item({ id: "work:d", state: "blocked", status: "failed" }),
];

function body(items: ActivityItem[], extra: Partial<React.ComponentProps<typeof ActivityBody>> = {}) {
  return renderToStaticMarkup(
    React.createElement(ActivityBody, {
      items,
      counts: { needs_you: 1, running: 1, ready: 1, blocked: 1 },
      filter: "all",
      onFilter: () => {},
      now: NOW,
      hasMore: false,
      loadingMore: false,
      onLoadMore: () => {},
      onChanged: () => {},
      ...extra,
    })
  );
}

test("groups render in reading order, each with its word", () => {
  const html = body(ITEMS);
  const order = ["needs_you", "running", "ready", "blocked"].map((state) => html.indexOf(`id="activity-group-${state}"`));
  assert.ok(order.every((at) => at >= 0), "every group rendered");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "Needs you, Running, Ready, Blocked");
  for (const word of Object.values(ACTIVITY_COPY.states)) assert.ok(html.includes(word), word);
  assert.ok(html.includes("aria-labelledby=\"activity-group-needs_you\""));
});

test("rows link to the owning surface and say what they need", () => {
  const html = body(ITEMS);
  assert.ok(html.includes('href="/work/a"'));
  assert.ok(html.includes('href="/code/conv-b"'));
  assert.ok(html.includes('href="/research/c"'));
  assert.ok(html.includes(ACTIVITY_COPY.needs.approval));
  assert.ok(html.includes("Send the invoice to Sam?"));
  // The needs-you row's verb is the approval's, not a generic Open.
  assert.ok(html.includes(`>${ACTIVITY_COPY.verbs.approval}<`));
  // Every row is reachable by the roving list.
  assert.equal(html.match(/data-activity-row=""/g)?.length, ITEMS.length);
});

test("Stop is offered only where an endpoint can stop it", () => {
  const running = renderToStaticMarkup(React.createElement(ActivityRow, { item: ITEMS[1], now: NOW, onChanged: () => {} }));
  assert.match(running, /aria-label="Stop: Item b"/);
  const ready = renderToStaticMarkup(React.createElement(ActivityRow, { item: ITEMS[2], now: NOW, onChanged: () => {} }));
  assert.doesNotMatch(ready, /Stop/);
});

test("a filter narrows to one group and says so when it is empty", () => {
  const html = body(ITEMS, { filter: "ready" });
  assert.ok(html.includes('id="activity-group-ready"'));
  assert.ok(!html.includes('id="activity-group-running"'));
  const empty = body([ITEMS[0]], { filter: "blocked" });
  assert.ok(empty.includes(ACTIVITY_COPY.filteredEmpty));
});

test("nothing live is the empty state with a way on, and more pages offer Show more", () => {
  const empty = body([], { counts: { needs_you: 0, running: 0, ready: 0, blocked: 0 } });
  assert.ok(empty.includes(ACTIVITY_COPY.emptyTitle));
  assert.ok(empty.includes('href="/chat"'));
  assert.ok(body(ITEMS, { hasMore: true }).includes(ACTIVITY_COPY.showMore));
});

test("loading is announced", () => {
  const html = renderToStaticMarkup(React.createElement(ActivitySkeleton));
  assert.match(html, /role="status"/);
  assert.ok(html.includes(ACTIVITY_COPY.loading));
});

test("status marks use the role tokens and the badge hides from assistive tech", () => {
  assert.match(renderToStaticMarkup(React.createElement(ActivityStatusMark, { state: "needs_you" })), /text-status-needs-you-ink/);
  assert.match(renderToStaticMarkup(React.createElement(ActivityStatusMark, { state: "blocked" })), /text-status-blocked/);
  assert.match(renderToStaticMarkup(React.createElement(ActivityStatusMark, { state: "ready" })), /text-status-ready/);
  const badge = renderToStaticMarkup(React.createElement(ActivityNeedsYouBadge, { count: 3 }));
  assert.match(badge, /aria-hidden="true"/);
  assert.match(badge, />3</);
  assert.equal(renderToStaticMarkup(React.createElement(ActivityNeedsYouBadge, { count: 0 })), "");
});

test("an idle page does not poll; a live one polls fast, a waiting one slowly", () => {
  assert.equal(pollIntervalFor(null), null);
  assert.equal(pollIntervalFor({ needs_you: 0, running: 0, ready: 4, blocked: 2 }), null);
  assert.equal(pollIntervalFor({ needs_you: 2, running: 0, ready: 0, blocked: 0 }), WORK_POLL_MS);
  assert.equal(pollIntervalFor({ needs_you: 2, running: 1, ready: 0, blocked: 0 }), WORK_LIVE_POLL_MS);
});

test("the refresh events are the ones other surfaces dispatch", () => {
  const sources = [
    "../src/hooks/use-code-session.ts",
    "../src/components/research/research-discovery.ts",
    "../src/components/app/app-provider.tsx",
  ].map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));
  for (const name of ACTIVITY_REFRESH_EVENTS.slice(1)) {
    assert.ok(sources.some((source) => source.includes(`"${name}"`)), `${name} is dispatched somewhere`);
  }
});

test("grouping keeps page order inside a group", () => {
  const groups = groupActivity([ITEMS[1], item({ id: "work:e", state: "running" }), ITEMS[0]]);
  assert.deepEqual(groups.map((g) => g.state), ["needs_you", "running"]);
  assert.deepEqual(groups[1].items.map((i) => i.id), ["code:b", "work:e"]);
});

test("the sidebar row and the shell contract carry Activity", () => {
  const sidebar = readFileSync(new URL("../src/components/app/app-sidebar.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /href: "\/activity", kind: "activity"/);
  assert.match(sidebar, /useActivityCounts\(!isCode\)/);
  const contract = JSON.parse(readFileSync(new URL("../contracts/product/juno-shell-v1.json", import.meta.url), "utf8"));
  assert.equal(contract.sidebar.chat.destinations[0], "activity");
});
