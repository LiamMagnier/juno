import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { axeSourcePath, summarizeAxe, type AxeViolation } from "../e2e/support/axe";
import { composite, contrastRatio, parseCssColor, relativeLuminance, requiredTextContrast } from "../e2e/support/contrast";
import { compareShapeMasks, cvdFilterSvg, CVD_MATRICES, simulateColor, simulateCvd } from "../e2e/support/cvd";
import { matrixRoutes, readQaFixtures, routeRenderProblem } from "../e2e/support/fixtures";
import { heapRatio, readHeapBaseline, writeHeapBaseline } from "../e2e/support/heap";
import { summarizeShifts } from "../e2e/support/layout-shift";
import { evaluateParity, parityMismatches, readGeometryRecords, readNativeGeometry, type GeometryRecord } from "../e2e/support/parity";
import { gapBetween, percentile, summarize } from "../e2e/support/perf-marks";
import { decodePng, diffBitmaps, encodePng, solidBitmap, type Bitmap } from "../e2e/support/png";
import { matrixVariants, variantUse } from "../e2e/support/screenshot-matrix";

/*
 * P0's e2e support library (spec appendix P0 (4)): the pure parts of the
 * perf-mark reader, PNG codec, CVD filters and shape-mask comparator, the
 * contrast reader, parity, layout shifts, heap baselines, the screenshot
 * matrix's variants and the seeded fixture routes. The page-facing halves run
 * in e2e/wave2/p0-harness.
 */

test("percentile and summarize match the linear-interpolation definition", () => {
  const samples = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(percentile(samples, 50), 10.5);
  assert.ok(Math.abs(percentile(samples, 95) - 19.05) < 1e-9);
  assert.equal(percentile([7], 95), 7);
  assert.equal(percentile([3, 1, 2], 0), 1);
  assert.equal(percentile([3, 1, 2], 100), 3);
  assert.throws(() => percentile([], 50), /no samples/);
  assert.throws(() => percentile([1, Number.NaN], 50), /finite/);
  assert.throws(() => percentile([1], 101), /0–100/);
  const s = summarize([10, 20, 30, 40]);
  assert.deepEqual({ n: s.n, min: s.min, max: s.max, mean: s.mean, p50: s.p50 }, { n: 4, min: 10, max: 40, mean: 25, p50: 25 });
});

test("gapBetween pairs the last start with the first end after it", () => {
  const marks = [
    { name: "alevr:enter", startTime: 100 },
    { name: "alevr:bubble-painted", startTime: 150 },
    { name: "alevr:enter", startTime: 1000 },
    { name: "alevr:bubble-painted", startTime: 1042 },
  ];
  assert.equal(gapBetween(marks, "alevr:enter", "alevr:bubble-painted"), 42);
  assert.equal(gapBetween(marks, "alevr:enter", "alevr:status-visible"), null);
  assert.equal(gapBetween([], "a", "b"), null);
});

test("PNG encode and decode round-trip, and the diff counts changed pixels", () => {
  const bitmap = solidBitmap(5, 3, [10, 20, 30, 255]);
  bitmap.data.set([200, 0, 0, 255], (1 * 5 + 2) * 4);
  const decoded = decodePng(encodePng(bitmap));
  assert.equal(decoded.width, 5);
  assert.equal(decoded.height, 3);
  assert.deepEqual([...decoded.data], [...bitmap.data]);
  const changed = { ...decoded, data: new Uint8Array(decoded.data) };
  changed.data.set([10, 20, 30, 255], (1 * 5 + 2) * 4);
  assert.deepEqual(diffBitmaps(decoded, changed), { differing: 1, total: 15, ratio: 1 / 15, sameSize: true });
  assert.equal(diffBitmaps(decoded, solidBitmap(4, 3, [0, 0, 0, 255])).sameSize, false);
  assert.throws(() => decodePng(Buffer.from("not a png")), /Not a PNG/);
});

/** Draws a glyph from a string mask ('#' ink, '.' background). */
function glyph(rows: string[], ink: [number, number, number], scale = 4): Bitmap {
  const height = rows.length * scale;
  const width = rows[0].length * scale;
  const bitmap = solidBitmap(width, height, [255, 255, 255, 255]);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (rows[Math.floor(y / scale)][Math.floor(x / scale)] === "#") bitmap.data.set([...ink, 255], (y * width + x) * 4);
    }
  }
  return bitmap;
}

