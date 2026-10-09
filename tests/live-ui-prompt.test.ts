import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_UI_SECTION, buildSystemPromptSections } from "@/lib/chat/system-prompt";
import { lenientClientFeatures } from "@/lib/chat/request";
import { parseLiveUI, liveDefaults, type LiveComponent } from "@/lib/live-ui/spec";
import { LiveScope } from "@/lib/live-ui/expr";
import samples from "../contracts/live-ui/samples.json";

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

test("without Live UI (shipped native builds that cannot draw it) the reply is plain prose: no views, no old blocks", () => {
  const off = buildSystemPromptSections({ ...base }).stable;
  assert.ok(off.includes("- ANSWER / CHAT — a question, a quick task, or conversation. Plain prose."));
  assert.ok(!off.includes("live-ui"));
  assert.ok(!off.includes("Live UI"));
});

test("the retired learning blocks are taught nowhere: no :::kind, no juno-visual, in any variant", () => {
  const variants = [
    buildSystemPromptSections({ ...base, liveUi: true }).stable,
    buildSystemPromptSections({ ...base, liveUi: false }).stable,
    buildSystemPromptSections({ ...base, liveUi: true, semanticArtifacts: false, taskHandoff: true, untrustedContent: true }).stable,
    buildSystemPromptSections({ ...base, voiceMode: true }).stable,
  ];
  for (const text of variants) {
    assert.ok(!/:::(step-lab|learning-card|process-timeline|comparison|quiz|deep-dive)/.test(text));
    assert.ok(!/juno-visual|learning block|step lab|Step Lab/i.test(text));
  }
});

test("the model decides on its own, with judgement, and the examples cover explain, compare and calculate", () => {
  assert.match(LIVE_UI_SECTION, /Decide for yourself/);
  assert.match(LIVE_UI_SECTION, /the user never has to ask/);
  assert.match(LIVE_UI_SECTION, /Never decorate/);
  assert.match(LIVE_UI_SECTION, /Never use a view for BUILD requests/);
  // ChatGPT-style defaults (owner, 2026-10-09): lessons from the user's
  // documents, long multi-part replies and plans all name a view.
  assert.match(LIVE_UI_SECTION, /reach for one by default/);
  assert.match(LIVE_UI_SECTION, /a course or revision from the user's documents/);
  assert.match(LIVE_UI_SECTION, /Length is not a reason to skip a view/);
  assert.match(LIVE_UI_SECTION, /study or learning programme/);
  const types = [...LIVE_UI_SECTION.matchAll(/"type":"([a-z]+)"/g)].map((m) => m[1]);
  for (const t of ["steps", "quiz", "table", "callout", "slider", "metric", "chart", "explorer"]) assert.ok(types.includes(t), t);
  assert.ok(LIVE_UI_SECTION.includes('"rowHeader":true'));
});

test("a practice turn never leaks the exercise's solution", () => {
  assert.match(LIVE_UI_SECTION, /never reveal that exercise's solution, in prose or in a view/);
  assert.match(LIVE_UI_SECTION, /a quiz may only check a different, simpler point/);
});

test("views are taught for artifacts too: a MARKDOWN fence and a DOCUMENT interactive block", () => {
  assert.match(LIVE_UI_SECTION, /a ```live-ui fence in a MARKDOWN artifact/);
  assert.match(LIVE_UI_SECTION, /an "interactive" block \(its "view" is this same JSON\) in a DOCUMENT/);
});

test("the head stays identical across users with Live UI on", () => {
  const a = buildSystemPromptSections({ ...base, liveUi: true, userName: "Ada", memorySummary: "Ada codes." });
  const b = buildSystemPromptSections({ ...base, liveUi: true, userName: "Grace", memorySummary: "Grace bakes." });
  assert.equal(a.stable, b.stable);
});

test("the section stays compact (it is paid on every turn)", () => {
  // Grew from ~5,300 to ~7,000 characters on 2026-10-09 when the triggers
  // were named (ChatGPT-style defaults); keep it under this ceiling.
  assert.ok(LIVE_UI_SECTION.length < 7400, `Live UI section is ${LIVE_UI_SECTION.length} chars`);
});

function walk(list: readonly LiveComponent[], out: LiveComponent[] = []): LiveComponent[] {
  for (const c of list) {
    out.push(c);
    if ("children" in c) walk(c.children, out);
    if (c.type === "steps") for (const s of c.steps) walk(s.ui, out);
  }
  return out;
}

function assertValidViews(text: string, expected: number) {
  const blocks = [...text.matchAll(/```live-ui\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.equal(blocks.length, expected);
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
      if (c.type === "table" || (c.type === "chart" && c.rows)) {
        const rows = scope.evaluate(c.type === "table" ? c.rows : c.rows!).value;
        assert.ok(Array.isArray(rows) && rows.length > 0, "rows");
      }
      if (c.type === "chart" && c.x) {
        for (const s of c.series) assert.notEqual(scope.evaluate(s.y, { [c.x.variable]: 1 }).value, null, s.y);
      }
    }
  }
}

test("every example in the prompt is a complete view whose formulas evaluate", () => {
  assertValidViews(LIVE_UI_SECTION, 3);
});

test("every gallery sample (shared with the native snapshots) is a valid view", () => {
  for (const sample of samples.samples) assertValidViews(sample.reply, (sample.reply.match(/```live-ui\n/g) ?? []).length || 1);
});

test("native builds opt in with the live_ui client feature", () => {
  assert.deepEqual(lenientClientFeatures(["timeline", "live_ui", "nope"]), ["timeline", "live_ui"]);
});
