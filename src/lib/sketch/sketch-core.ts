/*
 * SKETCH, THE PURE PART: the document, the ink, the hit tests, the history and
 * the export size. No DOM and no canvas here, so every rule the editor leans
 * on can be tested in node (tests/sketch.test.ts).
 *
 * The document is vector: a list of objects in paper units (the paper's own
 * width and height, fixed when the sketch was started). The editor fits the
 * paper into whatever room it has and the export scales it to a fixed long
 * edge, so the same sketch reopens at the same proportions on a phone and on
 * a desktop.
 */

export type SketchTool = "select" | "pen" | "text" | "shape" | "eraser";
export type ShapeKind = "rect" | "ellipse" | "line" | "arrow";

/** x, y in paper units; pressure 0..1. */
export type InkPoint = [x: number, y: number, pressure: number];

interface Base {
  id: string;
  color: string;
  /** Stroke width in paper units (for text: the font size). */
  size: number;
}

export interface StrokeObject extends Base {
  kind: "stroke";
  points: InkPoint[];
  /** True when the device reported no real pressure (mouse, most fingers). */
  simulated: boolean;
}

export interface ShapeObject extends Base {
  kind: ShapeKind;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TextObject extends Base {
  kind: "text";
  x: number;
  /** Top of the first line. */
  y: number;
  text: string;
  /** Measured width of the widest line, in paper units (set by the editor). */
  width: number;
}

export type SketchObject = StrokeObject | ShapeObject | TextObject;

export interface SketchDoc {
  width: number;
  height: number;
  objects: SketchObject[];
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ———————————————————————————————— palette ———————————————————————————————— */

/** Ink on white paper, so fixed hexes in both themes (the paper never darkens). */
export const SKETCH_SWATCHES: readonly { name: string; value: string }[] = [
  { name: "Ink", value: "#1b1c1f" },
  { name: "Graphite", value: "#8a8d93" },
  { name: "Umber", value: "#8a5a32" },
  { name: "Red", value: "#e1463e" },
  { name: "Orange", value: "#f2711c" },
  { name: "Amber", value: "#f5b417" },
  { name: "Green", value: "#2f9e5b" },
  { name: "Teal", value: "#14a08f" },
  { name: "Cyan", value: "#1aa2c8" },
  { name: "Blue", value: "#2d49c9" },
  { name: "Indigo", value: "#5b4fd6" },
  { name: "Violet", value: "#9046c9" },
  { name: "Pink", value: "#d9408f" },
];

/** Five sizes, a rung each: pen width in paper units, and the text size it implies. */
export const SKETCH_SIZES: readonly { name: string; stroke: number; font: number }[] = [
  { name: "Fine", stroke: 2, font: 16 },
  { name: "Thin", stroke: 4, font: 22 },
  { name: "Medium", stroke: 7, font: 30 },
  { name: "Bold", stroke: 12, font: 42 },
  { name: "Marker", stroke: 20, font: 58 },
];

export const TEXT_LINE_HEIGHT = 1.25;

/* ———————————————————————————————— ink ———————————————————————————————— */

export interface InkOptions {
  /** Nominal width in paper units. */
  size: number;
  /** How much pressure changes the width (0 = constant, 1 = from 0 to 2×). */
  thinning?: number;
  /** 0..1 pull toward the previous point; hides the shake of a hand. */
  streamline?: number;
  /** Derive pressure from speed (fast = thin), for mice and fingers. */
  simulatePressure?: boolean;
}

interface InkSample {
  x: number;
  y: number;
  pressure: number;
}

/**
 * The points the outline is built on: streamlined (each point eased toward the
 * raw input, the way a pen nib lags the hand), near-duplicates dropped, and
 * pressure either taken from the device or simulated from speed.
 */
export function inkSamples(input: readonly InkPoint[], opts: InkOptions): InkSample[] {
  if (input.length === 0) return [];
  const streamline = clamp(opts.streamline ?? 0.45, 0, 0.95);
  const t = 0.15 + (1 - streamline) * 0.85;
  const size = Math.max(0.5, opts.size);
  const out: InkSample[] = [];
  let prev = { x: input[0][0], y: input[0][1] };
  let pressure = opts.simulatePressure ? 0.5 : clamp(input[0][2] || 0.5, 0, 1);
  out.push({ x: prev.x, y: prev.y, pressure });
  for (let i = 1; i < input.length; i++) {
    const [rx, ry, rp] = input[i];
    const isLast = i === input.length - 1;
    // The last point is taken as drawn, so the line ends where the pen lifted.
    const x = isLast ? rx : prev.x + (rx - prev.x) * t;
    const y = isLast ? ry : prev.y + (ry - prev.y) * t;
    const dist = Math.hypot(x - prev.x, y - prev.y);
    if (dist < 0.35 && !isLast) continue;
    if (opts.simulatePressure) {
      // Fast is thin, slow is full: the ramp perfect-freehand popularised.
      const speed = Math.min(1, dist / size);
      const target = Math.min(1, 1 - speed);
      pressure = Math.min(1, pressure + (target - pressure) * (speed * 0.275 + 0.05));
    } else {
      pressure = clamp(rp || pressure, 0, 1);
    }
    if (dist < 0.35 && isLast && out.length > 1) {
      out[out.length - 1] = { x, y, pressure };
    } else {
      out.push({ x, y, pressure });
    }
    prev = { x, y };
  }
  return out;
}

/** The radius a sample is drawn at. */
export function inkRadius(size: number, pressure: number, thinning = 0.55): number {
  return Math.max(0.35, size * (0.5 - thinning * (0.5 - pressure)));
}

/**
 * A closed polygon around the stroke: the left edge forward, a round cap, the
 * right edge back, a round cap. Filled, it is a pressure-shaped line with no
 * joins to mitre and no gaps at speed.
 */
export function strokeOutline(input: readonly InkPoint[], opts: InkOptions): [number, number][] {
  const samples = inkSamples(input, opts);
  if (samples.length === 0) return [];
  // Speed is a weaker signal than a pen's pressure: let it thin the line less.
  const thinning = opts.thinning ?? (opts.simulatePressure ? 0.35 : 0.55);
  const radii = samples.map((s) => inkRadius(opts.size, s.pressure, thinning));
  // A dot: a tap, or a stroke shorter than its own width.
  const length = pathLength(samples);
  if (samples.length === 1 || length < opts.size * 0.25) {
    const r = Math.max(...radii);
    return circlePolygon(samples[0].x, samples[0].y, r, 16);
  }
  // Ease the ends so a stroke tapers in and out rather than starting blunt.
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const edge = Math.min(i, n - 1 - i);
    if (edge < 2) radii[i] *= 0.82 + edge * 0.09;
  }
  const left: [number, number][] = [];
  const right: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = samples[Math.max(0, i - 1)];
    const b = samples[Math.min(n - 1, i + 1)];
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const len = Math.hypot(tx, ty) || 1;
    tx /= len;
    ty /= len;
    const nx = -ty;
    const ny = tx;
    const r = radii[i];
    left.push([samples[i].x + nx * r, samples[i].y + ny * r]);
    right.push([samples[i].x - nx * r, samples[i].y - ny * r]);
  }
  const startDir = Math.atan2(samples[1].y - samples[0].y, samples[1].x - samples[0].x);
  const endDir = Math.atan2(samples[n - 1].y - samples[n - 2].y, samples[n - 1].x - samples[n - 2].x);
  const startCap = capArc(samples[0], startDir, radii[0], true);
  const endCap = capArc(samples[n - 1], endDir, radii[n - 1], false);
  return [...startCap, ...left, ...endCap, ...right.reverse()];
}

