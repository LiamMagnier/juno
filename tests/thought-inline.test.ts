import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { compactTrace, traceTail } from "@/lib/chat/compact-trace";
import { buildRun, type RunModel, type Step } from "@/components/chat/thought-process-model";
import { THOUGHT_INLINE_LABEL, ThoughtInline } from "@/components/chat/thought-inline";
import { shouldDismiss } from "@/lib/sheet-gesture";

/*
 * G14: reasoning expands inline under the live line (grid rows 0fr → 1fr plus
 * opacity), stays readable after the answer finishes, and on a phone the full
 * trace is a bottom sheet over the chat rather than a column that replaces it.
 */

// The icon set is written for the automatic JSX runtime; tsx compiles classic.
(globalThis as { React?: typeof React }).React = React;

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const step = (over: Partial<Step> & Pick<Step, "id" | "kind" | "label">): Step => ({
  phase: "think",
  detail: null,
  ms: null,
  running: false,
  failed: false,
  ...over,
});

test("the inline trace folds sources and memories, keeps every other step in order", () => {
  const rows = compactTrace({
    steps: [
      step({ id: "s1", kind: "search", phase: "research", label: "Searched “heat pumps”" }),
      step({ id: "v1", kind: "source", phase: "research", label: "Heat pumps explained", source: { url: "https://a.org/x", domain: "a.org", access: "read", citeIndex: 1 } }),
      step({ id: "v2", kind: "source", phase: "research", label: "Costs", source: { url: "https://b.org/y", domain: "b.org", access: "read", citeIndex: null } }),
      step({ id: "v3", kind: "source", phase: "research", label: "Heat pumps explained", source: { url: "https://a.org/x", domain: "a.org", access: "read", citeIndex: 1 } }),
      step({ id: "reason-0", kind: "think", label: "Weighing the costs", body: { type: "prose", text: "First, the install.\n\nThen running costs." } }),
      step({ id: "reason-1", kind: "think", label: "Reasoning", body: { type: "prose", text: "An untitled part." } }),
      step({ id: "t1", kind: "tool", label: "Ran Python", icon: "code", ms: 1200 }),
      step({ id: "memory-a", kind: "memory", label: "Lives in Leeds" }),
      step({ id: "memory-b", kind: "memory", label: "Prefers metric units" }),
      step({ id: "write", kind: "write", phase: "write", label: "Wrote the answer", ms: 800 }),
    ],
  });
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["step", "sources", "reasoning", "reasoning", "step", "memory", "step"],
  );
  const sources = rows.find((r) => r.kind === "sources");
  assert.equal(sources?.kind === "sources" && sources.sources.length, 2, "a page read twice is one source");
  const [titled, untitled] = rows.filter((r) => r.kind === "reasoning");
  assert.equal(titled.kind === "reasoning" && titled.heading, "Weighing the costs");
  assert.equal(untitled.kind === "reasoning" && untitled.heading, null, "a part with no heading of its own gets none");
  const memory = rows.find((r) => r.kind === "memory");
  assert.deepEqual(memory?.kind === "memory" && memory.items, ["Lives in Leeds", "Prefers metric units"]);
  const tool = rows.find((r) => r.id === "t1");
  assert.equal(tool?.kind === "step" && tool.icon, "code");
});

test("a running think step with no prose stays a live row", () => {
  const rows = compactTrace({ steps: [step({ id: "running", kind: "think", label: "Thinking", running: true })] });
  assert.equal(rows[0].kind, "step");
  assert.equal(rows[0].kind === "step" && rows[0].running, true);
});

test("the live view shows the tail of a long trace, cut at a boundary", () => {
  assert.deepEqual(traceTail("Short."), { text: "Short.", clipped: false });
  const long = `${"Old paragraph. ".repeat(200)}\n\nThe current thought is here.`;
  const tail = traceTail(long, 400);
  assert.equal(tail.clipped, true);
  assert.ok(tail.text.endsWith("The current thought is here."));
  assert.ok(tail.text.length <= 400);
});

