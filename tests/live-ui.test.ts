import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readLiveJSON, openPaths } from "@/lib/live-ui/json";
import { LiveScope, interpolate, parseExpr, type LiveValue } from "@/lib/live-ui/expr";
import {
  isLiveUIFence,
  liveDefaults,
  liveHash,
  liveStorageKey,
  parseLiveUI,
  snapToStep,
  type LiveComponent,
} from "@/lib/live-ui/spec";
import { canonicalNumberString, roundHalfAway } from "@/lib/live-ui/format";

/*
 * Live UI (docs/design/LIVE_UI.md). The first three tests run the shared
 * contract fixtures — the same files
 * native/Packages/JunoNativeKit/Tests/JunoDesignSystemTests/LiveUIFixtureTests.swift
 * runs — so a formula, a streaming prefix or a repaired component means the
 * same thing in the browser and on a phone. The rest pin the safety bounds.
 */

const FIXTURES = join(process.cwd(), "contracts/live-ui/fixtures");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

function close(actual: LiveValue, expected: LiveValue, where: string): void {
  if (typeof expected === "number" && typeof actual === "number") {
    const tolerance = Math.max(1e-9, Math.abs(expected) * 1e-9);
    assert.ok(Math.abs(actual - expected) <= tolerance, `${where}: ${actual} != ${expected}`);
    return;
  }
  if (Array.isArray(expected) && Array.isArray(actual)) {
    assert.equal(actual.length, expected.length, `${where}: length`);
    expected.forEach((e, i) => close(actual[i], e, `${where}[${i}]`));
    return;
  }
  assert.deepEqual(actual, expected, where);
}

test("fixtures: tolerant JSON reader", () => {
  for (const c of fixture("json.json").cases) {
    const r = readLiveJSON(c.source);
    if (c.error) {
      assert.ok(r.error, `expected an error for ${JSON.stringify(c.source)}`);
      continue;
    }
    assert.equal(r.error, undefined, c.source);
    assert.equal(r.value !== undefined, c.hasValue, `hasValue ${c.source}`);
    if (c.hasValue) assert.deepEqual(r.value, c.value, c.source);
    assert.deepEqual(openPaths(r), c.open, `open ${c.source}`);
    assert.equal(r.complete, c.complete, `complete ${c.source}`);
  }
});

test("fixtures: expressions, lets and canonical formatting", () => {
  for (const c of fixture("expr.json").cases) {
    const scope = new LiveScope({ inputs: c.inputs ?? {}, lets: c.let ?? {}, data: c.data ?? {}, currency: c.currency });
    if (c.expectLets) {
      const lets = scope.allLets();
      for (const [name, expected] of Object.entries(c.expectLets as Record<string, { value?: LiveValue; error?: boolean }>)) {
        if (expected.error) assert.ok(lets.errors[name], `${c.name}: let ${name} should fail`);
        else close(lets.values[name], expected.value ?? null, `${c.name}: let ${name}`);
      }
    }
    for (const e of c.exprs as { expr: string; value?: LiveValue; error?: boolean }[]) {
      const r = scope.evaluate(e.expr);
      if (e.error) {
        assert.equal(r.value, null, `${c.name}: ${e.expr}`);
        assert.ok(r.error, `${c.name}: ${e.expr} should report an error`);
      } else {
        assert.equal(r.error, undefined, `${c.name}: ${e.expr} → ${r.error}`);
        close(r.value, e.value ?? null, `${c.name}: ${e.expr}`);
      }
    }
  }
});

function summarize(c: LiveComponent): Record<string, unknown> {
  const o: Record<string, unknown> = { key: c.key, type: c.type };
  if ("id" in c) o.id = c.id;
  if ("value" in c && c.type !== "metric" && c.type !== "progress") o.value = c.value;
  if (c.type === "metric" || c.type === "progress") o.expr = c.value;
  if ("children" in c) {
    o.pending = c.pending;
    o.children = c.children.map(summarize);
  }
  if (c.type === "select") {
    o.style = c.style;
    o.options = c.options.map((x) => x.value);
  }
  if (c.type === "slider" || c.type === "stepper") {
    o.min = c.min;
    o.max = c.max;
    o.step = c.step;
  }
  if (c.type === "explorer") {
    o.parts = c.parts.map((p) => p.id);
    o.placed = c.parts.every((p) => !!p.at);
    o.links = c.links.length;
  }
  if (c.type === "chart") {
    o.kind = c.kind;
    o.series = c.series.length;
    o.range = !!c.x;
  }
  if (c.type === "text") o.tone = c.tone;
  if (c.type === "steps") {
    o.steps = c.steps.map((s) => ({ title: s.title, notice: !!s.notice, children: s.ui.map(summarize) }));
    o.takeaway = !!c.takeaway;
  }
  if (c.type === "quiz") o.answers = c.questions.map((q) => q.answer);
  if (c.type === "exercise") {
    o.title = c.title;
    o.tag = c.tag ?? null;
    o.language = c.language ?? null;
    o.hints = c.hints.length;
  }
  if (c.type === "callout") {
    o.tone = c.tone;
    o.more = !!c.more;
  }
  if (c.type === "timeline") o.items = c.items.length;
  if (c.type === "table") {
    if (c.rowHeader) o.rowHeader = true;
    if (c.highlight !== undefined) o.highlight = c.highlight;
  }
  return o;
}

