import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_TOLERANCES,
  aggregateSite,
  analyzeRoute,
  buildTree,
  checkAlignment,
  checkAsymmetry,
  checkIconGaps,
  checkNestedRadius,
  checkRowHeights,
  checkSiblingPadding,
  checkTargets,
  clusterValues,
  compareRuns,
  concentricExpected,
  cornerInsets,
  cornerPokeOut,
  effectiveRadii,
  histogram,
  isFullRadius,
  isOnScale,
  judgeCorner,
  judgeValue,
  makeContext,
  measuredValues,
  modeOf,
  nearestRung,
  normalizeRoutes,
  overlayIconEdges,
  parseCssVars,
  parseLength,
  parseRadiusLadder,
  parseViewport,
  pickOffenders,
  rankFindings,
  scoreFrom,
  slugify,
  spacingExceptionOk,
  textFlags,
} from "../scripts/design-audit/geometry-lib.mjs";
import { histogramLine, renderMarkdown } from "../scripts/design-audit/geometry-report.mjs";

// A record with the collector's shape and quiet defaults; tests override what they need.
// The records and findings are plain JSON from an untyped .mjs module.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>;
function rec(i: number, p: number, over: Rec = {}): Rec {
  return {
    i,
    p,
    tag: "div",
    path: `div:nth-of-type(${i})`,
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    disp: "block",
    pos: "static",
    pad: [0, 0, 0, 0],
    mar: [0, 0, 0, 0],
    bw: [0, 0, 0, 0],
    rad: [0, 0, 0, 0],
    gap: null,
    paint: "",
    clip: false,
    ...over,
  };
}

const ctx = makeContext({ scales: { radius: [0, 2, 4, 6, 8, 10, 12, 14, 16, 26, 28], radiusPercent: [24] } });

// ---------------------------------------------------------------------------
// Parsing

test("parseViewport reads WIDTHxHEIGHT and rejects anything else", () => {
  assert.deepEqual(parseViewport("1440x900"), { width: 1440, height: 900 });
  assert.deepEqual(parseViewport(" 390×844 "), { width: 390, height: 844 });
  assert.throws(() => parseViewport("wide"));
});

test("parseLength resolves px, rem and percentages, and returns null for keywords", () => {
  assert.equal(parseLength("12px"), 12);
  assert.equal(parseLength("0.625rem"), 10);
  assert.equal(parseLength("50%", 40), 20);
  assert.equal(parseLength("auto"), null);
  assert.equal(parseLength("normal"), null);
});

test("parseRadiusLadder reads px rungs, resolves var(), keeps percent rungs and skips calc", () => {
  const src = `
    borderRadius: {
      // a comment: 99px
      lg: "var(--radius)",
      md: "8px",
      field: "10px", /* inline */
      composer: "26px",
      logo: "24%",
      inherit: "inherit",
      inner: "max(0px, calc(var(--r-outer, 14px) - var(--pad, 6px)))",
      half: "0.375rem",
    },
    boxShadow: { raised: "var(--x)" },`;
  const ladder = parseRadiusLadder(src, { "--radius": "12px" });
  assert.ok(ladder);
  assert.deepEqual(ladder.px, [0, 6, 8, 10, 12, 26]);
  assert.deepEqual(ladder.percent, [24]);
  assert.deepEqual(ladder.names["12"], ["lg"]);
});

test("parseRadiusLadder reads the real tailwind.config.ts ladder", () => {
  const root = path.resolve(__dirname, "..");
  const tw = fs.readFileSync(path.join(root, "tailwind.config.ts"), "utf8");
  const vars = parseCssVars(fs.readFileSync(path.join(root, "src/app/globals.css"), "utf8"), ["--radius"]);
  const ladder = parseRadiusLadder(tw, vars);
  assert.ok(ladder, "tailwind.config.ts has a borderRadius block");
  // The ladder moves with the redesign; these rungs are the stable core.
  for (const rung of [0, 8, 12]) assert.ok(ladder.px.includes(rung), `rung ${rung} in ${ladder.px}`);
  assert.ok(ladder.px.every((v) => v >= 0 && v < 100));
});

