import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_ERROR_TEXT,
  DEFAULT_TOLERANCES,
  aggregateSite,
  analyzeRoute,
  appliesAt,
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
  normalizeRecords,
  normalizeRoutes,
  overlayIconEdges,
  parseCssVars,
  parseLength,
  parseRadiusLadder,
  parseViewport,
  pickOffenders,
  rankFindings,
  rowItems,
  scoreFrom,
  slugify,
  spacingExceptionOk,
  textFlags,
} from "../scripts/design-audit/geometry-lib.mjs";
import { histogramLine, renderMarkdown } from "../scripts/design-audit/geometry-report.mjs";
import { groupOffenders, issueKey, issueSignature, scaleUsage } from "../scripts/design-audit/geometry-synthesis.mjs";

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
  // The rungs themselves move with the redesign: only the shape is pinned here.
  assert.equal(ladder.px[0], 0);
  assert.ok(ladder.px.length >= 4, `a ladder, not a value: ${ladder.px}`);
  assert.ok(ladder.px.every((v, k) => v >= 0 && v < 100 && (k === 0 || v > ladder.px[k - 1])));
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

test("routes and open steps marked when: phone or desktop apply only at that width, and bad values are refused", () => {
  const routes = normalizeRoutes([
    { path: "/chat", name: "row menu", open: [{ click: "button[aria-label='Open menu']", when: "phone" }, { hover: "[data-row]", when: "desktop" }, { click: "[data-row] button" }] },
    { path: "/chat", name: "shortcuts", when: "desktop" },
  ]);
  const steps = (phone: boolean) => routes[0].open.filter((s: Rec) => appliesAt(s, phone)).map((s: Rec) => s.click || s.hover);
  assert.deepEqual(steps(true), ["button[aria-label='Open menu']", "[data-row] button"]);
  assert.deepEqual(steps(false), ["[data-row]", "[data-row] button"]);
  assert.equal(appliesAt(routes[1], false), true);
  assert.equal(appliesAt(routes[1], true), false);
  assert.equal(appliesAt(routes[0], true), true);
  assert.throws(() => normalizeRoutes([{ path: "/chat", when: "tablet" }]), /"when" is "phone" or "desktop"/);
  assert.throws(() => normalizeRoutes([{ path: "/chat", open: [{ click: "x", when: "mobile" }] }]), /open step 1/);
});

