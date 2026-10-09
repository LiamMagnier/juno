import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findLearningBlocks } from "@/lib/live-ui/legacy/learning-blocks";
import {
  LEGACY_UNREADABLE_TEXT,
  isLegacyVisualFence,
  legacyBlockSpec,
  legacyVisualSource,
  legacyVisualSpec,
  rewriteLegacyBlocks,
} from "@/lib/live-ui/legacy/convert";
import { isLiveUIFence } from "@/lib/live-ui/fence";
import { parseLiveUI, liveDefaults, type LiveComponent } from "@/lib/live-ui/spec";
import { LiveScope } from "@/lib/live-ui/expr";
import { splitMessageContent } from "@/lib/message-content";

/*
 * History keeps rendering after the old interactive blocks were retired:
 * every old `:::kind` block and ```juno-visual fence converts to a Live UI
 * spec (docs/design/LIVE_UI.md §12), the same spec natively (legacy.json is
 * shared with JunoLiveUILegacyTests.swift), and that spec is a complete view.
 */

const fixture = JSON.parse(readFileSync("contracts/live-ui/fixtures/legacy.json", "utf8")) as {
  cases: { name: string; kind: "block" | "visual"; source: string; expect: unknown }[];
};

function walk(list: readonly LiveComponent[], out: LiveComponent[] = []): LiveComponent[] {
  for (const c of list) {
    out.push(c);
    if ("children" in c) walk(c.children, out);
    if (c.type === "steps") for (const s of c.steps) walk(s.ui, out);
  }
  return out;
}

function convert(c: (typeof fixture.cases)[number]): unknown {
  if (c.kind === "visual") return legacyVisualSpec(c.source);
  const blocks = findLearningBlocks(c.source);
  assert.equal(blocks.length, 1, c.name);
  return legacyBlockSpec(blocks[0]);
}

test("fixtures: each old block and visual converts to the pinned Live UI spec", () => {
  assert.ok(fixture.cases.length >= 15);
  for (const c of fixture.cases) assert.deepEqual(convert(c), c.expect, c.name);
});

test("every converted spec is a complete view: it parses, nothing pending, every value evaluates", () => {
  for (const c of fixture.cases) {
    if (c.expect === null) continue;
    const { spec, error } = parseLiveUI(JSON.stringify(c.expect));
    assert.ok(spec, `${c.name}: ${error}`);
    assert.equal(spec!.streaming, false, c.name);
    const all = walk(spec!.ui);
    assert.ok(all.length > 0, c.name);
    assert.ok(!all.some((x) => x.type === "pending"), c.name);
    const scope = new LiveScope({ inputs: liveDefaults(spec!), lets: spec!.lets, data: spec!.data });
    for (const x of all) {
      if (x.type === "table" || (x.type === "chart" && x.rows)) {
        const rows = scope.evaluate(x.type === "table" ? x.rows : x.rows!).value;
        assert.ok(Array.isArray(rows) && rows.length > 0, `${c.name}: rows`);
      }
      if (x.type === "metric") assert.notEqual(scope.evaluate(x.value).value, null, c.name);
    }
  }
});

test("the Step Lab demo keeps its shape: five steps, real data, the check on the last step", () => {
  const lab = fixture.cases.find((c) => c.name === "demo step-lab")!;
  const { spec } = parseLiveUI(JSON.stringify(lab.expect));
  const steps = spec!.ui.find((c) => c.type === "steps");
  assert.ok(steps && steps.type === "steps");
  assert.deepEqual(
    steps.steps.map((s) => s.title),
    ["Tokenization", "Embeddings", "Attention", "Probability Distribution", "Next Token"],
  );
  assert.deepEqual(
    steps.steps.map((s) => s.ui.map((c) => c.type)),
    [["text", "table"], ["table"], ["table"], ["chart"], ["text"]],
  );
  assert.ok(steps.takeaway === undefined || typeof steps.takeaway === "string");
});

test("nothing is invented: a Step Lab step without data has no visual", () => {
  const c = fixture.cases.find((x) => x.name.startsWith("step lab: transformer"))!;
  const { spec } = parseLiveUI(JSON.stringify(c.expect));
  const steps = spec!.ui.find((x) => x.type === "steps");
  assert.ok(steps && steps.type === "steps");
  assert.equal(steps.steps[2].title, "Sample");
  // The last step carries only the lab's own check, no made-up distribution.
  assert.deepEqual(steps.steps[2].ui.map((x) => x.type), ["quiz"]);
});

test("unreadable blocks become one quiet line, never YAML", () => {
  const c = fixture.cases.find((x) => x.name === "unreadable")!;
  assert.ok(JSON.stringify(c.expect).includes(LEGACY_UNREADABLE_TEXT));
});

const demo = [
  "Intro prose.",
  "",
  ":::learning-card",
  "title: Core idea",
  "tone: insight",
  "content: A model predicts one token at a time.",
  ":::",
  "",
  "Between.",
  "",
  "```yaml",
  ":::quiz",
  "question: inside code stays code",
  ":::",
  "```",
  "",
  ":::process-timeline",
  "title: Loop",
  "steps:",
  "- label: Read",
  "  description: `ctx` in",
  "- label: Write",
  ":::",
].join("\n");

test("a saved reply's old blocks are rewritten to ```live-ui fences; prose and code are untouched", () => {
  const out = rewriteLegacyBlocks(demo);
  assert.ok(!/^:::(learning-card|process-timeline)/m.test(out));
  const fences = [...out.matchAll(/```live-ui\n(.*)\n```/g)].map((m) => m[1]);
  assert.equal(fences.length, 2);
  for (const f of fences) {
    assert.ok(!f.includes("`"), "a backtick inside the JSON would close the fence");
    assert.ok(parseLiveUI(f).spec);
  }
  assert.ok(JSON.parse(fences[1]).ui[0].items[0].detail.includes("ctx"));
  assert.ok(out.includes("Intro prose.") && out.includes("Between."));
  assert.ok(out.includes(":::quiz\nquestion: inside code stays code"), "a block inside a code fence is code");
  assert.equal(rewriteLegacyBlocks("No blocks here."), "No blocks here.");
});

test("message parts carry the rewritten text, so history renders through Markdown → Live UI", () => {
  const parts = splitMessageContent(demo);
  assert.ok(parts.every((p) => p.type === "text"));
  const text = parts.map((p) => (p.type === "text" ? p.text : "")).join("");
  assert.equal((text.match(/```live-ui/g) ?? []).length, 2);
});

test("markdown routing: juno-visual aliases go to the legacy converter, live-ui to Live UI", () => {
  for (const lang of ["juno-visual", "juno-ui", "juno-block", "visual", "visual-block", "JUNO-VISUAL"]) assert.ok(isLegacyVisualFence(lang), lang);
  for (const lang of ["live-ui", "live", "juno-live"]) {
    assert.ok(isLiveUIFence(lang));
    assert.ok(!isLegacyVisualFence(lang));
  }
  assert.ok(!isLegacyVisualFence("mermaid"));
  // A visual still streaming draws a skeleton, a finished broken one a note.
  assert.equal(legacyVisualSource('{"type":"cards","items":[{"ti', true), "");
  assert.ok(legacyVisualSource('{"type":"cards"', false).includes(LEGACY_UNREADABLE_TEXT));
});