test("fixtures: spec normalisation, streaming prefixes and repairs", () => {
  for (const c of fixture("spec.json").cases) {
    const r = parseLiveUI(c.source);
    if (c.error) {
      assert.equal(r.spec, null, c.name);
      continue;
    }
    assert.ok(r.spec, c.name);
    const s = r.spec!;
    assert.deepEqual(
      {
        title: s.title ?? null,
        currency: s.currency,
        streaming: s.streaming,
        lets: Object.keys(s.lets),
        data: Object.keys(s.data),
        ui: s.ui.map(summarize),
      },
      c.expect,
      c.name,
    );
  }
});

// ── Streaming: every prefix of a real block renders without error ───────────

test("streaming: every prefix of a block parses, and inputs only ever grow", () => {
  const source = fixture("spec.json").cases[0].source as string;
  let last = 0;
  for (let n = 0; n <= source.length; n++) {
    const r = parseLiveUI(source.slice(0, n));
    assert.ok(r.spec, `prefix ${n} failed: ${r.error}`);
    const count = Object.keys(liveDefaults(r.spec!)).length;
    assert.ok(count >= last, `inputs shrank at ${n}`);
    last = count;
  }
  assert.equal(last, 2);
});

test("streaming: a half-written number or string is never surfaced", () => {
  const r = parseLiveUI(`{"ui":[{"type":"slider","id":"a","label":"A","min":0,"max":10`);
  assert.deepEqual(r.spec!.ui.map((c) => c.type), ["pending"]);
  const t = readLiveJSON(`{"title":"Hel`);
  assert.deepEqual(t.value, {});
});

// ── Safety bounds ───────────────────────────────────────────────────────────

test("safety: no host access through names or members", () => {
  const scope = new LiveScope({ inputs: {}, lets: {}, data: { o: { a: 1 } } });
  for (const src of ["constructor", "o.constructor", "o.__proto__", "o['constructor']", "toString", "globalThis", "process"]) {
    const r = scope.evaluate(src);
    assert.equal(r.value, null, src);
  }
  // Function names outside the fixed table do not parse.
  assert.ok(new LiveScope({ inputs: {}, lets: {}, data: {} }).evaluate("eval('1')").error);
});

test("safety: expression size, depth and work are bounded", () => {
  const scope = new LiveScope({ inputs: {}, lets: {}, data: {} });
  assert.ok(scope.evaluate("1+".repeat(250) + "1").error, "length");
  assert.ok(scope.evaluate("(".repeat(40) + "1" + ")".repeat(40)).error, "depth");
  assert.ok(scope.evaluate(Array.from({ length: 100 }, () => "1").join("+")).error, "nodes");
  // Element-wise work over long lists runs out of budget instead of spinning:
  // each let multiplies a 500-long list twenty times, and the chain shares
  // one budget.
  const times = (name: string) => Array.from({ length: 20 }, () => name).join(" * ");
  const heavy = new LiveScope({
    inputs: {},
    lets: { r: "range(1, 500) / 500", l1: times("r"), l2: times("l1"), l3: times("l2"), l4: times("l3"), l5: times("l4"), l6: times("l5") },
    data: {},
  });
  const r = heavy.evaluate("sum(l6)");
  assert.equal(r.value, null);
  assert.ok(r.error);
});

test("safety: self-reference and long cycles end as errors, not hangs", () => {
  const lets: Record<string, string> = { a: "a + 1" };
  for (let i = 0; i < 39; i++) lets[`n${i}`] = `n${(i + 1) % 39} + 1`;
  const scope = new LiveScope({ inputs: {}, lets, data: {} });
  const all = scope.allLets();
  assert.ok(all.errors.a);
  assert.ok(all.errors.n0 && all.errors.n38);
});

test("safety: the spec caps components, lists and source size", () => {
  const many = { ui: Array.from({ length: 200 }, (_, i) => ({ type: "text", text: `t${i}` })) };
  assert.equal(parseLiveUI(JSON.stringify(many)).spec!.ui.length, 80);
  const rows = { data: { xs: Array.from({ length: 500 }, (_, i) => i) }, ui: [] };
  const spec = parseLiveUI(JSON.stringify(rows)).spec!;
  assert.equal((spec.data.xs as LiveValue[]).length, 200);
  assert.ok(parseLiveUI(`{"title":"${"x".repeat(25_000)}"}`).error);
});

test("expressions: interpolation formats numbers and leaves odd braces alone", () => {
  const scope = new LiveScope({ inputs: { n: 1234.5 }, lets: {}, data: {} });
  assert.equal(interpolate("Total {{n}} and {{fmt(n,'currency')}}", scope), "Total 1,234.5 and $1,234.50");
  assert.equal(interpolate("Missing {{nope}} here", scope), "Missing – here");
  assert.equal(interpolate("Literal {{ not closed", scope), "Literal {{ not closed");
});

test("expressions: parse is cached and stable", () => {
  assert.equal(parseExpr("a + b"), parseExpr("a + b"));
  assert.throws(() => parseExpr("a +"));
});

test("format helpers", () => {
  assert.equal(roundHalfAway(-0.4), 0);
  assert.equal(canonicalNumberString(1 / 3), "0.3333333333");
  assert.equal(canonicalNumberString(2e21), "2.000e+21");
  assert.equal(snapToStep(0.30000000000000004, 0, 1, 0.1), 0.3);
  assert.equal(snapToStep(7, 0, 10, 3), 6);
});

test("fence names and storage keys", () => {
  assert.ok(isLiveUIFence("live-ui"));
  assert.ok(isLiveUIFence("LIVE"));
  assert.ok(!isLiveUIFence("json"));
  assert.equal(liveHash(""), "811c9dc5");
  assert.equal(liveHash("a"), "e40c292c");
  assert.equal(liveStorageKey("m1", " {} "), `live-ui:v1:m1:${liveHash("{}")}`);
});