const HAND = [
  "..........",
  "..#.#.#...",
  "..#.#.#.#.",
  "..#.#.#.#.",
  ".########.",
  "##.######.",
  ".#.######.",
  "...######.",
  "....####..",
  "..........",
];
const CIRCLE_X = [
  "...####...",
  ".##....##.",
  ".#.#..#.#.",
  "#...##...#",
  "#...##...#",
  ".#.#..#.#.",
  ".##....##.",
  "...####...",
  "..........",
  "..........",
];
const SIGNAL: [number, number, number] = [0xd3, 0x63, 0x17];
const DESTRUCTIVE: [number, number, number] = [0xb8, 0x1e, 0x28];

test("the shape-mask comparator tells a hand from a circle-x under both CVD filters, and not a shape from itself", () => {
  const hand = glyph(HAND, SIGNAL);
  const cross = glyph(CIRCLE_X, DESTRUCTIVE);
  for (const kind of ["deuteranopia", "protanopia"] as const) {
    const different = compareShapeMasks(simulateCvd(hand, kind), simulateCvd(cross, kind));
    assert.equal(different.distinguishable, true, `${kind}: ${different.detail}`);
    const same = compareShapeMasks(simulateCvd(hand, kind), simulateCvd(glyph(HAND, DESTRUCTIVE), kind));
    assert.equal(same.distinguishable, false, `${kind}: the same shape in another ink is the same shape (${same.detail})`);
    assert.ok(same.iou > 0.95);
  }
  const blank = solidBitmap(40, 40, [255, 255, 255, 255]);
  const none = compareShapeMasks(blank, cross);
  assert.equal(none.distinguishable, false);
  assert.match(none.detail, /rendered no ink/);
});

test("the shape mask ignores scale: the same glyph drawn larger is the same shape", () => {
  const small = glyph(CIRCLE_X, DESTRUCTIVE, 3);
  const large = glyph(CIRCLE_X, DESTRUCTIVE, 6);
  assert.ok(compareShapeMasks(small, large).iou > 0.85);
});

test("CVD simulation follows Machado 2009 and keeps greys grey", () => {
  for (const kind of Object.keys(CVD_MATRICES) as (keyof typeof CVD_MATRICES)[]) {
    const m = CVD_MATRICES[kind];
    for (let row = 0; row < 3; row += 1) {
      const sum = m[row * 3] + m[row * 3 + 1] + m[row * 3 + 2];
      assert.ok(Math.abs(sum - 1) < 0.002, `${kind} row ${row} preserves white (${sum})`);
    }
    assert.deepEqual(simulateColor([128, 128, 128], kind), [128, 128, 128]);
  }
  // Under deuteranopia, red and green collapse toward each other.
  const red = simulateColor([255, 0, 0], "deuteranopia");
  const green = simulateColor([0, 255, 0], "deuteranopia");
  assert.ok(Math.abs(red[0] - green[0]) < 120, `${red} vs ${green}`);
  const svg = cvdFilterSvg();
  assert.match(svg, /id="alevr-cvd-deuteranopia" color-interpolation-filters="linearRGB"/);
  assert.match(svg, /id="alevr-cvd-protanopia"/);
});

test("contrast maths reproduces the spec's §3.1 numbers", () => {
  const hex = (h: string) => parseCssColor(h)!;
  const ratio = (a: string, b: string) => Math.round(contrastRatio(hex(a), hex(b)) * 100) / 100;
  assert.equal(ratio("#686B70", "#E6E7E9"), 4.32, "the recorded failing muted-on-selected pair");
  assert.equal(ratio("#5F6267", "#E6E7E9"), 4.95, "muted-on-fill on selected");
  assert.equal(Math.round(contrastRatio(hex("#191B1E"), hex("#FFFFFF")) * 10) / 10, 17.3);
  assert.equal(ratio("#B81E28", "#FFFFFF"), 6.45);
  assert.equal(ratio("#B65116", "#FFFFFF"), 5.03);
  assert.equal(relativeLuminance([255, 255, 255]), 1);
  assert.deepEqual(parseCssColor("rgb(1, 2, 3)"), [1, 2, 3, 1]);
  assert.deepEqual(parseCssColor("rgba(1, 2, 3, 0.5)"), [1, 2, 3, 0.5]);
  assert.deepEqual(parseCssColor("rgb(1 2 3 / 50%)"), [1, 2, 3, 0.5]);
  assert.deepEqual(parseCssColor("color(srgb 1 0 0)"), [255, 0, 0, 1]);
  assert.deepEqual(parseCssColor("#fff"), [255, 255, 255, 1]);
  assert.deepEqual(parseCssColor("transparent"), [0, 0, 0, 0]);
  assert.equal(parseCssColor("oklch(0.5 0.1 200)"), null);
  assert.deepEqual(composite([0, 0, 0, 0.5], [255, 255, 255, 1]), [127.5, 127.5, 127.5, 1]);
  assert.equal(requiredTextContrast(16, 400), 4.5);
  assert.equal(requiredTextContrast(24, 400), 3);
  assert.equal(requiredTextContrast(18.66, 700), 3);
  assert.equal(requiredTextContrast(18.66, 600), 4.5);
});