test("parseCssVars takes the first declaration", () => {
  assert.deepEqual(parseCssVars(":root{--radius: 12px;} .dark{--radius: 9px;}", ["--radius", "--missing"]), { "--radius": "12px" });
});

test("normalizeRoutes accepts lists, comma strings and JSON, and de-duplicates names", () => {
  const a = normalizeRoutes("/chat, /projects\n# comment\n/library");
  assert.deepEqual(
    a.map((r: Rec) => r.path),
    ["/chat", "/projects", "/library"],
  );
  const b = normalizeRoutes(JSON.stringify([{ path: "/chat", name: "chat" }, { path: "/chat", name: "chat", open: [{ click: "x" }] }]));
  assert.deepEqual(
    b.map((r: Rec) => r.name),
    ["chat", "chat#2"],
  );
  assert.equal(b[1].slug, "chat-2");
  assert.deepEqual(b[0].open, []);
  assert.throws(() => normalizeRoutes(["chat"]));
  assert.equal(slugify("/"), "root");
  assert.equal(slugify("/settings · Account"), "settings-account");
});

// ---------------------------------------------------------------------------
// Scales

test("nearestRung and isOnScale honour the tolerance and prefer the lower rung on a tie", () => {
  assert.deepEqual(nearestRung(14, [12, 16]), { rung: 12, delta: 2 });
  assert.deepEqual(nearestRung(15, [12, 16]), { rung: 16, delta: -1 });
  assert.equal(isOnScale(16.4, [16], 0.5), true);
  assert.equal(isOnScale(16.6, [16], 0.5), false);
});

test("judgeValue: a padding passes when padding plus border lands on the scale", () => {
  const spacing = ctx.scales;
  assert.equal(judgeValue({ property: "padding", value: 7, border: 1 }, spacing).on, true);
  assert.equal(judgeValue({ property: "padding", value: 7, border: 0 }, spacing).on, false);
  assert.equal(judgeValue({ property: "padding", value: 14, border: 0 }, spacing).nearest, 12);
  assert.equal(judgeValue({ property: "radius", value: 18, full: true }, spacing).on, true);
  assert.equal(judgeValue({ property: "radius", value: 4.8, pct: 24 }, spacing).on, true, "24% logo rung");
  assert.equal(judgeValue({ property: "radius", value: 20, pct: 30 }, spacing).on, false);
  assert.equal(judgeValue({ property: "control-height", value: 34 }, spacing).on, false);
  assert.equal(judgeValue({ property: "font-size", value: 13 }, spacing).scored, false);
});

test("measuredValues de-duplicates per element and only scores radius on painted or clipping boxes", () => {
  const card = rec(0, -1, { pad: [16, 16, 16, 16], rad: [12, 12, 12, 12], paint: "b" });
  const vals = measuredValues(card, { ...ctx, flowChildren: [0] });
  assert.deepEqual(
    vals.map((v: Rec) => `${v.property}:${v.value}`),
    ["padding:16", "radius:12"],
  );
  const ghost = rec(0, -1, { rad: [12, 12, 12, 12] });
  assert.equal(measuredValues(ghost, ctx).length, 0);
  const pill = rec(0, -1, { w: 80, h: 32, rad: [9999, 9999, 9999, 9999], paint: "b", kind: "button", inter: true });
  const pv = measuredValues(pill, ctx);
  assert.ok(pv.some((v: Rec) => v.property === "radius" && v.full));
  assert.ok(pv.some((v: Rec) => v.property === "control-height" && v.value === 32));
});

// ---------------------------------------------------------------------------
// Radius maths

test("effectiveRadii scales oversized radii the way the browser does", () => {
  assert.deepEqual(effectiveRadii([9999, 9999, 9999, 9999], 36, 36), [18, 18, 18, 18]);
  assert.deepEqual(effectiveRadii([9999, 9999, 9999, 9999], 120, 32), [16, 16, 16, 16]);
  assert.deepEqual(effectiveRadii([12, 12, 0, 0], 100, 40), [12, 12, 0, 0]);
  assert.equal(isFullRadius(16, 120, 32), true);
  assert.equal(isFullRadius(12, 120, 32), false);
});

