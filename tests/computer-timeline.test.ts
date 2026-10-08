import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ComputerTimeline } from "@/components/code/computer-timeline";
import type { ComputerActionItem, TurnItem } from "@/lib/code-v2/contracts";
import {
  actionCaption,
  buildComputerTimeline,
  defaultScreenshotResolver,
  followsLive,
  indexFromRatio,
  ratioFromIndex,
  ringPosition,
  stageFrameIndex,
  stepSelection,
  timelineSummary,
} from "@/lib/code-v2/computer-timeline";

(globalThis as { React?: typeof React }).React = React;

const at = (s: number) => `2026-10-08T20:00:${String(s).padStart(2, "0")}Z`;
function step(id: string, over: Partial<ComputerActionItem> = {}): ComputerActionItem {
  return {
    id,
    kind: "computer_action",
    createdAt: at(Number(id.replace(/\D/g, "")) || 0),
    callId: `call_${id}`,
    action: "click",
    status: "completed",
    ...over,
  };
}

test("only computer_action items become frames, in thread order, updates keep their slot", () => {
  const items: TurnItem[] = [
    { id: "u1", kind: "user_message", createdAt: at(0), text: "Export the deck" },
    step("a1", { action: "screenshot", app: "Pages", screenshotRef: "data:image/png;base64,AAA" }),
    step("a2", { status: "running", target: "“Export…” button", app: "Pages" }),
    { id: "m1", kind: "assistant_message", createdAt: at(3), text: "Clicking export", streaming: true },
    step("a3", { action: "key", target: "⌘S", app: "Pages", screenshotRef: "https://x.test/3.png" }),
    // item.updated for a2: completed with its own screenshot and ring.
    step("a2", {
      status: "completed",
      target: "“Export…” button",
      app: "Pages",
      summary: "Clicked the “Export…” button in Pages.",
      screenshotRef: "alevr-shot://s 1/a2.jpg",
      point: { x: 0.5, y: 1.4 },
    }),
  ];
  const frames = buildComputerTimeline(items);
  assert.deepEqual(
    frames.map((f) => f.id),
    ["a1", "a2", "a3"],
  );
  assert.deepEqual(
    frames.map((f) => f.index),
    [0, 1, 2],
  );
  const a2 = frames[1];
  assert.equal(a2.caption, "Clicked the “Export…” button in Pages.");
  assert.equal(a2.live, false);
  assert.deepEqual(a2.point, { x: 0.5, y: 1 }, "points are clamped into the frame");
  assert.equal(a2.src, "/api/code/screenshots/s%201/a2.jpg");
  assert.equal(frames[0].src, "data:image/png;base64,AAA");
  assert.equal(frames[2].verb, "Keys");
});

test("captions follow the status: progressive while running, past when done, reason on failure", () => {
  assert.equal(actionCaption(step("1", { status: "running", target: "the Name field", app: "TextEdit", action: "type" })), "Typing in the Name field in TextEdit…");
  assert.equal(actionCaption(step("1", { action: "open_app", app: "Safari" })), "Opened Safari.");
  assert.equal(actionCaption(step("1", { action: "scroll" })), "Scrolled the screen.");
  assert.equal(actionCaption(step("1", { action: "wait" })), "Waited.");
  assert.equal(actionCaption(step("1", { status: "declined", error: "You said no." })), "Not allowed: You said no.");
  assert.equal(actionCaption(step("1", { status: "interrupted", app: "Notes" })), "Stopped — clicked Notes");
  assert.equal(
    actionCaption(step("1", { status: "running", summary: "Old summary", action: "ax_press", target: "“Send”" })),
    "Pressing “Send”…",
    "a running step ignores a stale summary",
  );
  // A target that already names the app is not repeated.
  assert.equal(actionCaption(step("1", { target: "Safari — Address bar", app: "Safari" })), "Clicked Safari — Address bar.");
});

test("the stage borrows the latest earlier screenshot for a step without one", () => {
  const frames = buildComputerTimeline([
    step("1", { screenshotRef: "/a.png" }),
    step("2", { action: "key" }),
    step("3", { screenshotRef: "/c.png" }),
  ]);
  assert.equal(stageFrameIndex(frames, 1), 0);
  assert.equal(stageFrameIndex(frames, 2), 2);
  assert.equal(stageFrameIndex(buildComputerTimeline([step("1")]), 0), -1);
  assert.equal(stageFrameIndex(frames, 99), 2);
});