/**
 * The half circle that closes one end. `forward` is the stroke's direction at
 * that end. The polygon arrives at the start from the right edge and leaves
 * along the left, so the start cap sweeps right → behind → left; the end cap
 * arrives on the left and sweeps left → ahead → right.
 */
function capArc(at: InkSample, forward: number, r: number, start: boolean): [number, number][] {
  const from = start ? forward - Math.PI / 2 : forward + Math.PI / 2;
  const pts: [number, number][] = [];
  const steps = 8;
  for (let i = 1; i < steps; i++) {
    const a = from - (Math.PI * i) / steps;
    pts.push([at.x + Math.cos(a) * r, at.y + Math.sin(a) * r]);
  }
  return pts;
}

function circlePolygon(cx: number, cy: number, r: number, steps: number): [number, number][] {
  const pts: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const a = (Math.PI * 2 * i) / steps;
    pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return pts;
}

function pathLength(points: readonly { x: number; y: number }[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  return total;
}

/**
 * SVG-style path data through an outline's midpoints with quadratic curves:
 * the polygon's corners become the control points, so the edge is smooth
 * without adding points. Usable as a Path2D source.
 */
export function outlineToPath(outline: readonly [number, number][]): string {
  const n = outline.length;
  if (n === 0) return "";
  if (n < 3) return `M${fmt(outline[0][0])},${fmt(outline[0][1])}Z`;
  const mid = (i: number): [number, number] => {
    const a = outline[i % n];
    const b = outline[(i + 1) % n];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  const start = mid(0);
  let d = `M${fmt(start[0])},${fmt(start[1])}`;
  for (let i = 1; i <= n; i++) {
    const c = outline[i % n];
    const m = mid(i);
    d += `Q${fmt(c[0])},${fmt(c[1])} ${fmt(m[0])},${fmt(m[1])}`;
  }
  return `${d}Z`;
}

const fmt = (v: number) => (Math.round(v * 100) / 100).toString();

/* ———————————————————————————————— shapes ———————————————————————————————— */

/** The two barbs of an arrowhead at (x2, y2), sized to the stroke. */
export function arrowHead(shape: Pick<ShapeObject, "x1" | "y1" | "x2" | "y2" | "size">): [[number, number], [number, number]] {
  const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
  const length = Math.hypot(shape.x2 - shape.x1, shape.y2 - shape.y1);
  const head = Math.min(length * 0.45, 10 + shape.size * 2.6);
  const spread = Math.PI / 7;
  return [
    [shape.x2 - Math.cos(angle - spread) * head, shape.y2 - Math.sin(angle - spread) * head],
    [shape.x2 - Math.cos(angle + spread) * head, shape.y2 - Math.sin(angle + spread) * head],
  ];
}

/**
 * Shift held: rectangles and ellipses go square, lines snap to 45°.
 * Returns the corrected end point.
 */
export function constrainShape(kind: ShapeKind, x1: number, y1: number, x2: number, y2: number): [number, number] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (kind === "rect" || kind === "ellipse") {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return [x1 + Math.sign(dx || 1) * side, y1 + Math.sign(dy || 1) * side];
  }
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const len = Math.hypot(dx, dy);
  return [x1 + Math.cos(angle) * len, y1 + Math.sin(angle) * len];
}

/* ———————————————————————————————— geometry ———————————————————————————————— */

export function objectBounds(obj: SketchObject): Box {
  switch (obj.kind) {
    case "stroke": {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const [x, y] of obj.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
      const r = obj.size / 2;
      return { x: minX - r, y: minY - r, w: maxX - minX + obj.size, h: maxY - minY + obj.size };
    }
    case "text": {
      const lines = Math.max(1, obj.text.split("\n").length);
      return { x: obj.x, y: obj.y, w: Math.max(obj.width, obj.size * 0.5), h: lines * obj.size * TEXT_LINE_HEIGHT };
    }
    default: {
      const r = obj.size / 2;
      const x = Math.min(obj.x1, obj.x2);
      const y = Math.min(obj.y1, obj.y2);
      return { x: x - r, y: y - r, w: Math.abs(obj.x2 - obj.x1) + obj.size, h: Math.abs(obj.y2 - obj.y1) + obj.size };
    }
  }
}

export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insideBox(px: number, py: number, b: Box, pad = 0): boolean {
  return px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad;
}

/**
 * Whether (px, py) touches the object's INK within `tolerance` paper units.
 * This is the eraser's test: a rectangle is erased by crossing its outline,
 * not by touching the empty paper inside it.
 */
export function hitsInk(obj: SketchObject, px: number, py: number, tolerance: number): boolean {
  const reach = tolerance + obj.size / 2;
  switch (obj.kind) {
    case "stroke": {
      const pts = obj.points;
      if (!insideBox(px, py, objectBounds(obj), tolerance)) return false;
      if (pts.length === 1) return Math.hypot(px - pts[0][0], py - pts[0][1]) <= reach;
      for (let i = 1; i < pts.length; i++) {
        if (distanceToSegment(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= reach) return true;
      }
      return false;
    }
    case "line":
      return distanceToSegment(px, py, obj.x1, obj.y1, obj.x2, obj.y2) <= reach;
    case "arrow": {
      if (distanceToSegment(px, py, obj.x1, obj.y1, obj.x2, obj.y2) <= reach) return true;
      const [a, b] = arrowHead(obj);
      return (
        distanceToSegment(px, py, obj.x2, obj.y2, a[0], a[1]) <= reach ||
        distanceToSegment(px, py, obj.x2, obj.y2, b[0], b[1]) <= reach
      );
    }
    case "rect": {
      const x1 = Math.min(obj.x1, obj.x2);
      const x2 = Math.max(obj.x1, obj.x2);
      const y1 = Math.min(obj.y1, obj.y2);
      const y2 = Math.max(obj.y1, obj.y2);
      return (
        distanceToSegment(px, py, x1, y1, x2, y1) <= reach ||
        distanceToSegment(px, py, x2, y1, x2, y2) <= reach ||
        distanceToSegment(px, py, x2, y2, x1, y2) <= reach ||
        distanceToSegment(px, py, x1, y2, x1, y1) <= reach
      );
    }
    case "ellipse": {
      const cx = (obj.x1 + obj.x2) / 2;
      const cy = (obj.y1 + obj.y2) / 2;
      const rx = Math.abs(obj.x2 - obj.x1) / 2;
      const ry = Math.abs(obj.y2 - obj.y1) / 2;
      if (rx < 0.5 || ry < 0.5) return distanceToSegment(px, py, obj.x1, obj.y1, obj.x2, obj.y2) <= reach;
      // Distance to the curve, approximated along the ray from the centre:
      // exact on circles, within a few percent on any ellipse a hand draws.
      const dx = px - cx;
      const dy = py - cy;
      const k = Math.hypot(dx / rx, dy / ry);
      if (k === 0) return Math.min(rx, ry) <= reach;
      const ex = dx / k;
      const ey = dy / k;
      return Math.hypot(dx - ex, dy - ey) <= reach;
    }
    case "text":
      return insideBox(px, py, objectBounds(obj), tolerance);
  }
}

/**
 * The select tool's test: ink, or anywhere inside a closed shape or a text
 * block (you pick a box up by its middle). Topmost wins, so the list is read
 * from the end.
 */
export function pickObject(objects: readonly SketchObject[], px: number, py: number, tolerance: number): SketchObject | null {
  for (let i = objects.length - 1; i >= 0; i--) {
    const obj = objects[i];
    if (hitsInk(obj, px, py, tolerance)) return obj;
    if ((obj.kind === "rect" || obj.kind === "ellipse") && insideBox(px, py, objectBounds(obj))) {
      if (obj.kind === "rect") return obj;
      const cx = (obj.x1 + obj.x2) / 2;
      const cy = (obj.y1 + obj.y2) / 2;
      const rx = Math.abs(obj.x2 - obj.x1) / 2 || 1;
      const ry = Math.abs(obj.y2 - obj.y1) / 2 || 1;
      if (((px - cx) / rx) ** 2 + ((py - cy) / ry) ** 2 <= 1) return obj;
    }
  }
  return null;
}

/** The ids the eraser's path from (ax, ay) to (bx, by) crosses. */
export function erasedBy(
  objects: readonly SketchObject[],
  ax: number,
  ay: number,
  bx: number,
  by: number,
  radius: number,
): string[] {
  const hit: string[] = [];
  const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(1, radius / 2)));
  for (const obj of objects) {
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      if (hitsInk(obj, ax + (bx - ax) * t, ay + (by - ay) * t, radius)) {
        hit.push(obj.id);
        break;
      }
    }
  }
  return hit;
}