test("concentric rule: inner radius = outer radius - inset, never negative", () => {
  assert.equal(concentricExpected(12, 4), 8);
  assert.equal(concentricExpected(14, 6), 8);
  assert.equal(concentricExpected(8, 12), 0);
});

test("cornerPokeOut is zero for concentric corners and measures a square corner in a round one", () => {
  assert.equal(cornerPokeOut(12, 8, 4, 4), 0);
  assert.equal(cornerPokeOut(12, 12, 0, 0), 0);
  // A square child flush in a 12px corner: the corner point sits (√2 - 1)·12 outside the arc.
  assert.ok(Math.abs(cornerPokeOut(12, 0, 0, 0) - (Math.SQRT2 - 1) * 12) < 0.02);
  // A smaller radius, flush: pokes out, but less.
  const p = cornerPokeOut(12, 6, 0, 0);
  assert.ok(p > 0 && p < cornerPokeOut(12, 0, 0, 0));
  // Inset far enough, a sharp corner is inside the curve again.
  assert.equal(cornerPokeOut(12, 0, 4, 4), 0);
});

test("judgeCorner classifies too round, too sharp, poke-out, clipped corners and ignores far insets", () => {
  assert.equal(judgeCorner({ parentRadius: 12, childRadius: 8, dx: 4, dy: 4 }).verdict, "ok");
  assert.equal(judgeCorner({ parentRadius: 12, childRadius: 12, dx: 4, dy: 4 }).verdict, "too-round");
  assert.equal(judgeCorner({ parentRadius: 16, childRadius: 4, dx: 4, dy: 4 }).verdict, "too-sharp");
  assert.equal(judgeCorner({ parentRadius: 12, childRadius: 9, dx: 4, dy: 4 }).verdict, "ok", "within 2px");
  assert.equal(judgeCorner({ parentRadius: 12, childRadius: 4, dx: 0, dy: 0 }).verdict, "poke-out");
  assert.equal(judgeCorner({ parentRadius: 12, childRadius: 0, dx: 0, dy: 0, parentClips: true }).verdict, "ok", "flush media in a clipping card");
  assert.equal(judgeCorner({ parentRadius: 12, childRadius: 0, dx: 1, dy: 1, parentClips: true }).verdict, "clipped-corner");
  assert.equal(judgeCorner({ parentRadius: 12, childRadius: 4, dx: 16, dy: 16 }).applicable, false);
  assert.equal(judgeCorner({ parentRadius: 16, childRadius: 16, dx: 4, dy: 4, circle: true }).verdict, "ok", "avatars are exempt");
});

test("cornerInsets measures each corner against the parent box", () => {
  const ins = cornerInsets({ x: 4, y: 6, w: 92, h: 40 }, { x: 0, y: 0, w: 100, h: 50 });
  assert.deepEqual(ins, [
    { dx: 4, dy: 6 },
    { dx: 4, dy: 6 },
    { dx: 4, dy: 4 },
    { dx: 4, dy: 4 },
  ]);
});

// ---------------------------------------------------------------------------
// Statistics

test("histogram sorts numbers and counts duplicates", () => {
  assert.deepEqual(histogram([8, 16, 8, 4, 8.004, null]), [
    [4, 1],
    [8, 3],
    [16, 1],
  ]);
});

test("clusterValues links neighbours within the gap and modeOf breaks ties low", () => {
  const values = [100, 102, 140, 101, 116];
  const clusters = clusterValues(values, 3);
  assert.deepEqual(
    clusters.map((c: number[]) => c.map((k) => values[k])),
    [[100, 101, 102], [116], [140]],
  );
  assert.equal(modeOf([16, 16, 18, 18]), 16);
  assert.equal(modeOf([16, 18, 18]), 18);
});

test("spacingExceptionOk passes isolated small targets and fails crowded ones", () => {
  const a = { x: 0, y: 0, w: 16, h: 16 };
  assert.equal(spacingExceptionOk(a, [{ x: 100, y: 0, w: 16, h: 16 }], 24), true);
  assert.equal(spacingExceptionOk(a, [{ x: 18, y: 0, w: 16, h: 16 }], 24), false);
  assert.equal(spacingExceptionOk(a, [{ x: 0, y: 19, w: 40, h: 40 }], 24), false, "a big neighbour inside the 12px circle");
});