const CONFORMING: GeometryRecord = {
  context: "web-chat",
  platform: "web",
  bubble: { radii: { startStart: 12, startEnd: 12, endEnd: 8, endStart: 12 }, fill: "rgb(239, 240, 241)", tokenFill: "rgb(239, 240, 241)" },
  composer: { radius: 22 },
  disc: { radius: 12, size: 36 },
};

test("parity accepts the spec geometry and names every deviation", () => {
  assert.deepEqual(parityMismatches(CONFORMING), []);
  assert.equal(evaluateParity([CONFORMING]).pass, true);
  const today: GeometryRecord = {
    ...CONFORMING,
    context: "web-code",
    bubble: { radii: { startStart: 18, startEnd: 18, endEnd: 18, endStart: 18 }, fill: "rgb(1, 1, 1)", tokenFill: "rgb(239, 240, 241)" },
    composer: { radius: 24 },
  };
  const mismatches = parityMismatches(today);
  assert.ok(mismatches.some((m) => m.includes("bubble endEnd radius 18 (expected 8)")));
  assert.ok(mismatches.some((m) => m.includes("not the user-bubble token")));
  assert.ok(mismatches.some((m) => m.includes("composer radius 24 (expected 22)")));
  assert.equal(evaluateParity([CONFORMING, today]).pass, false);
  assert.equal(evaluateParity([]).pass, false, "nothing measured is not a pass");
  assert.deepEqual(parityMismatches({ context: "empty", platform: "ios" }), ["empty: no bubble found", "empty: no composer found", "empty: no disc found"]);
});

test("native geometry exports are read; malformed ones are refused", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "alevr-qa-geometry-"));
  try {
    assert.deepEqual(readNativeGeometry(path.join(dir, "missing")), []);
    writeFileSync(path.join(dir, "macos-chat.json"), JSON.stringify({ ...CONFORMING, context: "macos-chat", platform: "macos" }));
    writeFileSync(path.join(dir, "web-chat.json"), JSON.stringify(CONFORMING));
    assert.equal(readGeometryRecords(dir).length, 2);
    assert.throws(() => readNativeGeometry(dir), /not a native geometry export/);
    rmSync(path.join(dir, "web-chat.json"));
    assert.equal(readNativeGeometry(dir)[0].context, "macos-chat");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("layout shifts in the region are summed separately from the page", () => {
  const reading = summarizeShifts(true, [
    { value: 0.01, inRegion: false, at: 10 },
    { value: 0.02, inRegion: true, at: 20 },
    { value: 0.03, inRegion: true, at: 30 },
  ]);
  assert.ok(Math.abs(reading.total - 0.06) < 1e-12);
  assert.ok(Math.abs(reading.region - 0.05) < 1e-12);
  assert.equal(summarizeShifts(false, []).supported, false);
});

test("heap baselines round-trip and the ratio is measured over baseline", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "alevr-qa-heap-"));
  try {
    const file = path.join(dir, "nested", "heap.json");
    assert.equal(readHeapBaseline(file), null);
    const baseline = writeHeapBaseline(file, { usedBytes: 100_000_000, totalBytes: 150_000_000 }, { note: "test" });
    assert.equal(readHeapBaseline(file)?.usedBytes, 100_000_000);
    assert.equal(heapRatio({ usedBytes: 110_000_000, totalBytes: 0 }, baseline), 1.1);
    writeFileSync(file, JSON.stringify({ usedBytes: 0 }));
    assert.throws(() => readHeapBaseline(file), /no positive usedBytes/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the screenshot matrix is light, dark and high contrast × motion on and off", () => {
  const variants = matrixVariants();
  assert.equal(variants.length, 6);
  assert.deepEqual(variants.map((v) => v.key), ["light-full", "light-reduced", "dark-full", "dark-reduced", "high-contrast-full", "high-contrast-reduced"]);
  assert.deepEqual(variantUse({ theme: "high-contrast", motion: "reduced" }), {
    colorScheme: "light",
    reducedMotion: "reduce",
    contrast: "more",
    forcedColors: "none",
  });
  assert.equal(variantUse({ theme: "forced-colors", motion: "full" }).forcedColors, "active");
  assert.equal(variantUse({ theme: "high-contrast-dark", motion: "full" }).colorScheme, "dark");
  assert.equal(matrixVariants({ themes: ["light", "dark"], motions: ["full"] }).length, 2);
});