test("the default error text catches the product's error boundaries and not-found screens, not real headings", () => {
  const re = new RegExp(DEFAULT_ERROR_TEXT, "i");
  for (const t of ["This conversation couldn’t load", "Chat couldn’t start", "Couldn’t open settings", "This document couldn’t be read", "This page isn’t here", "Something went wrong", "Failed to compile"]) assert.ok(re.test(t), t);
  for (const t of ["Projects", "Good evening, Sam", "Couldn’t be simpler: three ways to plan", "Library", "What isn’t here yet"]) assert.ok(!re.test(t), t);
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
  // ...unless that 1px is the parent's border: the clip is the padding box, so the child is flush with it.
  assert.equal(judgeCorner({ parentRadius: 10, childRadius: 0, dx: 1, dy: 1, parentClips: true, parentBorder: [1, 1] }).verdict, "ok");
  // Further in, the clip barely touches it, but a square corner 3px inside a 10px one is still too sharp.
  assert.equal(judgeCorner({ parentRadius: 10, childRadius: 0, dx: 3, dy: 3, parentClips: true, parentBorder: [1, 1] }).verdict, "too-sharp");
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

test("checkNestedRadius lets a pill (a switch, a capsule button, a slider track) sit in a corner rounder than concentric", () => {
  const records = [
    rec(0, -1, { role: "menu", x: 0, y: 0, w: 288, h: 328, rad: [18, 18, 18, 18], paint: "bs", bg: "white" }),
    rec(1, 0, { role: "switch", kind: "switch", inter: true, x: 243, y: 295, w: 28, h: 16, rad: [9999, 9999, 9999, 9999], paint: "b", bg: "black" }),
  ];
  assert.equal(checkNestedRadius(records, ctx).findings.length, 0);
  // A 36px-tall capsule button in the same spot is a capsule too: its ends are its own curve.
  records[1] = rec(1, 0, { tag: "button", kind: "button", x: 186, y: 280, w: 90, h: 36, rad: [9999, 9999, 9999, 9999], paint: "b", bg: "black" });
  assert.equal(checkNestedRadius(records, ctx).findings.length, 0);
  // The same button as a rounded rectangle (12 px corners) traces the menu's corner and is judged.
  records[1] = rec(1, 0, { tag: "button", kind: "button", x: 186, y: 280, w: 90, h: 36, rad: [12, 12, 12, 12], paint: "b", bg: "black" });
  assert.equal(checkNestedRadius(records, ctx).findings[0].kind, "nested-radius");
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

test("checkSiblingPadding flags the odd menu row out, by padding and by radius", () => {
  const records = menuPage();
  const tree = buildTree(records);
  const { findings } = checkSiblingPadding(records, tree, ctx);
  assert.deepEqual(
    findings.map((f: Rec) => `${f.kind}:${f.el}:${f.magnitude}`),
    ["sibling-padding:3:2", "sibling-radius:2:4"],
  );
  // Pills of different widths share the "full" shape.
  const pills = [rec(0, -1, { disp: "flex" }), ...[60, 90].map((w, k) => rec(k + 1, 0, { tag: "button", kind: "button", inter: true, x: k * 100, w, h: 32, pad: [6, 12, 6, 12], rad: [9999, 9999, 9999, 9999], paint: "b" }))];
  assert.equal(checkSiblingPadding(pills, buildTree(pills), ctx).findings.length, 0);
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

test("checkAsymmetry treats a leading favicon stack like an icon (optical trim)", () => {
  const records = [
    rec(0, -1, { w: 400, h: 40, disp: "flex" }),
    rec(1, 0, { tag: "button", kind: "button", inter: true, x: 0, y: 0, w: 145, h: 28, pad: [0, 10, 0, 4], paint: "r", disp: "inline-flex" }),
    rec(2, 1, { tag: "span", x: 4, y: 5, w: 42, h: 18, disp: "flex" }),
    rec(3, 2, { tag: "span", x: 4, y: 5, w: 18, h: 18, paint: "b", txt: true }),
    rec(4, 2, { tag: "span", x: 16, y: 5, w: 18, h: 18, paint: "b", txt: true }),
    rec(5, 1, { tag: "span", x: 52, y: 4, w: 51, h: 20, txt: true }),
  ];
  const { findings, notes } = checkAsymmetry(records, buildTree(records), ctx);
  assert.equal(findings.length, 0);
  assert.equal(notes[0].reason, "optical trim beside an icon");
});

test("checkAsymmetry accepts room for an eye toggle wrapped in a positioned div", () => {
  const records = [
    rec(0, -1, { x: 850, y: 495, w: 400, h: 48, pos: "relative" }),
    rec(1, 0, { tag: "input", kind: "input", inter: true, x: 850, y: 495, w: 400, h: 48, pad: [12, 44, 12, 14], bw: [1, 1, 1, 1], paint: "rb" }),
    rec(2, 0, { x: 1216, y: 495, w: 28, h: 48, pos: "absolute", disp: "flex" }),
    rec(3, 2, { tag: "button", kind: "button", inter: true, x: 1216, y: 505, w: 28, h: 28, pos: "relative" }),
    rec(4, 3, { tag: "svg", icon: true, x: 1222, y: 511, w: 16, h: 16 }),
  ];
  const tree = buildTree(records);
  const { findings, notes } = checkAsymmetry(records, tree, ctx);
  assert.equal(findings.length, 0);
  assert.equal(notes[0].reason, "room for an overlaid icon");
  assert.deepEqual(overlayIconEdges(records, tree, records[1]), { lead: null, trail: 1222 });
});

test("checkAsymmetry judges row links only when they paint", () => {
  const records = [
    rec(0, -1, { w: 260, h: 64, disp: "flex", fd: "column" }),
    rec(1, 0, { tag: "a", kind: "link", inter: true, x: 0, y: 0, w: 244, h: 32, pad: [6, 10, 6, 8], txt: true, tl: 8, tr: 120 }),
    rec(2, 0, { tag: "a", kind: "link", inter: true, x: 0, y: 32, w: 244, h: 32, pad: [6, 10, 6, 8], paint: "b", txt: true, tl: 8, tr: 120 }),
  ];
  const { findings } = checkAsymmetry(records, buildTree(records), ctx);
  assert.deepEqual(
    findings.map((f: Rec) => f.el),
    [2],
  );
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

test("checkRowHeights judges a control by the widest row it sits in, once", () => {
  // A composer bar: + (32), model chip (32), mic (32) and a 36px voice button;
  // the + and the voice button also share an inner wrapper on their own.
  const records = [
    rec(0, -1, { w: 700, h: 40, disp: "flex" }),
    rec(1, 0, { w: 700, h: 40, disp: "flex" }),
    rec(2, 1, { tag: "button", kind: "button", inter: true, x: 0, y: 4, w: 32, h: 32, paint: "b" }),
    rec(3, 1, { tag: "button", kind: "button", inter: true, x: 660, y: 2, w: 36, h: 36, paint: "b" }),
    rec(4, 0, { tag: "button", kind: "button", inter: true, x: 500, y: 4, w: 92, h: 32, paint: "b" }),
    rec(5, 0, { tag: "button", kind: "button", inter: true, x: 600, y: 4, w: 32, h: 32, paint: "b" }),
  ];
  const { findings } = checkRowHeights(records, buildTree(records), ctx);
  assert.deepEqual(
    findings.map((f: Rec) => f.el),
    [3],
  );
  // The + at the far left (500px from the cluster) is not judged against the voice button.
  assert.ok(!findings.some((f: Rec) => f.el === 2));
});

test("a painted toolbar holding a field and labelled buttons is not a field shell", () => {
  const records = [
    rec(0, -1, { w: 600, h: 48, disp: "flex", paint: "b" }),
    rec(1, 0, { tag: "input", kind: "input", inter: true, x: 8, y: 6, w: 300, h: 36, paint: "r", bw: [1, 1, 1, 1] }),
    rec(2, 0, { tag: "button", kind: "button", inter: true, x: 320, y: 8, w: 80, h: 32, paint: "b" }),
    rec(3, 2, { tag: "span", x: 330, y: 14, w: 40, h: 20, txt: true, tl: 330, tr: 370 }),
  ];
  const items = rowItems(records, buildTree(records), ctx).map((r: Rec) => r.i);
  assert.deepEqual(items, [1, 2]);
  assert.equal(checkRowHeights(records, buildTree(records), ctx).findings.length, 1);
});

test("checkIconGaps flags the member of a family with a different icon gap", () => {
  const records = [0, 1, 2, 3].map((k) => rec(k, -1, { tag: "a", kind: "link", comp: "NavItem", ig: [k === 2 ? 10 : 8, null] }));
  const { findings } = checkIconGaps(records, ctx);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].el, 2);
  assert.equal(findings[0].values.common, 8);
  // A chevron pushed to the far edge (space-between) is layout, not a gap.
  records.push(rec(4, -1, { tag: "a", kind: "link", comp: "NavItem", ig: [244, null] }));
  assert.equal(checkIconGaps(records, ctx).findings.length, 1);
  assert.ok(!measuredValues(records[4], ctx).some((m: Rec) => m.property === "icon-text-gap"));
});

test("checkIconGaps does not compare an avatar's gap with a glyph's", () => {
  // Five sidebar buttons with a 16 px glyph 6 px from the label, and the
  // account button with a 32 px avatar 10 px from the name: no family breach.
  const records: Rec[] = [];
  for (let k = 0; k < 5; k++) {
    records.push(rec(records.length, -1, { tag: "button", kind: "button", ig: [6, null], txt: true }));
    records.push(rec(records.length, records.length - 1, { tag: "svg", icon: true, w: 16, h: 16 }));
  }
  const account = records.length;
  records.push(rec(account, -1, { tag: "button", kind: "button", ig: [10, null], txt: true }));
  records.push(rec(account + 1, account, { tag: "span", w: 32, h: 32 }));
  records.push(rec(account + 2, account + 1, { tag: "svg", icon: true, w: 32, h: 32 }));
  assert.equal(checkIconGaps(records, ctx).findings.length, 0);
  // The same 10 px gap beside a 16 px glyph is a breach.
  records[account + 2] = { ...records[account + 2], w: 16, h: 16 };
  records[account + 1] = { ...records[account + 1], w: 16, h: 16 };
  const again = checkIconGaps(records, ctx).findings;
  assert.equal(again.length, 1);
  assert.equal(again[0].el, account);
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

test("checkTargets does not judge a field's label as a target of its own", () => {
  const phone = makeContext({ viewport: { width: 390, height: 844 } });
  const records = [
    rec(0, -1, { tag: "label", kind: "clickable", inter: true, x: 24, y: 300, w: 44, h: 16, txt: true, text: "Email" }),
    rec(1, -1, { tag: "input", kind: "input", inter: true, x: 24, y: 320, w: 342, h: 48 }),
    rec(2, -1, { tag: "a", kind: "link", inter: true, x: 200, y: 400, w: 130, h: 17, text: "Forgot your password?" }),
  ];
  const { findings, checked } = checkTargets(records, phone);
  assert.deepEqual(
    findings.map((f: Rec) => f.el),
    [2],
  );
  assert.ok(!checked.has(0));
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

test("library wrapper names give way to the product component, and wordmarks are not icons", () => {
  const records = [
    rec(0, -1, { tag: "button", comp: "Menu", comps: ["Menu", "UserMenu", "AppSidebar"] }),
    rec(1, -1, { tag: "svg", icon: true, w: 46, h: 14 }),
    rec(2, -1, { tag: "svg", icon: true, w: 15, h: 15 }),
  ];
  const [first] = normalizeRecords(records);
  assert.equal(first.comp, "UserMenu");
  // A citation chip inside a sentence is inline, not a control.
  const prose = [rec(0, -1, { tag: "p", txt: true }), rec(1, 0, { tag: "button", kind: "button", inter: true, disp: "inline-flex", h: 16.8 })];
  assert.equal(normalizeRecords(prose)[1].inline, true);
  // ...also when it is wrapped in a span or two inside the paragraph.
  const wrapped = [rec(0, -1, { tag: "p", txt: true }), rec(1, 0, { tag: "span", disp: "inline" }), rec(2, 1, { tag: "a", kind: "link", inter: true, disp: "inline-flex" })];
  assert.equal(normalizeRecords(wrapped)[2].inline, true);
  const toolbar = [rec(0, -1, { tag: "div", disp: "flex" }), rec(1, 0, { tag: "button", kind: "button", inter: true, disp: "inline-flex" })];
  assert.equal(normalizeRecords(toolbar)[1].inline, undefined);
  assert.equal(analyzeRoute(prose, ctx).histograms["control-height"], undefined);
  assert.equal(records[0].comp, "Menu", "input untouched");
  const a = analyzeRoute(records, ctx);
  assert.deepEqual(a.histograms["icon-size"], [[15, 1]]);
});

test("textFlags marks every ancestor of text, so icon-only and labelled controls are different families", () => {
  const records = [rec(0, -1), rec(1, 0, { tag: "button" }), rec(2, 1, { tag: "span", txt: true }), rec(3, 0, { tag: "button" }), rec(4, 3, { tag: "svg", icon: true })];
  assert.deepEqual(textFlags(records), [true, true, true, false, false]);
});

test("checkRowHeights treats a small icon-only accessory beside a wide row as a note, not a peer", () => {
  const records = [
    rec(0, -1, { w: 240, h: 32, disp: "flex" }),
    rec(1, 0, { tag: "a", kind: "link", inter: true, x: 0, y: 0, w: 200, h: 32, pad: [6, 8, 6, 8], paint: "b" }),
    rec(2, 1, { tag: "span", x: 8, y: 6, w: 120, h: 20, txt: true, tl: 8, tr: 128 }),
    rec(3, 0, { tag: "button", kind: "button", inter: true, x: 210, y: 6, w: 20, h: 20 }),
    rec(4, 3, { tag: "svg", icon: true, x: 212, y: 8, w: 16, h: 16 }),
  ];
  const r = checkRowHeights(records, buildTree(records), ctx);
  assert.equal(r.findings.length, 0);
  assert.equal(r.notes.length, 1);
  assert.equal(r.notes[0].el, 3);
});

test("pickOffenders keeps one of many identical findings on look-alike elements", () => {
  const records = [0, 1, 2].map((k) => rec(k, -1, { tag: "a", comp: "Row" }));
  const findings = records.map((r) => ({ kind: "asymmetric-padding", severity: 1, magnitude: 2, message: "link padding left 8 / right 10", el: r.i }));
  assert.equal(pickOffenders({ findings, offScaleFindings: [] }, 10, records).length, 1);
  assert.equal(pickOffenders({ findings, offScaleFindings: [] }, 10).length, 3);
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
  assert.equal(a.counts.byKind["sibling-radius"], 1);
  assert.equal(a.counts.byKind["text-misalignment"], 1);
  assert.ok(a.score.score < 100 && a.score.score > 50);
  assert.equal(a.score.scaleShare, 100);
});

test("loading placeholders (busy records) are left out of the values and the checks", () => {
  const records = menuPage();
  const loaded = analyzeRoute(records, ctx);
  // The same page with its odd menu rows still drawn as skeletons.
  const flagged = new Set(loaded.findings.map((f: Rec) => f.el));
  const busy = records.map((r: Rec) => (flagged.has(r.i) ? { ...r, busy: true, pad: [7, 7, 7, 7] } : r));
  const a = analyzeRoute(busy, ctx);
  assert.equal(a.counts.violations, 0);
  assert.ok(flagged.size > 0);
  assert.ok(a.counts.scaleTotal < loaded.counts.scaleTotal);
  assert.ok(a.counts.checked < loaded.counts.checked);
  assert.ok(!a.histograms.padding.some(([v]: [number]) => v === 7));
  assert.ok(a.offScale.every((o: Rec) => o.value !== 7));
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
  assert.match(histogramLine([[16, 3], [14, 1]], new Set([14])), /`16` ×3 · `14\*` ×1/);
  assert.match(histogramLine([[8, 2], ["full", 5]]), /`full` ×5 · `8` ×2/);
});

// ---------------------------------------------------------------------------
// Synthesis across runs

test("scaleUsage splits the values covering 90% of uses from the long tail", () => {
  const u = scaleUsage([
    [8, 50],
    [16, 30],
    [12, 12],
    [14, 5],
    [18, 2],
    [7.2, 1],
  ]);
  assert.equal(u.total, 100);
  assert.equal(u.distinct, 6);
  assert.deepEqual(
    u.head.map(([v]: [number, number]) => v),
    [8, 16, 12],
  );
  assert.deepEqual(
    u.tail.map(([v]: [number, number]) => v),
    [14, 18, 7.2],
  );
  assert.equal(u.tailUses, 8);
  assert.equal(u.once, 1);
});

test("issue signatures drop page coordinates so one component's problem groups across pages", () => {
  const near = { kind: "text-misalignment", severity: 1, magnitude: 2, message: "text starts +2 px from the edge its column shares (316)", values: {} };
  const near2 = { ...near, message: "text starts +2 px from the edge its column shares (40)" };
  assert.equal(issueSignature(near), issueSignature(near2));
  const off = { kind: "off-scale", severity: 1, magnitude: 2, message: "", values: { property: "padding", value: 14, nearest: 12 } };
  assert.equal(issueSignature(off), "padding 14 → 12");
  const target = { kind: "target-size", severity: 3, magnitude: 18, message: "separator target 6×900 under the 24 px pointer minimum", values: { w: 6, h: 900, min: 24 } };
  assert.equal(issueSignature(target), "target 6 px on its short side, under the 24 px pointer minimum");
  const ref = { i: 1, tag: "div", path: "aside > div", rect: [0, 0, 6, 900], role: "separator", comp: "AppShell" };
  assert.equal(issueKey(target, ref), "target-size|AppShell|div|separator|target 6 px on its short side, under the 24 px pointer minimum");
  // Segments of one control differ in width with their labels, not in the problem.
  const seg = (w: number) => ({ kind: "target-size", severity: 2, magnitude: 10, message: `button target ${w}×34 under the 44 px touch minimum`, values: { w, h: 34, min: 44 } });
  assert.equal(issueSignature(seg(82.38)), issueSignature(seg(36)));
});

test("groupOffenders counts a problem once per page, light and dark at one width being one page, and ranks by badness x pages", () => {
  const ref = (path: string, comp = "SidebarRow") => ({ i: 0, tag: "a", path, rect: [0, 0, 200, 32], comp });
  const pad = { kind: "off-scale", severity: 1, magnitude: 2, message: "padding 14 is off scale (nearest 12)", values: { property: "padding", value: 14, nearest: 12 }, related: [] };
  const handle = { kind: "target-size", severity: 3, magnitude: 18, message: "separator target 6×900 under the 24 px pointer minimum", values: { w: 6, h: 900, min: 24 }, related: [] };
  const origin = (order: number) => ({ order, run: {}, route: {} });
  const items = [
    // the row padding on three pages, twice on one page (two rows), and again in the dark run
    { page: "/chat @ 1440x900", finding: pad, ref: ref("nav > a:nth-of-type(1)"), related: [], origin: origin(1) },
    { page: "/chat @ 1440x900", finding: pad, ref: ref("nav > a:nth-of-type(2)"), related: [], origin: origin(2) },
    { page: "/chat @ 1440x900", finding: pad, ref: ref("nav > a:nth-of-type(1)"), related: [], origin: origin(1001) },
    { page: "/projects @ 1440x900", finding: pad, ref: ref("nav > a:nth-of-type(1)"), related: [], origin: origin(3) },
    { page: "/chat @ 390x844", finding: pad, ref: ref("nav > a:nth-of-type(1)"), related: [], origin: origin(2001) },
    // the resize handle on one page
    { page: "/chat @ 1440x900", finding: handle, ref: { ...ref("aside > div", "AppShell"), role: "separator" }, related: [], origin: origin(4) },
  ];
  const groups = groupOffenders(items);
  assert.equal(groups.length, 2);
  const [first, second] = groups;
  assert.equal(first.kind, "target-size");
  assert.equal(first.impact, 27.5);
  assert.equal(second.kind, "off-scale");
  assert.deepEqual(second.pages, ["/chat @ 1440x900", "/chat @ 390x844", "/projects @ 1440x900"]);
  assert.equal(second.elements, 4);
  assert.equal(second.impact, 4.5);
  assert.equal(second.example.origin.order, 1);
});