// ---------------------------------------------------------------------------
// Checks on synthetic pages

/** A 14px menu with 6px padding holding three 8px rows; row 2 is too round and row 3 has its own padding. */
function menuPage(): Rec[] {
  return [
    rec(0, -1, { role: "menu", x: 0, y: 0, w: 200, h: 114, pad: [6, 6, 6, 6], rad: [14, 14, 14, 14], paint: "bs", bg: "white", disp: "flex", fd: "column" }),
    rec(1, 0, { role: "menuitem", kind: "menuitem", inter: true, comp: "MenuItem", x: 6, y: 6, w: 188, h: 32, pad: [6, 8, 6, 8], rad: [8, 8, 8, 8], paint: "b", bg: "grey", txt: true, tl: 14, tr: 60, ta: "start", text: "Copy" }),
    rec(2, 0, { role: "menuitem", kind: "menuitem", inter: true, comp: "MenuItem", x: 6, y: 38, w: 188, h: 32, pad: [6, 8, 6, 8], rad: [12, 12, 12, 12], paint: "b", bg: "grey", txt: true, tl: 14, tr: 60, ta: "start", text: "Paste" }),
    rec(3, 0, { role: "menuitem", kind: "menuitem", inter: true, comp: "MenuItem", x: 6, y: 76, w: 188, h: 32, pad: [6, 10, 6, 10], rad: [8, 8, 8, 8], paint: "b", bg: "grey", txt: true, tl: 16, tr: 60, ta: "start", text: "Delete" }),
  ];
}

test("checkNestedRadius flags only the menu row whose radius breaks the concentric rule", () => {
  const records = menuPage();
  // Rows 1 and 3 are not in the corner zone except the first and last; give row 2 a corner by making the menu tight.
  const { findings, checked } = checkNestedRadius(records, ctx);
  const kinds = findings.map((f: Rec) => `${f.el}:${f.kind}`);
  assert.ok(checked.has(1) && checked.has(3));
  assert.deepEqual(kinds, []); // row 2 sits mid-menu: its corners are outside the 14px curve zone (dy = 38)
  records[2].y = 6;
  records[1].y = 38;
  const again = checkNestedRadius(records, ctx).findings;
  assert.equal(again.length, 1);
  assert.equal(again[0].kind, "nested-radius");
  assert.equal(again[0].el, 2);
  assert.equal(again[0].values.expected, 8);
});

test("checkNestedRadius reports a square header poking out of a rounded, unclipped card", () => {
  const records = [
    rec(0, -1, { x: 0, y: 0, w: 300, h: 200, rad: [16, 16, 16, 16], paint: "r", bg: "white" }),
    rec(1, 0, { x: 0, y: 0, w: 300, h: 48, paint: "b", bg: "grey" }),
  ];
  const f = checkNestedRadius(records, ctx).findings;
  assert.equal(f.length, 1);
  assert.equal(f[0].kind, "corner-poke-out");
  records[0].clip = true;
  assert.equal(checkNestedRadius(records, ctx).findings.length, 0, "a clipping card draws the corner itself");
});

test("checkSiblingPadding flags the odd menu row out", () => {
  const records = menuPage();
  const tree = buildTree(records);
  const { findings } = checkSiblingPadding(records, tree, ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].el, 3);
  assert.equal(findings[0].magnitude, 2);
});

test("checkAlignment flags text edges 1-3 px apart in one column, not real indents", () => {
  const records = menuPage();
  const tree = buildTree(records);
  const { findings } = checkAlignment(records, tree, ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].el, 3);
  assert.equal(findings[0].values.offset, 2);
  records[3].tl = 30; // a deliberate 16px indent
  assert.equal(checkAlignment(records, buildTree(records), ctx).findings.length, 0);
});

test("checkAlignment treats a display heading pulled 2px left of its body as optical", () => {
  const records = [
    rec(0, -1, { w: 600, h: 200 }),
    rec(1, 0, { tag: "h1", y: 0, h: 48, txt: true, tl: 14, tr: 300, fs: 44, ta: "start" }),
    rec(2, 0, { tag: "p", y: 60, h: 20, txt: true, tl: 16, tr: 400, fs: 13, ta: "start" }),
  ];
  const r = checkAlignment(records, buildTree(records), ctx);
  assert.equal(r.findings.length, 0);
  assert.equal(r.notes.length, 1);
});

