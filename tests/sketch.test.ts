import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EXPORT_LONG_EDGE,
  EXPORT_MAX_PIXELS,
  canRedo,
  canUndo,
  commit,
  constrainShape,
  createHistory,
  erasedBy,
  exportSize,
  fitPaper,
  hitsInk,
  inkRadius,
  inkSamples,
  isDegenerateShape,
  isSketchFileName,
  objectBounds,
  outlineToPath,
  paperForRoom,
  pickObject,
  redo,
  sketchFileName,
  sketchGuideForGeneration,
  sketchGuidePrompt,
  strokeOutline,
  translateObject,
  undo,
  HISTORY_LIMIT,
  type InkPoint,
  type ShapeObject,
  type SketchObject,
  type StrokeObject,
  type TextObject,
} from "@/lib/sketch/sketch-core";

const line = (n: number, dx = 4, p = 0.5): InkPoint[] => Array.from({ length: n }, (_, i) => [10 + i * dx, 20, p] as InkPoint);

/* ——— ink ——— */

test("streamline keeps the ends where the pen went down and lifted", () => {
  const pts: InkPoint[] = [[0, 0, 0.5], [10, 10, 0.5], [20, 0, 0.5], [30, 10, 0.5]];
  const s = inkSamples(pts, { size: 8, streamline: 0.6 });
  assert.deepEqual([s[0].x, s[0].y], [0, 0]);
  assert.deepEqual([s.at(-1)!.x, s.at(-1)!.y], [30, 10]);
  // Interior points are pulled toward the previous one (smoothing), not copied.
  assert.ok(s[1].x < 10 && s[1].y < 10);
});

test("near-duplicate samples are dropped", () => {
  const pts: InkPoint[] = [[0, 0, 0.5], [0.1, 0.1, 0.5], [0.15, 0.1, 0.5], [20, 0, 0.5]];
  assert.equal(inkSamples(pts, { size: 8 }).length, 2);
});

test("simulated pressure thins a fast stroke and keeps a slow one full", () => {
  const fast = inkSamples(line(12, 30), { size: 8, simulatePressure: true });
  const slow = inkSamples(line(12, 0.8), { size: 8, simulatePressure: true });
  assert.ok(fast.at(-2)!.pressure < slow.at(-2)!.pressure);
});

test("real pressure is used as given and widens the line", () => {
  assert.ok(inkRadius(8, 1) > inkRadius(8, 0.5));
  assert.ok(inkRadius(8, 0.5) > inkRadius(8, 0));
  assert.equal(inkRadius(8, 0.5), 4);
  const s = inkSamples([[0, 0, 0.2], [10, 0, 0.9]], { size: 8 });
  assert.equal(s[1].pressure, 0.9);
});

test("a tap is a dot: a closed circle of the stroke's radius", () => {
  const out = strokeOutline([[50, 50, 0.5]], { size: 10 });
  assert.equal(out.length, 16);
  for (const [x, y] of out) assert.ok(Math.abs(Math.hypot(x - 50, y - 50) - 5) < 1e-9);
});

test("a straight stroke's outline is as wide as the pen and wraps both ends", () => {
  const out = strokeOutline(line(20), { size: 10, streamline: 0 });
  const ys = out.map(([, y]) => y);
  const xs = out.map(([x]) => x);
  // Width: about the pen size around y = 20.
  assert.ok(Math.max(...ys) - Math.min(...ys) <= 10.01 && Math.max(...ys) - Math.min(...ys) > 7);
  // Caps extend past the first and last points.
  assert.ok(Math.min(...xs) < 10 && Math.max(...xs) > 10 + 19 * 4);
  // The path is closed and drawable.
  const d = outlineToPath(out);
  assert.match(d, /^M[-\d.]+,[-\d.]+Q/);
  assert.ok(d.endsWith("Z"));
});

test("the outline is a simple loop: the start cap goes behind the stroke, the end cap ahead", () => {
  const out = strokeOutline(line(10, 10), { size: 10, streamline: 0 });
  // Cap points come first (indices 0..6) and must lie at x <= the first sample.
  for (let i = 0; i < 7; i++) assert.ok(out[i][0] <= 10 + 1e-6, `start cap point ${i} at ${out[i][0]}`);
});

/* ——— hit testing ——— */

