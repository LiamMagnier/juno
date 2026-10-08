import { test } from "node:test";
import assert from "node:assert/strict";
import type { TurnItem } from "@/lib/code-v2/contracts";
import { describeItem, formatDuration, groupTurns, nextDetailLevel, stepItems, turnHeader, turnMarks, turnVisibility } from "@/lib/code-v2/turns";
import { clampDockWidth, dockReducer, initialDockState, nudgeDockWidth, snapDockWidth } from "@/lib/code-v2/dock";
import { applyTrigger, composerKeyIntent, detectTrigger, escPress, queueReducer, rankFiles, sendButtonMode, visibleQueue } from "@/lib/code-v2/composer";
import { evaluateWhen, findConflicts, formatKey, resolveKeybinding, DEFAULT_KEYBINDINGS } from "@/lib/code-v2/keymap";
import { hunkOrder, keptCounts, moveHunkFocus, parseUnifiedDiff, rejectedPatch, splitRows, changedRange } from "@/lib/code-v2/diff";
import { planFlip, threadSections } from "@/lib/code-v2/thread-sections";

const t = (s: number) => new Date(Date.UTC(2026, 9, 8, 10, 0, s)).toISOString();

const items: TurnItem[] = [
  { id: "u1", kind: "user_message", text: "Move the total", createdAt: t(0) },
  { id: "r1", kind: "reasoning", text: "Plan", streaming: false, createdAt: t(2) },
  { id: "c1", kind: "command_execution", callId: "c1", command: "pnpm test", status: "completed", exitCode: 0, durationMs: 18000, output: "a\nb\nc\nd", createdAt: t(4) },
  { id: "f1", kind: "file_change", callId: "f1", status: "completed", changes: [{ path: "src/a.ts", change: "modify", additions: 3, deletions: 1 }], createdAt: t(5) },
  { id: "f2", kind: "file_change", callId: "f2", status: "completed", changes: [{ path: "src/a.ts", change: "modify", additions: 2, deletions: 0 }], createdAt: t(6) },
  { id: "a1", kind: "assistant_message", text: "Done.", streaming: false, createdAt: t(250) },
  { id: "u2", kind: "user_message", text: "Run the suite", createdAt: t(300) },
  { id: "s1", kind: "user_message", text: "and the e2e too", delivery: "steer", createdAt: t(301) },
  { id: "c2", kind: "command_execution", callId: "c2", command: "pnpm test --filter cart", status: "running", createdAt: t(302) },
];

test("groupTurns splits on sent messages, keeps steers inside, aggregates changes", () => {
  const turns = groupTurns(items, { state: "running" });
  assert.equal(turns.length, 2);
  const [a, b] = turns;
  assert.equal(a.status, "done");
  assert.equal(a.answer?.id, "a1");
  assert.equal(a.durationMs, 250_000);
  assert.equal(turnHeader(a), "Worked for 4m 10s");
  assert.deepEqual(a.changes, [{ path: "src/a.ts", change: "modify", additions: 5, deletions: 1, diff: undefined }]);
  assert.ok(a.canFold);
  assert.equal(b.status, "running");
  assert.ok(!b.canFold);
  assert.ok(b.items.some((i) => i.id === "s1"));
  assert.deepEqual(stepItems(a).map((i) => i.id), ["r1", "c1", "f1", "f2"]);
  assert.deepEqual(turnMarks(turns).map((m) => m.label), ["Move the total", "Run the suite"]);
});

test("a pending approval keeps a turn unfolded and waiting", () => {
  const turns = groupTurns([
    ...items.slice(0, 6),
    { id: "p", kind: "approval_request", callId: "x", requestId: "r", action: "command", summary: "run", status: "pending", createdAt: t(260) },
  ]);
  assert.equal(turns[0].status, "waiting");
  assert.equal(turns[0].canFold, false);
});

test("detail levels decide what a settled turn shows", () => {
  const [turn] = groupTurns(items.slice(0, 6));
  assert.deepEqual(turnVisibility(turn, "quiet", undefined), { header: false, steps: false, detail: false });
  assert.deepEqual(turnVisibility(turn, "summary", undefined), { header: true, steps: false, detail: false });
  assert.deepEqual(turnVisibility(turn, "steps", undefined), { header: true, steps: true, detail: false });
  assert.deepEqual(turnVisibility(turn, "full", undefined), { header: true, steps: true, detail: true });
  assert.deepEqual(turnVisibility(turn, "quiet", true), { header: true, steps: true, detail: false });
  assert.equal(nextDetailLevel("full"), "quiet");
});

test("step rows describe items in words", () => {
  const ran = describeItem(items[2])!;
  assert.equal(ran.verb, "Ran");
  assert.equal(ran.meta, "18s");
  assert.deepEqual(ran.tail, ["b", "c", "d"]);
  const running = describeItem(items[8], Date.parse(t(343)))!;
  assert.equal(running.verb, "Running");
  assert.equal(running.meta, "0:41");
  assert.equal(running.tone, "running");
  const failed = describeItem({ id: "x", kind: "command_execution", callId: "x", command: "tsc", status: "failed", exitCode: 2, createdAt: t(0) })!;
  assert.equal(failed.verb, "Failed (exit 2)");
  assert.equal(describeItem(items[0]), null);
  assert.equal(formatDuration(3_780_000), "1h 3m");
});