test("checkAsymmetry exempts optical trims beside icons and flags plain asymmetric buttons", () => {
  const records = [
    rec(0, -1, { w: 400, h: 60, disp: "flex" }),
    rec(1, 0, { tag: "button", kind: "button", inter: true, x: 0, y: 0, w: 80, h: 32, pad: [6, 12, 6, 8], txt: true, tl: 8, tr: 70 }),
    rec(2, 0, { tag: "button", kind: "button", inter: true, x: 100, y: 0, w: 80, h: 32, pad: [6, 12, 6, 8], ig: [8, null] }),
    rec(3, 2, { tag: "svg", icon: true, x: 108, y: 8, w: 16, h: 16 }),
    rec(4, 0, { tag: "button", kind: "button", inter: true, x: 200, y: 0, w: 80, h: 32, pad: [8, 12, 4, 12], txt: true, tl: 212, tr: 270 }),
  ];
  const tree = buildTree(records);
  const { findings, notes } = checkAsymmetry(records, tree, ctx);
  assert.deepEqual(
    findings.map((f: Rec) => `${f.el}:${f.values.axis}`),
    ["1:x", "4:y"],
  );
  assert.equal(notes.length, 1);
  assert.equal(notes[0].el, 2);
});

test("checkAsymmetry accepts extra padding that makes room for an overlaid input icon", () => {
  const records = [
    rec(0, -1, { w: 300, h: 40, pos: "relative" }),
    rec(1, 0, { tag: "svg", icon: true, pos: "absolute", x: 12, y: 12, w: 16, h: 16 }),
    rec(2, 0, { tag: "input", kind: "input", inter: true, x: 0, y: 0, w: 300, h: 40, pad: [8, 12, 8, 36], bw: [1, 1, 1, 1], paint: "rb" }),
  ];
  const { findings, notes } = checkAsymmetry(records, buildTree(records), ctx);
  assert.equal(findings.length, 0);
  assert.equal(notes[0].reason, "room for an overlaid icon");
});

test("checkRowHeights compares the outermost control boxes in one row", () => {
  const records = [
    rec(0, -1, { w: 800, h: 48, disp: "flex" }),
    // a search field: a painted shell around a borderless input
    rec(1, 0, { x: 0, y: 4, w: 300, h: 40, paint: "r", bw: [1, 1, 1, 1] }),
    rec(2, 1, { tag: "input", kind: "input", inter: true, x: 30, y: 5, w: 260, h: 38 }),
    rec(3, 0, { tag: "button", kind: "button", inter: true, x: 320, y: 8, w: 80, h: 32, pad: [6, 12, 6, 12], paint: "b" }),
    rec(4, 0, { tag: "button", kind: "button", inter: true, x: 420, y: 4, w: 80, h: 40, pad: [10, 12, 10, 12], paint: "b" }),
  ];
  const { findings } = checkRowHeights(records, buildTree(records), ctx);
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0].values.heights, [40, 32, 40]);
  assert.equal(findings[0].el, 3, "the 32px button is the odd one out");
});

test("checkIconGaps flags the member of a family with a different icon gap", () => {
  const records = [0, 1, 2, 3].map((k) => rec(k, -1, { tag: "a", kind: "link", comp: "NavItem", ig: [k === 2 ? 10 : 8, null] }));
  const { findings } = checkIconGaps(records, ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].el, 2);
  assert.equal(findings[0].values.common, 8);
});