const stroke: StrokeObject = { id: "a", kind: "stroke", color: "#000", size: 6, points: line(10), simulated: true };
const rect: ShapeObject = { id: "r", kind: "rect", color: "#000", size: 4, x1: 100, y1: 100, x2: 200, y2: 160 };
const ellipse: ShapeObject = { id: "e", kind: "ellipse", color: "#000", size: 4, x1: 300, y1: 100, x2: 400, y2: 200 };
const arrow: ShapeObject = { id: "w", kind: "arrow", color: "#000", size: 4, x1: 0, y1: 300, x2: 100, y2: 300 };
const text: TextObject = { id: "t", kind: "text", color: "#000", size: 20, x: 500, y: 500, text: "Logo\nhere", width: 60 };

test("strokes are hit on their ink, within half their width plus tolerance", () => {
  assert.ok(hitsInk(stroke, 20, 22, 0));
  assert.ok(hitsInk(stroke, 20, 25, 2));
  assert.ok(!hitsInk(stroke, 20, 40, 2));
});

test("a rectangle is erased on its outline, not in its empty middle", () => {
  assert.ok(hitsInk(rect, 150, 101, 0));
  assert.ok(hitsInk(rect, 199, 130, 0));
  assert.ok(!hitsInk(rect, 150, 130, 2));
});

test("an ellipse is hit near its curve", () => {
  assert.ok(hitsInk(ellipse, 400, 150, 1));
  assert.ok(hitsInk(ellipse, 350, 100, 1));
  assert.ok(!hitsInk(ellipse, 350, 150, 2));
});

test("an arrow is hit on its shaft and its head", () => {
  assert.ok(hitsInk(arrow, 50, 300, 0));
  assert.ok(!hitsInk(arrow, 50, 330, 2));
  // A point on one barb, a little back from the tip.
  assert.ok(hitsInk(arrow, 92, 296, 1) || hitsInk(arrow, 92, 304, 1));
});

test("select picks the topmost object, and closed shapes by their middle", () => {
  const objs: SketchObject[] = [rect, ellipse, text];
  assert.equal(pickObject(objs, 150, 130, 2)?.id, "r");
  assert.equal(pickObject(objs, 350, 150, 2)?.id, "e");
  assert.equal(pickObject(objs, 302, 102, 0), null, "outside the ellipse's curve, inside its box");
  assert.equal(pickObject(objs, 520, 520, 0)?.id, "t");
  const covered = { ...rect, id: "top" };
  assert.equal(pickObject([rect, covered], 150, 130, 2)?.id, "top");
  assert.equal(pickObject(objs, 900, 900, 2), null);
});

test("text bounds cover every line", () => {
  const b = objectBounds(text);
  assert.equal(b.h, 2 * 20 * 1.25);
  assert.equal(b.w, 60);
});

test("the eraser takes what its path crosses, including between samples", () => {
  const objs: SketchObject[] = [stroke, rect, ellipse];
  // A fast sweep from above the stroke to below it, sampled only at the ends.
  assert.deepEqual(erasedBy(objs, 30, 0, 30, 60, 3), ["a"]);
  assert.deepEqual(erasedBy(objs, 150, 130, 160, 135, 3), []);
});

test("moving an object moves every coordinate it has", () => {
  const moved = translateObject(stroke, 5, -5);
  assert.deepEqual(moved.points[0], [15, 15, 0.5]);
  assert.deepEqual(translateObject(rect, 10, 10), { ...rect, x1: 110, y1: 110, x2: 210, y2: 170 });
  assert.deepEqual(translateObject(text, 1, 2), { ...text, x: 501, y: 502 });
  assert.notEqual(moved, stroke, "a new object, so history keeps the old one");
});

test("shift constrains boxes to squares and lines to 45 degrees", () => {
  assert.deepEqual(constrainShape("rect", 0, 0, 40, 10), [40, 40]);
  assert.deepEqual(constrainShape("ellipse", 0, 0, -10, 30), [-30, 30]);
  const [x, y] = constrainShape("line", 0, 0, 100, 8);
  assert.ok(Math.abs(y) < 1e-9 && Math.abs(x - Math.hypot(100, 8)) < 1e-9);
});

test("a click with the shape tool is not a shape", () => {
  assert.ok(isDegenerateShape({ kind: "rect", x1: 0, y1: 0, x2: 2, y2: 3 }));
  assert.ok(!isDegenerateShape({ kind: "rect", x1: 0, y1: 0, x2: 2, y2: 30 }));
  assert.ok(isDegenerateShape({ kind: "arrow", x1: 0, y1: 0, x2: 2, y2: 2 }));
});

/* ——— history ——— */