test("fixture ids come from the run directory, and missing fixtures skip their routes", () => {
  assert.deepEqual(readQaFixtures(undefined), { qaThreadId: null, qaCodeSessionId: null, researchRunId: null });
  const dir = mkdtempSync(path.join(tmpdir(), "alevr-qa-fixtures-"));
  try {
    writeFileSync(path.join(dir, "fixtures.json"), JSON.stringify({ qaThreadId: "t1", qaCodeSessionId: "c1", researchRunId: 5 }));
    const fixtures = readQaFixtures(dir);
    assert.deepEqual(fixtures, { qaThreadId: "t1", qaCodeSessionId: "c1", researchRunId: null });
    const routes = matrixRoutes(fixtures);
    assert.deepEqual(
      routes.map((r) => r.name),
      ["chat-home", "chat-thread", "code-home", "code-session", "library", "research-run", "automations", "settings", "sign-in", "not-found"]
    );
    assert.equal(routes.find((r) => r.name === "chat-thread")?.path, "/chat/t1");
    assert.equal(routes.find((r) => r.name === "research-run")?.path, null);
    assert.equal(routes.find((r) => r.name === "sign-in")?.anonymous, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("axe counts only serious and critical violations, and its source is the installed axe-core", () => {
  const v = (id: string, impact: AxeViolation["impact"], nodes = 1): AxeViolation => ({
    id,
    impact,
    help: id,
    helpUrl: "",
    nodes: Array.from({ length: nodes }, () => ({ target: ["#x"], html: "<b></b>" })),
  });
  const report = summarizeAxe("/chat", [v("color-contrast", "serious", 3), v("region", "moderate"), v("aria-valid-attr", "critical"), v("x", null)]);
  assert.deepEqual(report.blocking.map((b) => b.id), ["color-contrast", "aria-valid-attr"]);
  assert.equal(report.blockingNodes, 4);
  assert.match(axeSourcePath(), /axe-core[\\/]axe\.min\.js$/);
});

test("a gate route must land where it was asked: no sign-in redirect, no error page, 404 only for the 404 route", () => {
  const base = "http://127.0.0.1:4000";
  assert.equal(routeRenderProblem({ requested: "/library", finalUrl: `${base}/library`, status: 200 }), null);
  assert.equal(routeRenderProblem({ requested: "/settings", finalUrl: `${base}/settings/general`, status: 200 }), null);
  assert.match(
    routeRenderProblem({ requested: "/library", finalUrl: `${base}/sign-in?callbackUrl=%2Flibrary`, status: 200 }) ?? "",
    /redirected to \/sign-in/
  );
  assert.equal(routeRenderProblem({ requested: "/sign-in", finalUrl: `${base}/sign-in`, status: 200, anonymous: true }), null);
  assert.match(routeRenderProblem({ requested: "/code", finalUrl: `${base}/code`, status: 500 }) ?? "", /answered 500/);
  assert.match(routeRenderProblem({ requested: "/code", finalUrl: `${base}/code`, status: 0 }) ?? "", /no response/);
  assert.equal(routeRenderProblem({ requested: "/nope", finalUrl: `${base}/nope`, status: 404, notFound: true }), null);
  assert.match(routeRenderProblem({ requested: "/nope", finalUrl: `${base}/nope`, status: 200, notFound: true }) ?? "", /not the 404 page/);
  assert.equal(matrixRoutes({ qaThreadId: null, qaCodeSessionId: null, researchRunId: null }).find((r) => r.name === "not-found")?.notFound, true);
});