test("scrubber maths round-trips and clamps", () => {
  assert.equal(indexFromRatio(0, 5), 0);
  assert.equal(indexFromRatio(1, 5), 4);
  assert.equal(indexFromRatio(0.49, 5), 2);
  assert.equal(indexFromRatio(-3, 5), 0);
  assert.equal(indexFromRatio(Number.NaN, 5), 4);
  assert.equal(indexFromRatio(0.5, 0), -1);
  for (let i = 0; i < 7; i++) assert.equal(indexFromRatio(ratioFromIndex(i, 7), 7), i);
  assert.equal(ratioFromIndex(0, 1), 1);
});

test("live following and keyboard stepping", () => {
  assert.equal(followsLive(null, 3), true);
  assert.equal(followsLive(2, 3), true);
  assert.equal(followsLive(1, 3), false);
  assert.equal(stepSelection(null, 3, -1), 1);
  assert.equal(stepSelection(0, 3, -1), 0);
  assert.equal(stepSelection(2, 3, 1), 2);
  assert.equal(stepSelection(null, 0, 1), -1);
});

test("summary names the apps without listing them all", () => {
  assert.equal(timelineSummary([]), "No steps yet");
  const one = buildComputerTimeline([step("1", { app: "Pages" })]);
  assert.equal(timelineSummary(one), "1 step in Pages");
  const many = buildComputerTimeline([
    step("1", { app: "Pages" }),
    step("2", { app: "Safari" }),
    step("3", { app: "Pages" }),
    step("4", { app: "Mail" }),
    step("5", { app: "Notes" }),
  ]);
  assert.equal(timelineSummary(many), "5 steps in Pages, Safari and 2 more");
  assert.equal(timelineSummary(buildComputerTimeline([step("1"), step("2")])), "2 steps");
});

test("ring position is a percentage of the stage, or nothing", () => {
  const [f] = buildComputerTimeline([step("1", { point: { x: 0.25, y: 0.755 } })]);
  assert.deepEqual(ringPosition(f), { left: "25.00%", top: "75.50%" });
  assert.equal(ringPosition(buildComputerTimeline([step("1")])[0]), null);
  assert.equal(ringPosition(undefined), null);
});

test("the resolver only passes URLs the web can load", () => {
  assert.equal(defaultScreenshotResolver("shot_0003"), null);
  assert.equal(defaultScreenshotResolver("file:///Users/x/a.png"), null);
  assert.equal(defaultScreenshotResolver("javascript:alert(1)"), null);
  assert.equal(defaultScreenshotResolver("/api/x.png"), "/api/x.png");
});

test("the component renders the newest step, its ring and the strip, with no status pills", () => {
  const items = [
    step("1", { action: "screenshot", app: "Pages", screenshotRef: "/1.png", frameSize: { width: 1456, height: 816 } }),
    step("2", {
      status: "running",
      app: "Pages",
      target: "“Export…”",
      screenshotRef: "/2.png",
      point: { x: 0.4, y: 0.3 },
      frameSize: { width: 1456, height: 816 },
    }),
  ];
  const html = renderToStaticMarkup(React.createElement(ComputerTimeline, { items }));
  assert.match(html, /2 steps in Pages/);
  assert.match(html, /Clicking “Export…” in Pages…/);
  assert.match(html, /aspect-ratio:1456 \/ 816/);
  assert.match(html, /left:40\.00%;top:30\.00%/);
  assert.match(html, /agent-coral/, "a running step's ring is the working accent");
  assert.match(html, /aria-selected="true"[^>]*data-index="1"/);
  assert.doesNotMatch(html, /rounded-full[^"]*bg-/, "no filled dots");
  assert.equal(renderToStaticMarkup(React.createElement(ComputerTimeline, { items: [] })), "");
  const folded = renderToStaticMarkup(React.createElement(ComputerTimeline, { items, defaultCollapsed: true }));
  assert.doesNotMatch(folded, /<img/);
  assert.match(folded, /aria-expanded="false"/);
});