export function translateObject<T extends SketchObject>(obj: T, dx: number, dy: number): T {
  switch (obj.kind) {
    case "stroke":
      return { ...obj, points: obj.points.map(([x, y, p]) => [x + dx, y + dy, p] as InkPoint) };
    case "text":
      return { ...obj, x: obj.x + dx, y: obj.y + dy };
    default:
      return { ...obj, x1: obj.x1 + dx, y1: obj.y1 + dy, x2: obj.x2 + dx, y2: obj.y2 + dy } as T;
  }
}

/** A shape smaller than this (paper units on both axes) was a click, not a drag. */
export function isDegenerateShape(shape: Pick<ShapeObject, "kind" | "x1" | "y1" | "x2" | "y2">): boolean {
  const w = Math.abs(shape.x2 - shape.x1);
  const h = Math.abs(shape.y2 - shape.y1);
  return shape.kind === "line" || shape.kind === "arrow" ? Math.hypot(w, h) < 4 : w < 4 && h < 4;
}

/* ———————————————————————————————— history ———————————————————————————————— */

export interface SketchHistory {
  past: SketchObject[][];
  present: SketchObject[];
  future: SketchObject[][];
}

export const HISTORY_LIMIT = 200;

export function createHistory(objects: SketchObject[] = []): SketchHistory {
  return { past: [], present: objects, future: [] };
}