test("ThoughtInline renders the model's sections, the receipts and the way to the full trace", () => {
  const base = buildRun([], null, null, {
    reasoningParts: ["**Checking the dates**\n\nThe treaty was signed in 1648.", "**Writing it up**\n\nKeep it short."],
  });
  const run: RunModel = {
    ...base,
    steps: [
      ...base.steps,
      step({ id: "t1", kind: "tool", label: "Linear · Create issue", detail: "The connector timed out.", failed: true }),
      step({ id: "v1", kind: "source", phase: "research", label: "Peace of Westphalia", source: { url: "https://en.wikipedia.org/wiki/Peace_of_Westphalia", domain: "en.wikipedia.org", access: "read", citeIndex: null } }),
    ],
  };
  const html = renderToStaticMarkup(
    React.createElement(ThoughtInline, { id: "thought-inline-m1", run, onOpenFull: () => {}, fullOpen: false }),
  );
  assert.match(html, /id="thought-inline-m1"/);
  assert.match(html, /role="region"/);
  assert.ok(html.includes(`aria-label="${THOUGHT_INLINE_LABEL.region}"`));
  assert.match(html, /Checking the dates/);
  assert.match(html, /The treaty was signed in 1648\./);
  assert.match(html, /Linear · Create issue/);
  assert.match(html, /The connector timed out\./);
  assert.match(html, /Peace of Westphalia/);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.ok(html.includes(THOUGHT_INLINE_LABEL.openFull));
  assert.match(html, /aria-expanded="false"/);
  // The reasoning scroller can be reached and scrolled by keyboard.
  assert.match(html, /tabindex="0"[^>]*aria-label="Checking the dates"|aria-label="Checking the dates"[^>]*tabindex="0"/);
  assert.match(html, /data-no-auto-translate/);
});

test("the strip unfolds in place; the dock and the sheet are one press further", () => {
  const strip = read("src/components/chat/activity-timeline.tsx");
  // Both triggers toggle the inline disclosure, never the dock directly.
  assert.equal((strip.match(/onClick=\{\(\) => setInlineOpen\(\(v\) => !v\)\}/g) ?? []).length, 2);
  assert.ok(!strip.includes("onClick={() => panel?.setOpenId(open ? null : messageId)}"));
  assert.match(strip, /<Collapse open=\{inlineOpen\}>/);
  // Wide: the dock. Phone (the split not engaged): the bottom sheet.
  assert.match(strip, /if \(panel && !\(panel\.coversChat\?\.\(\) \?\? false\)\) \{\s+panel\.setOpenId/);
  assert.match(strip, /<BottomSheet tall open=\{sheetOpen\}/);
  assert.match(strip, /presentation="sheet"/);
  // The disclosure's motion is the grid-rows recipe with a fade, snapped under reduced motion.
  const collapse = read("src/components/ui/collapse.tsx");
  assert.match(collapse, /gridTemplateRows: "0fr", opacity: 0/);
  assert.match(collapse, /reduce \? \{ duration: 0 \}/);
});

test("in a sheet the panel dismisses rather than going back, and drags by its header", () => {
  const panel = read("src/components/chat/thought-process-panel.tsx");
  assert.match(panel, /data-sheet-handle=\{sheet \? "" : undefined\}/);
  assert.match(panel, /sheet \? "hidden" : "@\[50rem\]\/split:hidden"/);
  assert.match(panel, /sheet \? "inline-flex" : "hidden @\[50rem\]\/split:inline-flex"/);
});

test("a released sheet drag dismisses on a fling or a long pull, not on a jitter (the one sheet engine)", () => {
  // BottomSheet is the house bottom sheet now, so its release rule is
  // sheet-gesture's: 0.5px/ms, or 30% of the sheet's height.
  const size = 600;
  assert.equal(shouldDismiss({ offset: 0, size, velocity: 2 }), false);
  assert.equal(shouldDismiss({ offset: -40, size, velocity: 2 }), false, "an upward drag never dismisses");
  assert.equal(shouldDismiss({ offset: 40, size, velocity: 0.8 }), true, "a fling");
  assert.equal(shouldDismiss({ offset: 150, size, velocity: 0.1 }), false, "a slow pull short of the fraction");
  assert.equal(shouldDismiss({ offset: 190, size, velocity: 0.1 }), true, "a slow pull past the fraction");
});

test("the bottom sheet is the house sheet: one grabber, one rise and sink, one gesture, one focus return", () => {
  // Code, not the doc comment that records what the old engine did.
  const sheet = read("src/components/ui/bottom-sheet.tsx").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(sheet, /<SheetContent\s+side="bottom"/);
  // No private engine left behind: keyframes, pointer code or a grabber of its own.
  assert.doesNotMatch(sheet, /@keyframes|onPointerDown|data-sheet-drag|bg-muted-foreground\/35|88dvh/);
  // The house sheet travels on the shared rise/sink pair, which reads --motion-shift.
  const css = read("src/components/ui/sheet.css");
  assert.match(css, /ui-sheet-rise var\(--dur-slow\) var\(--ease-drawer\)/);
  assert.match(css, /ui-sheet-sink var\(--dur-base\) var\(--ease-in\)/);
  assert.match(css, /translate3d\(0, calc\(100% \* var\(--motion-shift, 1\)\), 0\)/);
  const house = read("src/components/ui/sheet.tsx");
  assert.match(house, /useDialogFocusReturn/);
});