test("dock toggles, snaps on release and remembers the tab per thread", () => {
  let s = initialDockState();
  s = dockReducer(s, { type: "toggle", tab: "changes", threadId: "a" });
  assert.equal(s.open, true);
  s = dockReducer(s, { type: "toggle", tab: "changes" });
  assert.equal(s.open, false);
  s = dockReducer(s, { type: "open", tab: "terminal", threadId: "b" });
  s = dockReducer(s, { type: "thread-changed", threadId: "a" });
  assert.equal(s.tab, "changes");
  s = dockReducer(s, { type: "drag", width: 900 });
  assert.equal(s.dragWidth, 760);
  s = dockReducer(s, { type: "release", width: 470 });
  assert.equal(s.width, 460);
  assert.equal(s.dragWidth, null);
  assert.equal(snapDockWidth(600), 600);
  assert.equal(snapDockWidth(370), 360);
  assert.equal(clampDockWidth(100), 360);
  assert.equal(nudgeDockWidth(460, 1, true), 524);
  s = dockReducer(s, { type: "toggle-expand" });
  assert.equal(s.expanded, true);
});

test("composer keys: Enter sends, queues while running, ⌘↵ steers, ⇧↵ is a newline", () => {
  const idle = { running: false, hasDraft: true, canSteer: true, canQueue: true };
  const run = { ...idle, running: true };
  assert.equal(composerKeyIntent({ key: "Enter" }, idle), "send");
  assert.equal(composerKeyIntent({ key: "Enter", shift: true }, idle), "newline");
  assert.equal(composerKeyIntent({ key: "Enter" }, run), "queue");
  assert.equal(composerKeyIntent({ key: "Enter", meta: true }, run), "steer");
  assert.equal(composerKeyIntent({ key: "Enter", ctrl: true }, run, false), "steer");
  assert.equal(composerKeyIntent({ key: "Enter" }, { ...run, composing: true }), null);
  assert.equal(composerKeyIntent({ key: "Enter" }, { ...run, canQueue: false }), "steer");
  assert.equal(composerKeyIntent({ key: "ArrowUp", alt: true }, { ...run, hasDraft: false }), "edit-last-queued");
  assert.equal(sendButtonMode({ ...run, hasDraft: false }), "stop");
  assert.equal(sendButtonMode(run), "queue");
  assert.equal(sendButtonMode({ ...idle, hasDraft: false }), "disabled");
});

test("Esc Esc within 600 ms stops", () => {
  let s = escPress(null, 1000, true);
  assert.deepEqual(s, { stop: false, armedAt: 1000 });
  s = escPress(s.armedAt, 1500, true);
  assert.equal(s.stop, true);
  assert.equal(escPress(1000, 1700, true).stop, false);
  assert.equal(escPress(1000, 1100, false).stop, false);
});

test("slash and mention triggers", () => {
  assert.deepEqual(detectTrigger("/com", 4), { kind: "slash", query: "com", start: 0 });
  assert.deepEqual(detectTrigger("fix it\n/pl", 10), { kind: "slash", query: "pl", start: 7 });
  assert.equal(detectTrigger("a/b", 3), null);
  assert.deepEqual(detectTrigger("look at @src/cart/to", 20), { kind: "mention", query: "src/cart/to", start: 8 });
  assert.deepEqual(detectTrigger("email me@x", 10), null);
  const trig = detectTrigger("see @tot", 8)!;
  assert.deepEqual(applyTrigger("see @tot", 8, trig, "@src/total.ts "), { text: "see @src/total.ts ", caret: 18 });
  assert.deepEqual(rankFiles(["src/a/total.ts", "src/total.ts", "lib/subtotal.ts", "x.md"], "tot"), ["src/total.ts", "src/a/total.ts", "lib/subtotal.ts"]);
});

test("queue edits, reorders, and shows three rows then +n more", () => {
  let q = queueReducer([], { type: "add", row: { id: "1", text: "a" } });
  q = queueReducer(q, { type: "add", row: { id: "2", text: "b" } });
  q = queueReducer(q, { type: "add", row: { id: "3", text: " " } });
  assert.equal(q.length, 2);
  q = queueReducer(q, { type: "move", id: "2", to: 0 });
  assert.deepEqual(q.map((r) => r.id), ["2", "1"]);
  q = queueReducer(q, { type: "edit", id: "1", text: "" });
  assert.deepEqual(q.map((r) => r.id), ["2"]);
  const many = [1, 2, 3, 4, 5].map((n) => ({ id: String(n), text: String(n) }));
  assert.equal(visibleQueue(many).more, 2);
});