/** One undoable step. A commit that changes nothing is not a step. */
export function commit(history: SketchHistory, next: SketchObject[]): SketchHistory {
  if (next === history.present) return history;
  const past = [...history.past, history.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: next, future: [] };
}

export function undo(history: SketchHistory): SketchHistory {
  if (history.past.length === 0) return history;
  const previous = history.past[history.past.length - 1];
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

export function redo(history: SketchHistory): SketchHistory {
  if (history.future.length === 0) return history;
  const [next, ...rest] = history.future;
  return { past: [...history.past, history.present], present: next, future: rest };
}

export const canUndo = (h: SketchHistory) => h.past.length > 0;
export const canRedo = (h: SketchHistory) => h.future.length > 0;

/* ———————————————————————————————— paper & export ———————————————————————————————— */

/** The paper a new sketch gets: the room it opened in, within sane bounds. */
export function paperForRoom(roomW: number, roomH: number): { width: number; height: number } {
  const w = Math.max(240, roomW);
  const h = Math.max(240, roomH);
  // Keep between 1:2 and 2:1 so a sliver of a window does not make a sliver of a sketch.
  const ratio = clamp(w / h, 0.5, 2);
  // Paper units are about CSS pixels at the size it was started at, capped so a
  // sketch begun on a 5K display is not ten thousand units wide.
  const long = Math.min(Math.max(w, h), 1600);
  return ratio >= 1
    ? { width: Math.round(long), height: Math.round(long / ratio) }
    : { width: Math.round(long * ratio), height: Math.round(long) };
}

/** Where the paper sits in a room: uniform scale, centred. */
export function fitPaper(paperW: number, paperH: number, roomW: number, roomH: number): { scale: number; x: number; y: number; w: number; h: number } {
  const scale = Math.min(roomW / paperW, roomH / paperH);
  const w = paperW * scale;
  const h = paperH * scale;
  return { scale, x: (roomW - w) / 2, y: (roomH - h) / 2, w, h };
}

export const EXPORT_LONG_EDGE = 1536;
/** Image models resize anything bigger; this keeps a PNG under a few MB. */
export const EXPORT_MAX_PIXELS = 1536 * 1536;

/**
 * The exported image's size: the paper's proportions at a fixed long edge, so
 * the picture is sharp on any screen it was drawn on (retina or not) and the
 * model reads the same detail whatever device made it.
 */
export function exportSize(paperW: number, paperH: number, longEdge = EXPORT_LONG_EDGE): { width: number; height: number; scale: number } {
  const w = Math.max(1, paperW);
  const h = Math.max(1, paperH);
  let scale = longEdge / Math.max(w, h);
  if (w * scale * h * scale > EXPORT_MAX_PIXELS) scale = Math.sqrt(EXPORT_MAX_PIXELS / (w * h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)), scale };
}