test("checkTargets uses the hit-tested size, the spacing exception on desktop, and 44px on a phone", () => {
  const records = [
    rec(0, -1, { tag: "button", kind: "button", inter: true, x: 0, y: 0, w: 16, h: 16 }),
    rec(1, -1, { tag: "button", kind: "button", inter: true, x: 18, y: 0, w: 16, h: 16 }),
    rec(2, -1, { tag: "button", kind: "button", inter: true, x: 200, y: 0, w: 16, h: 16 }),
    rec(3, -1, { tag: "button", kind: "button", inter: true, x: 300, y: 0, w: 16, h: 16, tgt: [24, 24] }),
    rec(4, -1, { tag: "a", kind: "link", inter: true, inline: true, x: 400, y: 0, w: 30, h: 16 }),
  ];
  const desk = checkTargets(records, ctx);
  assert.deepEqual(
    desk.findings.map((f: Rec) => f.el),
    [0, 1],
  );
  assert.deepEqual(
    desk.notes.map((n: Rec) => n.el),
    [2],
  );
  const phone = checkTargets(records, makeContext({ viewport: { width: 390, height: 844 } }));
  assert.deepEqual(
    phone.findings.map((f: Rec) => f.el),
    [0, 1, 2, 3],
  );
});

test("a field's padding that makes room for an overlaid glyph is judged as the glyph-to-text gap", () => {
  const records = [
    rec(0, -1, { w: 300, h: 36, pos: "relative" }),
    rec(1, 0, { tag: "svg", icon: true, pos: "absolute", x: 12, y: 10, w: 16, h: 16 }),
    rec(2, 0, { tag: "input", kind: "input", inter: true, x: 0, y: 0, w: 300, h: 36, pad: [8, 12, 8, 35], bw: [1, 1, 1, 1], paint: "rb" }),
  ];
  assert.deepEqual(overlayIconEdges(records, buildTree(records), records[2]), { lead: 28, trail: null });
  const a = analyzeRoute(records, ctx);
  // pl 35 + border 1 puts the text at 36: 8px after the glyph's right edge (28). Not a 35px padding.
  assert.ok(!a.offScale.some((o: Rec) => o.property === "padding" && o.value === 35));
  assert.deepEqual(a.histograms["icon-text-gap"], [[8, 1]]);
});

test("a radius derived by the concentric rule counts as on scale even off the ladder", () => {
  // A 14px track with a 5px inset holds a 9px thumb: 14 - 5 = 9, the rounded-inner arithmetic.
  const records = [
    rec(0, -1, { role: "radiogroup", x: 0, y: 0, w: 200, h: 36, rad: [14, 14, 14, 14], paint: "r", bg: "white" }),
    rec(1, 0, { x: 5, y: 5, w: 60, h: 26, rad: [9, 9, 9, 9], paint: "bs", bg: "grey" }),
  ];
  const a = analyzeRoute(records, ctx);
  assert.equal(a.offScale.length, 0);
  assert.equal(a.counts.byKind["nested-radius"], 0);
  // The same 9px radius with no rounded parent is off the ladder.
  const lone = analyzeRoute([rec(0, -1, { w: 60, h: 26, rad: [9, 9, 9, 9], paint: "b" })], ctx);
  assert.deepEqual(
    lone.offScale.map((o: Rec) => `${o.property}:${o.value}`),
    ["radius:9"],
  );
});

test("textFlags marks every ancestor of text, so icon-only and labelled controls are different families", () => {
  const records = [rec(0, -1), rec(1, 0, { tag: "button" }), rec(2, 1, { tag: "span", txt: true }), rec(3, 0, { tag: "button" }), rec(4, 3, { tag: "svg", icon: true })];
  assert.deepEqual(textFlags(records), [true, true, true, false, false]);
});

// ---------------------------------------------------------------------------
// Route analysis, scoring, reports

test("analyzeRoute is deterministic and scores on-scale values and clean elements", () => {
  const records = menuPage();
  const a = analyzeRoute(records, ctx);
  const b = analyzeRoute(JSON.parse(JSON.stringify(records)), ctx);
  assert.deepEqual(a, b);
  assert.equal(a.elements, 4);
  assert.ok(a.histograms.padding.some(([v]) => v === 6));
  // padding 10 is on the spacing scale; radius 12 on the ladder; 32 control heights on scale.
  assert.equal(a.counts.scaleTotal, a.counts.scaleOn);
  assert.equal(a.counts.byKind["sibling-padding"], 1);
  assert.equal(a.counts.byKind["text-misalignment"], 1);
  assert.ok(a.score.score < 100 && a.score.score > 50);
  assert.equal(a.score.scaleShare, 100);
});