test("keymap resolves with when clauses and formats keycaps", () => {
  assert.equal(evaluateWhen("a && !b || c", { a: true, b: true, c: true }), true);
  assert.equal(evaluateWhen("a && !b", { a: true, b: true }), false);
  assert.equal(resolveKeybinding({ key: "k", metaKey: true }, {}), "palette.toggle");
  assert.equal(resolveKeybinding({ key: "k", metaKey: true }, { terminalFocus: true }), null);
  assert.equal(resolveKeybinding({ key: "M", metaKey: true, shiftKey: true }, {}), "picker.model");
  assert.equal(resolveKeybinding({ key: "}", metaKey: true, shiftKey: true }, {}), "thread.next");
  assert.equal(resolveKeybinding({ key: "]" }, { changesFocus: true }), "hunk.next");
  assert.equal(resolveKeybinding({ key: "a" }, { changesFocus: true, editableFocus: true }), null);
  assert.equal(resolveKeybinding({ key: "k", ctrlKey: true }, {}, DEFAULT_KEYBINDINGS, false), "palette.toggle");
  assert.equal(formatKey("mod+shift+m"), "⌘⇧M");
  assert.equal(formatKey("mod+shift+m", false), "Ctrl+Shift+M");
  assert.deepEqual(findConflicts(DEFAULT_KEYBINDINGS), []);
  const custom = [...DEFAULT_KEYBINDINGS, { key: "mod+k", command: "thread.find" }];
  assert.equal(resolveKeybinding({ key: "k", metaKey: true }, {}, custom), "thread.find");
});

const DIFF = `diff --git a/src/total.ts b/src/total.ts
--- a/src/total.ts
+++ b/src/total.ts
@@ -1,4 +1,5 @@ export
 import { applyCoupon } from "./pricing";
+import { taxFor } from "./tax";

-export function total(items, coupon) {
+export function total(items: Item[], coupon?: Coupon) {
   return 1;
@@ -20,2 +21,2 @@
-const a = 1;
+const a = 2;
 const b = 3;
`;

test("parseUnifiedDiff numbers lines, marks words and counts", () => {
  const [f] = parseUnifiedDiff(DIFF);
  assert.equal(f.path, "src/total.ts");
  assert.equal(f.hunks.length, 2);
  assert.equal(f.additions, 3);
  assert.equal(f.deletions, 2);
  const h = f.hunks[0];
  assert.equal(h.section, "export");
  assert.equal(h.lines[0].oldNo, 1);
  assert.equal(h.lines[1].kind, "add");
  assert.equal(h.lines[1].newNo, 2);
  const del = h.lines.find((l) => l.kind === "del")!;
  assert.ok(del.marks && del.marks[0][0] > 0, "word-level mark after the common prefix");
  assert.equal(changedRange("same", "same"), null);
  assert.equal(splitRows(f.hunks[1]).length, 2);
});

test("decisions drop rejected hunks and build a reverse patch", () => {
  const files = parseUnifiedDiff(DIFF);
  const order = hunkOrder(files);
  assert.equal(order.length, 2);
  const decisions = { [order[1]]: "rejected" as const, [order[0]]: "accepted" as const };
  assert.deepEqual(keptCounts(files, decisions), { additions: 2, deletions: 1, files: 1, pending: 0 });
  const patch = rejectedPatch(files[0], decisions);
  assert.ok(patch.includes("@@ -21,2 +20,2 @@"));
  assert.ok(patch.includes("-const a = 2;"));
  assert.ok(patch.includes("+const a = 1;"));
  assert.equal(moveHunkFocus(order, null, 1), order[0]);
  assert.equal(moveHunkFocus(order, order[1], 1), order[1]);
  assert.equal(parseUnifiedDiff("@@ -1 +1 @@\n-a\n+b\n", "x.ts")[0].path, "x.ts");
});

test("sidebar sections: needs you first, projects by recency", () => {
  const s = threadSections([
    { id: "1", title: "A", project: "storefront", state: "idle", updatedAt: t(1) },
    { id: "2", title: "B", project: "docs", state: "waiting", updatedAt: t(5) },
    { id: "3", title: "C", project: "storefront", state: "running", updatedAt: t(9) },
  ]);
  assert.deepEqual(s.map((x) => x.title), ["Needs you", "storefront", "docs"]);
  assert.deepEqual(s[1].threads.map((x) => x.id), ["3", "1"]);
});

test("FLIP plan clamps lonely travel and skips mass fades", () => {
  const prev = new Map([["a", 0], ["b", 32], ["c", 64], ["d", 96]]);
  const next = new Map([["a", 0], ["b", 32], ["d", 64], ["e", 96]]);
  const plan = planFlip(prev, next);
  assert.deepEqual([...plan.moves], [["d", 32]]);
  assert.deepEqual(plan.entering, ["e"]);
  assert.deepEqual(plan.leaving, ["c"]);
  const far = planFlip(new Map([["a", 0], ["b", 200]]), new Map([["b", 0], ["a", 32]]));
  assert.equal(far.moves.get("b"), 200, "a row whose neighbour moved keeps its full travel");
  const many = new Map(Array.from({ length: 50 }, (_, i) => [`n${i}`, i * 32] as [string, number]));
  assert.equal(planFlip(new Map(), many).skipFades, true);
});
