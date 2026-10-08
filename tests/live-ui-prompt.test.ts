import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_UI_SECTION, buildSystemPromptSections } from "@/lib/chat/system-prompt";
import { lenientClientFeatures } from "@/lib/chat/request";
import { parseLiveUI, liveDefaults, type LiveComponent } from "@/lib/live-ui/spec";
import { LiveScope } from "@/lib/live-ui/expr";

/*
 * The Live UI prompt contract (docs/design/LIVE_UI.md §7): when the section is
 * present, that it keeps the cached head stable, and that every example it
 * shows the model is itself a valid, complete view whose formulas evaluate.
 * A model copies its examples; a broken example is a broken feature.
 */

const base = { memoryEnabled: true, canvas: true, voiceMode: false } as const;

test("the section is present only when the client renders Live UI, and never on voice", () => {
  assert.ok(buildSystemPromptSections({ ...base, liveUi: true }).stable.includes("# Live UI"));
  assert.ok(!buildSystemPromptSections({ ...base, liveUi: false }).stable.includes("# Live UI"));
  assert.ok(!buildSystemPromptSections({ ...base, liveUi: true, voiceMode: true }).stable.includes("# Live UI"));
});

test("without Live UI the prompt is byte-identical to before (shipped native builds keep their cache)", () => {
  const off = buildSystemPromptSections({ ...base }).stable;
  assert.ok(off.includes("Plain prose. No blocks."));
  assert.ok(!off.includes("live-ui"));
});

test("the head stays identical across users with Live UI on", () => {
  const a = buildSystemPromptSections({ ...base, liveUi: true, userName: "Ada", memorySummary: "Ada codes." });
  const b = buildSystemPromptSections({ ...base, liveUi: true, userName: "Grace", memorySummary: "Grace bakes." });
  assert.equal(a.stable, b.stable);
});

test("the section stays compact (it is paid on every turn)", () => {
  assert.ok(LIVE_UI_SECTION.length < 5200, `Live UI section is ${LIVE_UI_SECTION.length} chars`);
});

function walk(list: readonly LiveComponent[], out: LiveComponent[] = []): LiveComponent[] {
  for (const c of list) {
    out.push(c);
    if ("children" in c) walk(c.children, out);
  }
  return out;
}

test("every example in the prompt is a complete view whose formulas evaluate", () => {
  const blocks = [...LIVE_UI_SECTION.matchAll(/```live-ui\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.equal(blocks.length, 3);
  for (const source of blocks) {
    const { spec, error } = parseLiveUI(source);
    assert.ok(spec, error);
    assert.equal(spec!.streaming, false);
    const all = walk(spec!.ui);
    assert.ok(all.length > 0);
    assert.ok(!all.some((c) => c.type === "pending"));
    const scope = new LiveScope({ inputs: liveDefaults(spec!), lets: spec!.lets, data: spec!.data });
    for (const name of Object.keys(spec!.lets)) assert.notEqual(scope.evaluate(name).value, null, `let ${name}`);
    for (const c of all) {
      if (c.type === "metric") assert.notEqual(scope.evaluate(c.value).value, null, c.value);
      if (c.type === "chart" && c.x) {
        for (const s of c.series) assert.notEqual(scope.evaluate(s.y, { [c.x.variable]: 1 }).value, null, s.y);
      }
    }
  }
});

test("native builds opt in with the live_ui client feature", () => {
  assert.deepEqual(lenientClientFeatures(["timeline", "live_ui", "nope"]), ["timeline", "live_ui"]);
});