test("off-scale values are reported with their nearest rung and examples", () => {
  const records = [rec(0, -1, { pad: [14, 14, 14, 14], paint: "b", rad: [5, 5, 5, 5] })];
  const a = analyzeRoute(records, ctx);
  assert.deepEqual(
    a.offScale.map((o: Rec) => `${o.property}:${o.value}->${o.nearest}`),
    ["padding:14->12", "radius:5->4"],
  );
  assert.equal(a.score.scaleShare, 0);
  assert.equal(a.offScaleFindings.length, 2);
});

test("scoreFrom halves scale share and clean share", () => {
  assert.deepEqual(scoreFrom({ scaleTotal: 10, scaleOn: 8, checked: 20, flagged: 5 }), { score: 77.5, scaleShare: 80, cleanShare: 75 });
  assert.deepEqual(scoreFrom({ scaleTotal: 0, scaleOn: 0, checked: 0, flagged: 0 }), { score: 100, scaleShare: 100, cleanShare: 100 });
});

test("rankFindings puts severe, large violations first with a stable tie-break", () => {
  const ranked = rankFindings([
    { kind: "icon-gap", severity: 1, magnitude: 2, el: 5 },
    { kind: "target-size", severity: 3, magnitude: 10, el: 9 },
    { kind: "nested-radius", severity: 2, magnitude: 4, el: 1 },
    { kind: "asymmetric-padding", severity: 2, magnitude: 4, el: 0 },
  ]);
  assert.deepEqual(
    ranked.map((f: Rec) => f.el),
    [9, 0, 1, 5],
  );
  const offenders = pickOffenders({ findings: ranked, offScaleFindings: [{ kind: "off-scale", severity: 1, magnitude: 1, el: 9 }, { kind: "off-scale", severity: 1, magnitude: 1, el: 7 }] }, 10);
  assert.deepEqual(
    offenders.map((f: Rec) => f.el),
    [9, 0, 1, 5, 7],
  );
});

test("aggregateSite sums counts across routes and compareRuns reports deltas", () => {
  const one = analyzeRoute(menuPage(), ctx);
  const site = aggregateSite([
    { name: "a", analysis: one },
    { name: "b", analysis: one },
    { name: "c" },
  ]);
  assert.equal(site.routes, 3);
  assert.equal(site.failed, 1);
  assert.equal(site.elements, 8);
  assert.equal(site.byKind["sibling-padding"], 2);
  assert.equal(site.score, one.score.score);
  const before = { site: { score: 70 }, routes: [{ name: "a", score: { score: 70 }, counts: { violations: 4 } }] };
  const after = { site: { score: 80 }, routes: [{ name: "a", score: { score: 82.5 }, counts: { violations: 1 } }] };
  const cmp = compareRuns(before, after);
  assert.deepEqual(cmp.site, { before: 70, after: 80, delta: 10 });
  assert.equal(cmp.routes[0].delta, 12.5);
});

test("renderMarkdown produces the summary, histograms and per-route sections", () => {
  const a = analyzeRoute(menuPage(), ctx);
  const route = { name: "/menu", slug: "menu", path: "/menu", elements: a.elements, score: a.score, counts: a.counts, scale: a.scale, histograms: a.histograms, offScale: [], violations: a.findings.map((f: Rec) => ({ ...f, el: { i: f.el, tag: "div", path: "div", rect: [0, 0, 1, 1] }, related: [] })), offenders: [], screenshot: "shots/menu.png" };
  const run = {
    meta: { base: "http://localhost:3000", scheme: "light", viewport: { width: 1440, height: 900 }, phone: false, full: false, scales: ctx.scales, tolerances: DEFAULT_TOLERANCES },
    site: aggregateSite([{ name: "/menu", analysis: a }]),
    routes: [route],
  };
  const md = renderMarkdown(run);
  assert.match(md, /^# Geometry audit/);
  assert.match(md, /Site score/);
  assert.match(md, /\*\*Padding/);
  assert.match(md, /### \/menu/);
  assert.match(md, /Sibling padding: 1/);
  assert.match(histogramLine([[16, 3], [14, 1]], [16]), /`16` ×3 · `14\*` ×1/);
});