/* ———————————————————————————————— naming ———————————————————————————————— */

/** "Sketch 2026-10-03-14-31-08.png": dash-only, so sanitizeFileName keeps it. */
export function sketchFileName(now = new Date()): string {
  return `Sketch ${now.toISOString().slice(0, 19).replace(/[:T]/g, "-")}.png`;
}

const SKETCH_NAME = /^Sketch \d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}(?: \d+)?\.png$/;

/** Whether a file name is one this editor gave a sketch. */
export function isSketchFileName(name: string): boolean {
  return SKETCH_NAME.test(name);
}

/** What an image model is told about a sketch attached to the request. */
export const SKETCH_GUIDE_INSTRUCTION =
  "Use the attached sketch as the composition and layout guide: keep where each element sits and how big it is, and render it as a finished image, not as a drawing.";

/**
 * The prompt an image model receives with a sketch: the person's words first
 * (they title the chat and the file), the guide instruction after them.
 */
export function sketchGuidePrompt(text: string): string {
  const said = text.trim();
  return said ? `${said}\n\n${SKETCH_GUIDE_INSTRUCTION}` : `Turn the sketch into a finished image. ${SKETCH_GUIDE_INSTRUCTION}`;
}

let idCounter = 0;
export function sketchId(): string {
  idCounter = (idCounter + 1) % 1_000_000;
  return `s${Date.now().toString(36)}${idCounter.toString(36)}`;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * What a media generation sends when the message carries a sketch. Only an
 * image model takes one, through the route's existing image-input path
 * (`edit: { attachmentId }` with no region or mask: the whole sketch is the
 * source, and the prompt says it is a layout to follow, not a picture to
 * retouch). Anything else sends the prompt as typed.
 */
export function sketchGuideForGeneration(
  modality: string,
  prompt: string,
  attachments: readonly { id: string; kind: string; fileName: string }[],
): { prompt: string; edit?: { attachmentId: string } } {
  if (modality !== "image") return { prompt };
  const sketch = attachments.find((a) => a.kind === "IMAGE" && isSketchFileName(a.fileName));
  if (!sketch) return { prompt };
  return { prompt: sketchGuidePrompt(prompt), edit: { attachmentId: sketch.id } };
}