test("undo and redo walk the history; a new step drops the redo branch", () => {
  let h = createHistory();
  assert.ok(!canUndo(h) && !canRedo(h));
  h = commit(h, [stroke]);
  h = commit(h, [stroke, rect]);
  assert.deepEqual(h.present.map((o) => o.id), ["a", "r"]);
  h = undo(h);
  assert.deepEqual(h.present.map((o) => o.id), ["a"]);
  assert.ok(canRedo(h));
  h = redo(h);
  assert.deepEqual(h.present.map((o) => o.id), ["a", "r"]);
  h = undo(undo(h));
  assert.deepEqual(h.present, []);
  assert.ok(!canUndo(h));
  assert.equal(undo(h), h, "undo past the start is a no-op");
  h = commit(redo(h), [stroke, ellipse]);
  assert.ok(!canRedo(h), "branching clears the future");
  assert.deepEqual(undo(h).present.map((o) => o.id), ["a"]);
});

test("committing the same list is not a step, and history is capped", () => {
  let h = createHistory([stroke]);
  assert.equal(commit(h, h.present), h);
  for (let i = 0; i < HISTORY_LIMIT + 50; i++) h = commit(h, [{ ...stroke, id: `s${i}` }]);
  assert.equal(h.past.length, HISTORY_LIMIT);
});

/* ——— paper & export ——— */

test("export keeps the paper's proportions at a fixed long edge", () => {
  assert.deepEqual(exportSize(1000, 750), { width: EXPORT_LONG_EDGE, height: 1152, scale: EXPORT_LONG_EDGE / 1000 });
  const portrait = exportSize(390, 700);
  assert.equal(portrait.height, EXPORT_LONG_EDGE);
  assert.equal(portrait.width, Math.round(390 * (EXPORT_LONG_EDGE / 700)));
  // A small phone sketch is scaled up, so it is as sharp as a desktop one.
  assert.ok(exportSize(300, 300).scale > 1);
});

test("export never exceeds the pixel budget", () => {
  const square = exportSize(1600, 1600);
  assert.ok(square.width * square.height <= EXPORT_MAX_PIXELS);
  assert.equal(square.width, EXPORT_LONG_EDGE);
});

test("new paper takes the room's shape within 1:2 and 2:1, and fits back into any room", () => {
  const wide = paperForRoom(1000, 600);
  assert.deepEqual(wide, { width: 1000, height: 600 });
  const sliver = paperForRoom(1400, 300);
  assert.equal(sliver.width / sliver.height, 2);
  const huge = paperForRoom(5000, 3000);
  assert.equal(huge.width, 1600);
  const fit = fitPaper(1000, 600, 390, 600);
  assert.ok(Math.abs(fit.w - 390) < 1e-9);
  assert.ok(fit.y > 0 && Math.abs(fit.h - 234) < 1e-9);
});

/* ——— names & the image-model path ——— */

test("sketch file names survive sanitizeFileName and are recognised", () => {
  const name = sketchFileName(new Date("2026-10-03T14:31:08Z"));
  assert.equal(name, "Sketch 2026-10-03-14-31-08.png");
  assert.match(name, /^[A-Za-z0-9._ -]+$/);
  assert.ok(isSketchFileName(name));
  assert.ok(isSketchFileName("Sketch 2026-10-03-14-31-08 2.png"));
  assert.ok(!isSketchFileName("Screenshot 2026-10-03-14-31-08.png"));
  assert.ok(!isSketchFileName("Sketch of a cat.png"));
});

test("an image model gets the sketch as its source and the layout instruction after the words", () => {
  const att = [
    { id: "f1", kind: "FILE", fileName: "brief.pdf" },
    { id: "s1", kind: "IMAGE", fileName: "Sketch 2026-10-03-14-31-08.png" },
  ];
  const req = sketchGuideForGeneration("image", "A poster for a jazz night", att);
  assert.deepEqual(req.edit, { attachmentId: "s1" });
  assert.ok(req.prompt.startsWith("A poster for a jazz night\n\n"));
  assert.match(req.prompt, /composition and layout guide/);
  assert.match(sketchGuidePrompt("  "), /^Turn the sketch into a finished image/);
});

test("chat models, other media and ordinary photos send the prompt untouched", () => {
  const sketchAtt = [{ id: "s1", kind: "IMAGE", fileName: "Sketch 2026-10-03-14-31-08.png" }];
  assert.deepEqual(sketchGuideForGeneration("video", "x", sketchAtt), { prompt: "x" });
  assert.deepEqual(sketchGuideForGeneration("chat", "x", sketchAtt), { prompt: "x" });
  assert.deepEqual(sketchGuideForGeneration("image", "x", [{ id: "p", kind: "IMAGE", fileName: "photo.png" }]), { prompt: "x" });
});
