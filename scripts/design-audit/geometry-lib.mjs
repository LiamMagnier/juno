/**
 * Geometry audit: the pure half.
 *
 * Everything in this module is deterministic arithmetic over plain data: the
 * scales, the radius maths, clustering, the checks themselves, ranking and
 * scoring. The browser half (geometry-collect.mjs) turns a rendered page into
 * element records; the CLI (geometry-audit.mjs) drives Playwright and writes
 * the reports. Keeping the judgement here means every rule can be unit tested
 * without a browser (tests/design-geometry-audit.test.ts).
 *
 * An element record, as the collector emits it (all lengths in CSS px, rounded
 * to 0.01):
 *
 *   i     index in DOM pre-order among recorded elements
 *   p     index of the nearest recorded ancestor, -1 for a root
 *   tag, role, path, comp, comps, text, label, hooks   identity
 *   x y w h                border box in viewport (or document) coordinates
 *   disp pos fd fw         display, position, flex-direction, flex-wrap
 *   pad [t r b l]  mar [t r b l] (null = auto)  bw [t r b l]
 *   rad [tl tr br bl]      corner radius as authored, resolved to px
 *   gap [row col]          null when the container has no gap
 *   fs lh                  font size and line height (lh null = normal); only on text
 *   ta dir                 text-align and direction
 *   paint                  what it paints: b bg, i image, r border, s shadow, m media, f backdrop
 *   bg                     background-color string, for "same paint as parent"
 *   clip                   true when overflow is not visible (it clips its children)
 *   kind                   button input select textarea tab menuitem option link
 *                          checkbox radio switch slider row clickable, or null
 *   inter disabled inline sel   interactive / disabled / link inside running text / selected state
 *   icon                   true for a glyph box (svg, small img, role=img)
 *   txt                    true when it has its own non-blank text node
 *   tl tr                  left and right of its own text's first and last line
 *   ig                     [leadGap, trailGap] between a flow icon child and the text beside it
 *   tgt                    [w, h] hit-tested target extent (only for small interactive elements)
 *   covered                true when the centre of a small target is covered by something else
 */

// ---------------------------------------------------------------------------
// Scales and configuration

export const DEFAULT_SPACING_SCALE = [0, 2, 4, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64];
export const DEFAULT_CONTROL_HEIGHTS = [24, 28, 32, 36, 40, 44];
// docs/design/ICONS_AND_MOTION.md §1.2: 12 dense, 14 caption, 16 default,
// 18 sidebar destinations, 20 large targets, 24 and up empty-state art.
export const DEFAULT_ICON_SIZES = [12, 14, 16, 18, 20, 24, 32, 40, 48];
// Used only when tailwind.config.ts cannot be read.
export const FALLBACK_RADIUS_SCALE = [0, 2, 4, 6, 8, 10, 12, 14, 16, 26, 28];

export const DEFAULT_TOLERANCES = Object.freeze({
  /** A value within this many px of a rung counts as on the rung (rem rounding). */
  scale: 0.5,
  /** |child radius - (parent radius - inset)| above this is a nested-radius violation. */
  nestedRadius: 2,
  /** A child corner more than this many px outside the parent's curve pokes out. */
  pokeOut: 0.75,
  /** Left/right or top/bottom paddings further apart than this are asymmetric. */
  symmetry: 0.5,
  /** Sibling paddings further apart than this are inconsistent. */
  sibling: 0.5,
  /** Controls in one row whose heights differ by more than this are inconsistent. */
  rowHeight: 1,
  /** Side-by-side controls further apart than this are separate rows (clusters). */
  rowGap: 40,
  /** How many wrapper levels below a container its row controls may sit. */
  rowDepth: 5,
  /** Text edges closer than alignMax but further apart than alignMin are a near miss. */
  alignMin: 0.5,
  alignMax: 3,
  /** Icon-to-text gaps in one family further apart than this are inconsistent. */
  iconGap: 0.5,
  /** Controls taller than this are blocks (cards, multi-line rows), not control heights. */
  maxControlHeight: 56,
  /** Pointer target minimum (WCAG 2.5.8) and the phone touch minimum (HIG). */
  targetPointer: 24,
  targetTouch: 44,
  /** Icons larger than this are illustrations, not glyphs. */
  maxIconSize: 64,
  /** An icon further than this from its text is placed by layout (space-between), not a gap. */
  maxIconGap: 32,
  /** A percentage radius rung matches within this many percentage points. */
  radiusPercent: 1.5,
});

/** Control kinds whose height is a "control height" (buttons, fields, tabs, menu rows, list rows). */
export const HEIGHT_KINDS = new Set(["button", "input", "select", "tab", "menuitem", "option", "link", "row"]);
/** Control kinds that should carry symmetric padding. */
export const SYMMETRIC_KINDS = new Set(["button", "tab", "menuitem", "option", "select", "input", "link", "row"]);
/** Kinds that are "a control" for the row-height check. */
export const ROW_KINDS = new Set(["button", "input", "select", "tab", "option", "link", "row", "menuitem"]);

export const VIOLATION_KINDS = [
  "nested-radius",
  "corner-poke-out",
  "clipped-corner",
  "asymmetric-padding",
  "sibling-padding",
  "sibling-radius",
  "row-height",
  "text-misalignment",
  "icon-gap",
  "target-size",
];

export const VIOLATION_LABELS = {
  "nested-radius": "Nested radius",
  "corner-poke-out": "Corner pokes out",
  "clipped-corner": "Corner cut by clip",
  "asymmetric-padding": "Asymmetric padding",
  "sibling-padding": "Sibling padding",
  "sibling-radius": "Sibling radius",
  "row-height": "Row heights",
  "text-misalignment": "Text edge near miss",
  "icon-gap": "Icon gap",
  "target-size": "Target size",
  "off-scale": "Off scale",
};

/** Outline colours on the annotated screenshots, with the name the report uses. */
export const KIND_COLORS = {
  "nested-radius": ["#e11d48", "rose"],
  "corner-poke-out": ["#be123c", "crimson"],
  "clipped-corner": ["#9f1239", "wine"],
  "asymmetric-padding": ["#d97706", "amber"],
  "sibling-padding": ["#ca8a04", "mustard"],
  "sibling-radius": ["#db2777", "pink"],
  "row-height": ["#7c3aed", "violet"],
  "text-misalignment": ["#2563eb", "blue"],
  "icon-gap": ["#0891b2", "cyan"],
  "target-size": ["#16a34a", "green"],
  "off-scale": ["#6b7280", "grey"],
};

export function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Round to the nearest half pixel: the grain the checks compare at. */
export function half(n) {
  return Math.round(n * 2) / 2;
}

export function fmt(n) {
  if (typeof n === "string") return n; // named rungs: "full", "concentric"
  if (n === null || n === undefined || Number.isNaN(n)) return "-";
  if (n === Infinity) return "full";
  const r = round2(n);
  return Number.isInteger(r) ? String(r) : String(r);
}

/** "1440x900" -> { width: 1440, height: 900 } */
export function parseViewport(text) {
  const m = /^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(String(text || ""));
  if (!m) throw new Error(`Bad viewport "${text}": expected WIDTHxHEIGHT, e.g. 1440x900`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** A phone viewport uses the 44px touch minimum and touch emulation. */
export function isPhoneViewport(vp) {
  return vp.width < 600;
}

/**
 * Parse a length as computed style reports it. Returns px, or null for
 * keywords (auto, normal). Percentages resolve against `basis` when given.
 */
export function parseLength(text, basis) {
  if (text === null || text === undefined) return null;
  const s = String(text).trim();
  if (!s || s === "auto" || s === "normal" || s === "none") return null;
  const m = /^(-?[\d.]+(?:e-?\d+)?)(px|rem|em|%)?$/i.exec(s);
  if (!m) return null;
  const v = parseFloat(m[1]);
  const unit = (m[2] || "px").toLowerCase();
  if (unit === "px") return v;
  if (unit === "rem" || unit === "em") return v * 16;
  if (unit === "%") return basis === undefined ? null : (v / 100) * basis;
  return null;
}

/**
 * Read the radius ladder out of tailwind.config.ts source: every px or rem
 * value in `theme.extend.borderRadius`, with `var(--x)` resolved through
 * `vars` (read from globals.css by the CLI). Percent rungs (the 24% logo
 * superellipse) come back separately. Calc and keywords are skipped: they are
 * derived radii (rounded-inner), not rungs.
 */
export function parseRadiusLadder(source, vars = {}) {
  const start = source.indexOf("borderRadius:");
  if (start < 0) return null;
  const open = source.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  let end = -1;
  for (let k = open; k < source.length; k++) {
    const ch = source[k];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = k;
        break;
      }
    }
  }
  if (end < 0) return null;
  const block = source
    .slice(open + 1, end)
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const px = new Set([0]);
  const pct = new Set();
  /** @type {Record<string, string[]>} */
  const names = {};
  const entry = /(?:^|[\s,{])["']?([\w-]+)["']?\s*:\s*["']([^"']+)["']/g;
  let m;
  while ((m = entry.exec(block))) {
    const name = m[1];
    let value = m[2].trim();
    const v = /^var\((--[\w-]+)\)$/.exec(value);
    if (v) {
      if (!(v[1] in vars)) continue;
      value = String(vars[v[1]]).trim();
    }
    if (/^-?[\d.]+%$/.test(value)) {
      pct.add(parseFloat(value));
      names[value] = (names[value] || []).concat(name);
      continue;
    }
    const n = parseLength(value);
    if (n === null || n > 1000) continue;
    px.add(n);
    names[fmt(n)] = (names[fmt(n)] || []).concat(name);
  }
  return {
    px: [...px].sort((a, b) => a - b),
    percent: [...pct].sort((a, b) => a - b),
    names,
  };
}

/** Pull `--name: value;` declarations out of a stylesheet (first one wins: the light :root). */
export function parseCssVars(css, names) {
  const out = {};
  for (const name of names) {
    const re = new RegExp(`${name.replace(/[-]/g, "\\-")}\\s*:\\s*([^;]+);`);
    const m = re.exec(css);
    if (m) out[name] = m[1].trim();
  }
  return out;
}

export function nearestRung(value, scale) {
  let best = null;
  for (const rung of scale) {
    if (best === null || Math.abs(rung - value) < Math.abs(best - value) || (Math.abs(rung - value) === Math.abs(best - value) && rung < best)) {
      best = rung;
    }
  }
  return { rung: best, delta: best === null ? Infinity : round2(value - best) };
}

export function isOnScale(value, scale, tol = DEFAULT_TOLERANCES.scale) {
  return scale.some((rung) => Math.abs(rung - value) <= tol + 1e-9);
}

// ---------------------------------------------------------------------------
// Radius maths

/**
 * The radii the browser actually draws. CSS Backgrounds 3 §5.5: when two
 * adjacent radii add up to more than the side they share, every radius is
 * scaled by the same factor, which is how `rounded-full` (9999px) becomes
 * half the short side.
 */
export function effectiveRadii(rad, w, h) {
  const [tl, tr, br, bl] = rad.map((r) => Math.max(0, r || 0));
  let f = 1;
  const pairs = [
    [tl + tr, w],
    [bl + br, w],
    [tl + bl, h],
    [tr + br, h],
  ];
  for (const [sum, side] of pairs) if (sum > 0) f = Math.min(f, side / sum);
  return [tl, tr, br, bl].map((r) => round2(r * f));
}

/** A corner is "full" (pill or circle) when it reaches half the short side. */
export function isFullRadius(r, w, h, tol = 0.5) {
  return r > 0 && r >= Math.min(w, h) / 2 - tol;
}

/** The concentric rule: inner radius = outer radius - inset. */
export function concentricExpected(parentRadius, inset) {
  return Math.max(0, round2(parentRadius - inset));
}

/**
 * How far (px) a child's corner reaches outside its parent's rounded corner.
 *
 * Coordinates are the parent's corner, folded so the corner is at the origin
 * and the boxes extend toward +x/+y. The parent's outline near the corner is
 * the arc centred at (R, R); the child's corner sits at (dx, dy) with radius r.
 * The child's corner boundary is sampled and the worst point is returned: 0
 * when the child's corner is inside (or on) the parent's curve.
 */
export function cornerPokeOut(parentRadius, childRadius, dx, dy, samples = 32) {
  const R = Math.max(0, parentRadius);
  const r = Math.max(0, childRadius);
  if (R === 0) return round2(Math.max(0, -dx, -dy));
  const outside = (x, y) => {
    if (x < R && y < R) return Math.hypot(R - x, R - y) - R;
    return Math.max(-x, -y);
  };
  let worst = -Infinity;
  if (r === 0) {
    worst = outside(dx, dy);
  } else {
    const cx = dx + r;
    const cy = dy + r;
    for (let k = 0; k <= samples; k++) {
      const a = Math.PI + (k / samples) * (Math.PI / 2);
      worst = Math.max(worst, outside(cx + r * Math.cos(a), cy + r * Math.sin(a)));
    }
  }
  return round2(Math.max(0, worst));
}

/** Insets between a child box and its parent box, per corner (tl tr br bl). */
export function cornerInsets(child, parent) {
  const left = child.x - parent.x;
  const top = child.y - parent.y;
  const right = parent.x + parent.w - (child.x + child.w);
  const bottom = parent.y + parent.h - (child.y + child.h);
  return [
    { dx: round2(left), dy: round2(top) },
    { dx: round2(right), dy: round2(top) },
    { dx: round2(right), dy: round2(bottom) },
    { dx: round2(left), dy: round2(bottom) },
  ];
}

/**
 * Judge one corner of a rounded child inside a rounded parent.
 *
 * The rule applies only when the child's corner sits inside the parent's
 * curve zone (both insets smaller than the parent radius): further in, the
 * two corners no longer read as one shape and the child's radius is free.
 * The inset used is the mean of the two (they are equal when the parent has
 * the same padding on both sides, which the concentric rule assumes).
 */
export function judgeCorner({ parentRadius, childRadius, dx, dy, parentClips = false, parentBorder = [0, 0], circle = false, tol = DEFAULT_TOLERANCES.nestedRadius, pokeTol = DEFAULT_TOLERANCES.pokeOut }) {
  const R = parentRadius;
  const r = childRadius;
  if (R <= 0 || dx < -0.5 || dy < -0.5 || dx >= R || dy >= R) {
    return { applicable: false };
  }
  const inset = round2((Math.max(0, dx) + Math.max(0, dy)) / 2);
  const expected = concentricExpected(R, inset);
  const delta = round2(r - expected);
  const poke = cornerPokeOut(R, r, Math.max(0, dx), Math.max(0, dy));
  // overflow clips at the padding box, whose radius is the outer radius less
  // the border: a child inset by exactly the border is flush with the clip.
  const [bx, by] = parentBorder;
  const cdx = dx - bx;
  const cdy = dy - by;
  const flushToClip = parentClips && Math.min(cdx, cdy) <= 0.5;
  let verdict = "ok";
  if (poke > pokeTol) {
    // Flush children of a clipping parent are the normal "image fills the
    // card" pattern: the clip draws the corner. A child inset a little and
    // then cut by the clip ends up with a lopsided corner.
    if (parentClips) {
      const clipPoke = cornerPokeOut(Math.max(0, R - Math.max(bx, by)), r, Math.max(0, cdx), Math.max(0, cdy));
      verdict = !flushToClip && clipPoke > pokeTol ? "clipped-corner" : "ok";
    } else verdict = "poke-out";
  }
  if (verdict === "ok" && Math.abs(delta) > tol) {
    if (delta > 0 && circle) verdict = "ok"; // avatars and round icon buttons are content shapes
    else if (!(flushToClip && delta < 0)) verdict = delta > 0 ? "too-round" : "too-sharp";
  }
  return { applicable: true, inset, expected, delta, poke, verdict };
}

// ---------------------------------------------------------------------------
// Statistics

/** Histogram as sorted [value, count] pairs (values rounded to 0.01). */
export function histogram(values) {
  const counts = new Map();
  for (const v of values) {
    if (v === null || v === undefined || Number.isNaN(v)) continue;
    const key = typeof v === "number" ? round2(v) : v;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => {
    if (typeof a[0] === "number" && typeof b[0] === "number") return a[0] - b[0];
    return String(a[0]).localeCompare(String(b[0]));
  });
}

/**
 * Single-linkage clustering of 1-D values: neighbours (after sorting) closer
 * than or equal to `link` share a cluster. Returns clusters of indices into
 * the input, each sorted by value then index, clusters ordered by value.
 */
export function clusterValues(values, link) {
  const order = values.map((v, k) => k).sort((a, b) => values[a] - values[b] || a - b);
  const clusters = [];
  let current = null;
  for (const k of order) {
    if (current && values[k] - values[current[current.length - 1]] <= link + 1e-9) current.push(k);
    else {
      current = [k];
      clusters.push(current);
    }
  }
  return clusters;
}

/** The most common value after rounding to half pixels; ties go to the smallest. */
export function modeOf(values) {
  const counts = new Map();
  for (const v of values) {
    const key = half(v);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  let bestCount = -1;
  for (const [key, count] of counts) {
    if (count > bestCount || (count === bestCount && key < best)) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

/**
 * WCAG 2.5.8 spacing exception: an undersized target passes when a circle of
 * diameter `size` centred on it touches no other target and no other
 * undersized target's circle.
 */
export function spacingExceptionOk(target, others, size = 24) {
  const cx = target.x + target.w / 2;
  const cy = target.y + target.h / 2;
  const radius = size / 2;
  for (const o of others) {
    if (o === target) continue;
    const small = o.w < size || o.h < size;
    if (small) {
      const ox = o.x + o.w / 2;
      const oy = o.y + o.h / 2;
      if (Math.hypot(ox - cx, oy - cy) < size - 1e-9) return false;
    } else {
      const nx = Math.max(o.x, Math.min(cx, o.x + o.w));
      const ny = Math.max(o.y, Math.min(cy, o.y + o.h));
      if (Math.hypot(nx - cx, ny - cy) < radius - 1e-9) return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Element helpers

export function rectOf(r) {
  return { x: r.x, y: r.y, w: r.w, h: r.h };
}

export function contains(outer, inner, tol = 0.5) {
  return inner.x >= outer.x - tol && inner.y >= outer.y - tol && inner.x + inner.w <= outer.x + outer.w + tol && inner.y + inner.h <= outer.y + outer.h + tol;
}

function verticalOverlap(a, b) {
  return Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
}

function horizontalOverlap(a, b) {
  return Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
}

function inFlow(r) {
  return r.pos !== "absolute" && r.pos !== "fixed";
}

/** A compact identity for reports. */
export function refOf(r) {
  const ref = { i: r.i, tag: r.tag, path: r.path, rect: [round2(r.x), round2(r.y), round2(r.w), round2(r.h)] };
  if (r.role) ref.role = r.role;
  if (r.comp) ref.comp = r.comp;
  if (r.label) ref.label = r.label;
  if (r.text) ref.text = r.text;
  if (r.hooks && Object.keys(r.hooks).length) ref.hooks = r.hooks;
  return ref;
}

/** "Button <button> "Save"" — the one-line name used in reports. */
export function describe(ref) {
  const bits = [];
  if (ref.comp) bits.push(ref.comp);
  bits.push(`<${ref.tag}${ref.role ? ` role=${ref.role}` : ""}>`);
  const words = ref.text || ref.label;
  if (words) bits.push(JSON.stringify(words.length > 32 ? `${words.slice(0, 31)}…` : words));
  return bits.join(" ");
}

/** Index the records into a tree: children lists and subtree ends (records are DOM pre-order). */
export function buildTree(records) {
  const children = records.map(() => []);
  const roots = [];
  for (const r of records) {
    if (r.p >= 0 && r.p < records.length) children[r.p].push(r.i);
    else roots.push(r.i);
  }
  const end = new Array(records.length);
  for (let k = records.length - 1; k >= 0; k--) {
    const kids = children[k];
    end[k] = kids.length ? end[kids[kids.length - 1]] : k;
  }
  return { children, roots, end };
}

function isIconRecord(r, tol) {
  // Glyphs are roughly square: a wordmark or a wide mark is not an icon box.
  return !!r.icon && r.w <= tol.maxIconSize && r.h <= tol.maxIconSize && Math.max(r.w, r.h) <= 1.34 * Math.min(r.w, r.h);
}

/**
 * Library and framework wrappers that are not useful as "the component this
 * element belongs to". The collector skips most of them while walking React's
 * tree; this list is applied again here so a saved run re-scored later gets
 * the current list too.
 */
export const GENERIC_COMPONENT = /^(.*Slot(\..*)?|SlotClone|Slottable|.*CollectionSlot.*|RovingFocusGroup.*|Primitive(\..*)?|Presence|Portal|DismissableLayer|FocusScope|Popper.*|Menu|MenuSub|DropdownMenu|DropdownMenuSub|Popover|Tooltip|Dialog|AlertDialog|HoverCard|ContextMenu|Collapsible|Sheet|Select|MotionConfig|motion\..*|LinkComponent|Link|(Tooltip|DropdownMenu|Popover|Dialog|AlertDialog|HoverCard|ContextMenu|Collapsible|Sheet)Trigger|.*Provider|.*Context|.*Boundary)$/;

/** Is this inline box part of a sentence? Climb inline ancestors (spans) up to the block holding them. */
function inRunningText(records, r) {
  let k = r.p;
  for (let hops = 0; k >= 0 && hops < 4; hops++) {
    const a = records[k];
    if (a.txt) return true;
    if (!/^inline/.test(a.disp || "")) return false;
    k = a.p;
  }
  return false;
}

/**
 * Records with `comp` re-derived against GENERIC_COMPONENT, and `inline` set
 * on any interactive inline-level box whose parent holds running text (a
 * citation chip in a sentence is not a standalone control). Inputs are not
 * mutated.
 */
export function normalizeRecords(records) {
  return records.map((r) => {
    let next = r;
    if (r.comp && GENERIC_COMPONENT.test(r.comp)) {
      const comps = (r.comps || []).filter((n) => !GENERIC_COMPONENT.test(n));
      next = { ...next, comps };
      if (comps.length) next.comp = comps[0];
      else delete next.comp;
    }
    if (r.kind && !r.inline && /^inline/.test(r.disp || "") && inRunningText(records, r)) next = { ...next, inline: true };
    return next;
  });
}

function isControl(r) {
  return !!r.kind && r.kind !== "clickable";
}

/** True for controls whose height is a control height. */
export function isHeightControl(r, tol = DEFAULT_TOLERANCES) {
  if (!r.kind || !HEIGHT_KINDS.has(r.kind) || r.inline) return false;
  if (r.h > tol.maxControlHeight) return false;
  if (r.kind === "link") {
    // A bare block link (a card title, a footer link) is text, not a control:
    // only links drawn as rows or buttons (padding or paint) have a height.
    const padded = (r.pad[1] || 0) > 0 || (r.pad[3] || 0) > 0;
    if (!padded && !r.paint) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The checks

/**
 * Collect the measured values of one record, per property. Values are
 * de-duplicated per element (`p-4` is one 16, not four).
 */
export function measuredValues(r, ctx) {
  const tol = ctx.tol;
  const out = [];
  const add = (property, value, extra = {}) => out.push({ property, value: round2(value), ...extra });
  const uniq = (list) => [...new Set(list.map((v) => round2(v)))];

  const padSides = r.pad || [0, 0, 0, 0];
  const bw = r.bw || [0, 0, 0, 0];
  const seenPad = new Set();
  // A side that makes room for an overlaid glyph (the search icon drawn over
  // a field) is derived: inset + glyph + gap. The gap is the value to judge.
  const overlay = ctx.overlays?.get(r.i);
  if (overlay) {
    const leadGap = overlay.lead !== null ? r.x + (bw[3] || 0) + padSides[3] - overlay.lead : null;
    const trailGap = overlay.trail !== null ? overlay.trail - (r.x + r.w - (bw[1] || 0) - padSides[1]) : null;
    if (leadGap !== null && padSides[3] > 0 && leadGap >= 0 && leadGap <= tol.maxIconGap) add("icon-text-gap", leadGap, { derived: "left padding" });
    if (trailGap !== null && padSides[1] > 0 && trailGap >= 0 && trailGap <= tol.maxIconGap) add("icon-text-gap", trailGap, { derived: "right padding" });
  }
  padSides.forEach((v, side) => {
    if (!(v > 0)) return;
    if (overlay && ((side === 3 && overlay.lead !== null) || (side === 1 && overlay.trail !== null))) return;
    const key = `${round2(v)}|${round2(bw[side] || 0)}`;
    if (seenPad.has(key)) return;
    seenPad.add(key);
    add("padding", v, { border: round2(bw[side] || 0) });
  });
  if (r.mar) for (const v of uniq(r.mar.filter((m) => m !== null && m !== 0).map((m) => Math.abs(m)))) add("margin", v);
  if (r.gap && (ctx.flowChildren?.[r.i] ?? 2) >= 2) {
    const [row, col] = r.gap;
    const vals = [];
    if (row !== null && row > 0) vals.push(row);
    if (col !== null && col > 0) vals.push(col);
    for (const v of uniq(vals)) add("gap", v);
  }
  if (r.ig) for (const v of uniq(r.ig.filter((g) => g !== null && g >= 0 && g <= tol.maxIconGap))) add("icon-text-gap", v);

  const eff = effectiveRadii(r.rad || [0, 0, 0, 0], r.w, r.h);
  const radVals = new Map();
  eff.forEach((v) => {
    if (!(v > 0)) return;
    const full = isFullRadius(v, r.w, r.h);
    const key = full ? "full" : String(round2(v));
    if (!radVals.has(key)) radVals.set(key, { v, full });
  });
  const concentric = !!ctx.concentric?.has(r.i);
  if (r.paint || r.clip) for (const { v, full } of radVals.values()) add("radius", v, { full, concentric, pct: round2((v / Math.max(1, Math.min(r.w, r.h))) * 100) });

  if (r.bw) for (const v of uniq(r.bw.filter((b) => b > 0))) add("border-width", v);
  if (isHeightControl(r, tol)) add("control-height", r.h, { kind: r.kind });
  if (r.txt && r.fs) {
    add("font-size", r.fs);
    if (r.lh) add("line-height", r.lh);
  }
  if (isIconRecord(r, tol)) for (const v of uniq([r.w, r.h])) add("icon-size", v);
  return out;
}

/** Is a measured value on its scale? Returns { scored, on, nearest, delta }. */
export function judgeValue(m, scales, tol = DEFAULT_TOLERANCES) {
  const t = tol.scale;
  switch (m.property) {
    case "padding": {
      const on = isOnScale(m.value, scales.spacing, t) || (m.border > 0 && isOnScale(m.value + m.border, scales.spacing, t));
      const n = nearestRung(m.value, scales.spacing);
      return { scored: true, on, nearest: n.rung, delta: n.delta };
    }
    case "margin":
    case "gap":
    case "icon-text-gap": {
      const n = nearestRung(m.value, scales.spacing);
      return { scored: true, on: isOnScale(m.value, scales.spacing, t), nearest: n.rung, delta: n.delta };
    }
    case "radius": {
      if (m.full) return { scored: true, on: true, nearest: "full", delta: 0 };
      // Derived from the ladder by the concentric rule (rounded-inner): on scale by construction.
      if (m.concentric) return { scored: true, on: true, nearest: "concentric", delta: 0 };
      const percentOk = (scales.radiusPercent || []).some((p) => Math.abs(p - m.pct) <= tol.radiusPercent);
      const n = nearestRung(m.value, scales.radius);
      return { scored: true, on: percentOk || isOnScale(m.value, scales.radius, t), nearest: n.rung, delta: n.delta };
    }
    case "control-height": {
      const n = nearestRung(m.value, scales.controlHeight);
      return { scored: true, on: isOnScale(m.value, scales.controlHeight, t), nearest: n.rung, delta: n.delta };
    }
    case "icon-size": {
      const n = nearestRung(m.value, scales.iconSize);
      return { scored: true, on: isOnScale(m.value, scales.iconSize, t), nearest: n.rung, delta: n.delta };
    }
    default:
      return { scored: false, on: true, nearest: null, delta: 0 };
  }
}

export const SCORED_GROUPS = {
  padding: "spacing",
  margin: "spacing",
  gap: "spacing",
  "icon-text-gap": "spacing",
  radius: "radius",
  "control-height": "controlHeight",
  "icon-size": "iconSize",
};

/** Measured distances between consecutive in-flow siblings (histogram only). */
export function siblingDistances(records, tree) {
  const out = [];
  for (const kids of tree.children) {
    const flow = kids.map((k) => records[k]).filter(inFlow);
    for (let k = 1; k < flow.length; k++) {
      const a = flow[k - 1];
      const b = flow[k];
      if (horizontalOverlap(a, b) > 0 && b.y >= a.y + a.h - 0.5) out.push({ axis: "y", value: half(b.y - (a.y + a.h)), i: b.i });
      else if (verticalOverlap(a, b) > 0 && b.x >= a.x + a.w - 0.5) out.push({ axis: "x", value: half(b.x - (a.x + a.w)), i: b.i });
    }
  }
  return out;
}

function nearestVisualParent(records, r) {
  let k = r.p;
  while (k >= 0) {
    const a = records[k];
    if (a.paint || a.clip) return a;
    k = a.p;
  }
  return null;
}

/** Nested radii: every painted child against the painted or clipping box around it. */
export function checkNestedRadius(records, ctx) {
  const tol = ctx.tol;
  const findings = [];
  const checked = new Set();
  const concentric = new Set();
  for (const r of records) {
    if (!r.paint) continue;
    const parent = nearestVisualParent(records, r);
    if (!parent) continue;
    const pr = effectiveRadii(parent.rad || [0, 0, 0, 0], parent.w, parent.h);
    if (!pr.some((v) => v > 0)) continue;
    // Same fill as the parent, nothing else painted: the corner is invisible.
    if (r.paint === "b" && parent.bg && r.bg === parent.bg) continue;
    const cr = effectiveRadii(r.rad || [0, 0, 0, 0], r.w, r.h);
    const insets = cornerInsets(r, parent);
    // Circles (avatars, round icon buttons) and small pills (switches, chips,
    // badges) have an intrinsic shape: they may be rounder than concentric.
    const allFull = cr.every((v) => isFullRadius(v, r.w, r.h));
    const circle = allFull && (Math.abs(r.w - r.h) <= 1 || r.h <= 24);
    let worst = null;
    let any = false;
    let exact = true;
    const pbw = parent.bw || [0, 0, 0, 0];
    // [horizontal, vertical] border at each corner: tl, tr, br, bl
    const cornerBorders = [
      [pbw[3], pbw[0]],
      [pbw[1], pbw[0]],
      [pbw[1], pbw[2]],
      [pbw[3], pbw[2]],
    ];
    insets.forEach((ins, corner) => {
      const j = judgeCorner({ parentRadius: pr[corner], childRadius: cr[corner], dx: ins.dx, dy: ins.dy, parentClips: !!parent.clip, parentBorder: cornerBorders[corner], circle, tol: tol.nestedRadius, pokeTol: tol.pokeOut });
      if (!j.applicable) return;
      any = true;
      if (!(cr[corner] > 0 && Math.abs(j.delta) <= tol.scale)) exact = false;
      if (j.verdict === "ok") return;
      const magnitude = j.verdict === "poke-out" || j.verdict === "clipped-corner" ? j.poke : Math.abs(j.delta);
      if (!worst || magnitude > worst.magnitude) worst = { corner, ...j, magnitude, parentRadius: pr[corner], childRadius: cr[corner], dx: ins.dx, dy: ins.dy };
    });
    if (!any) continue;
    checked.add(r.i);
    checked.add(parent.i);
    if (exact) concentric.add(r.i);
    if (!worst) continue;
    const cornerName = ["top-left", "top-right", "bottom-right", "bottom-left"][worst.corner];
    let kind;
    let message;
    if (worst.verdict === "poke-out") {
      kind = "corner-poke-out";
      message = `${cornerName} corner (r ${fmt(worst.childRadius)}) sits ${fmt(worst.dx)}/${fmt(worst.dy)} px inside a ${fmt(worst.parentRadius)} px parent and pokes ${fmt(worst.poke)} px past its curve`;
    } else if (worst.verdict === "clipped-corner") {
      kind = "clipped-corner";
      message = `${cornerName} corner (r ${fmt(worst.childRadius)}) inset ${fmt(worst.dx)}/${fmt(worst.dy)} px is cut ${fmt(worst.poke)} px by the parent's ${fmt(worst.parentRadius)} px clip`;
    } else {
      kind = "nested-radius";
      message = `${cornerName} radius ${fmt(worst.childRadius)} inside ${fmt(worst.parentRadius)} at inset ${fmt(worst.inset)}: concentric is ${fmt(worst.expected)} (${worst.verdict}, ${worst.delta > 0 ? "+" : ""}${fmt(worst.delta)} px)`;
    }
    const magnitude = worst.magnitude;
    const severity = kind === "nested-radius" ? (magnitude >= 6 ? 3 : magnitude >= 3 ? 2 : 1) : magnitude >= 2 ? 3 : 2;
    findings.push({
      kind,
      severity,
      magnitude: round2(magnitude),
      message,
      el: r.i,
      related: [parent.i],
      values: { corner: cornerName, parentRadius: worst.parentRadius, childRadius: worst.childRadius, dx: worst.dx, dy: worst.dy, expected: worst.expected, delta: worst.delta, poke: worst.poke, parentClips: !!parent.clip },
    });
  }
  return { findings, checked, concentric };
}

function subtreeHasText(records, tree, r) {
  for (let k = r.i; k <= tree.end[r.i]; k++) if (records[k].txt) return true;
  return false;
}

/** An icon, or a wrapper holding only an icon (no text anywhere inside). */
function iconish(records, tree, r, tol) {
  if (isIconRecord(r, tol)) return true;
  if (subtreeHasText(records, tree, r)) return false;
  return tree.children[r.i].some((k) => isIconRecord(records[k], tol));
}

/**
 * An out-of-flow glyph drawn over a control: an icon, an icon button, or a
 * wrapper holding one (the password field's eye toggle in its positioned
 * div). Returns the glyph's own box, or null.
 */
function overlayGlyph(records, tree, o, tol) {
  if (inFlow(o)) return null;
  if (isIconRecord(o, tol)) return o;
  if (subtreeHasText(records, tree, o)) return null;
  for (let k = o.i + 1; k <= tree.end[o.i]; k++) if (isIconRecord(records[k], tol)) return records[k];
  return o.kind === "button" ? o : null;
}

const squarishBox = (r, max = 32) => r.w <= max && r.h <= max && Math.max(r.w, r.h) <= 1.34 * Math.min(r.w, r.h);

/**
 * A control's leading or trailing "media": an icon, a small square tile that
 * paints (avatar, favicon, letter tile) or a stack of such tiles. Padding is
 * trimmed beside these for the same optical reason as beside an icon.
 */
function mediaEdge(records, tree, r, tol) {
  if (iconish(records, tree, r, tol)) return true;
  if (squarishBox(r) && (r.paint || r.tag === "img")) return true;
  const kids = tree.children[r.i].map((k) => records[k]);
  return r.h <= 32 && kids.length > 0 && kids.every((k) => squarishBox(k));
}

/** Icons on a control's sides: flow icons (from the collector) and overlay icons drawn over it. */
function iconSides(records, tree, r, ctx) {
  const tol = ctx.tol;
  const sides = { leadFlow: false, trailFlow: false, leadOverlay: false, trailOverlay: false };
  if (r.ig) {
    if (r.ig[0] !== null && r.ig[0] !== undefined) sides.leadFlow = true;
    if (r.ig[1] !== null && r.ig[1] !== undefined) sides.trailFlow = true;
  }
  const kids = tree.children[r.i].map((k) => records[k]);
  const flowKids = kids.filter(inFlow);
  if (flowKids.length >= 2) {
    if (mediaEdge(records, tree, flowKids[0], tol)) sides.leadFlow = true;
    if (mediaEdge(records, tree, flowKids[flowKids.length - 1], tol)) sides.trailFlow = true;
  }
  // Overlays: absolutely positioned icons (or icon buttons) drawn over the
  // control, as a child or as a sibling (the search glyph over an input).
  const cx = r.x + r.w / 2;
  const siblings = r.p >= 0 ? tree.children[r.p].map((k) => records[k]) : [];
  for (const o of [...kids, ...siblings]) {
    if (o.i === r.i) continue;
    const glyph = overlayGlyph(records, tree, o, tol);
    if (!glyph || verticalOverlap(glyph, r) <= 0 || horizontalOverlap(glyph, r) <= 0) continue;
    if (glyph.x + glyph.w / 2 < cx) sides.leadOverlay = true;
    else sides.trailOverlay = true;
  }
  return sides;
}

/**
 * Overlaid glyphs on a field: the right edge of one drawn over its leading
 * side and the left edge of one over its trailing side (null when none).
 */
export function overlayIconEdges(records, tree, r, tol = DEFAULT_TOLERANCES) {
  const out = { lead: null, trail: null };
  const kids = tree.children[r.i].map((k) => records[k]);
  const siblings = r.p >= 0 ? tree.children[r.p].map((k) => records[k]) : [];
  const cx = r.x + r.w / 2;
  for (const o of [...kids, ...siblings]) {
    if (o.i === r.i) continue;
    const g = overlayGlyph(records, tree, o, tol);
    if (!g || verticalOverlap(g, r) <= 0 || horizontalOverlap(g, r) < Math.min(g.w, 4)) continue;
    if (g.x + g.w / 2 < cx) out.lead = out.lead === null ? g.x + g.w : Math.max(out.lead, g.x + g.w);
    else out.trail = out.trail === null ? g.x : Math.min(out.trail, g.x);
  }
  return out;
}

/** Asymmetric padding on controls that should be symmetric. */
export function checkAsymmetry(records, tree, ctx) {
  const tol = ctx.tol;
  const findings = [];
  const notes = [];
  const checked = new Set();
  for (const r of records) {
    if (!r.kind || !SYMMETRIC_KINDS.has(r.kind) || r.inline) continue;
    if (!isHeightControl(r, tol) && r.kind !== "input" && r.kind !== "select") continue;
    const [t, rt, b, l] = r.pad;
    // A row link that paints nothing at rest is the text area of a row whose
    // visible box is its container; its padding split is not what the eye
    // sees. Links and rows are judged when they paint (the selected row does).
    if ((r.kind === "link" || r.kind === "row") && !r.paint) continue;
    checked.add(r.i);
    const sides = iconSides(records, tree, r, ctx);
    const dxPad = round2(l - rt);
    if (Math.abs(dxPad) > tol.symmetry) {
      // Smaller padding on the side a flow icon sits is the optical trim;
      // larger padding on the side an overlay icon sits is the room it needs.
      const smallerLeft = dxPad < 0;
      const optical = (smallerLeft && sides.leadFlow) || (!smallerLeft && sides.trailFlow);
      const room = (!smallerLeft && sides.leadOverlay) || (smallerLeft && sides.trailOverlay);
      if (optical || room) {
        notes.push({ kind: "asymmetric-padding", reason: optical ? "optical trim beside an icon" : "room for an overlaid icon", el: r.i, values: { left: l, right: rt } });
      } else {
        const magnitude = Math.abs(dxPad);
        findings.push({ kind: "asymmetric-padding", severity: magnitude >= 4 ? 2 : 1, magnitude, message: `${r.kind} padding left ${fmt(l)} / right ${fmt(rt)}`, el: r.i, related: [], values: { axis: "x", left: l, right: rt } });
      }
    }
    const dyPad = round2(t - b);
    if (Math.abs(dyPad) > tol.symmetry && r.kind !== "textarea") {
      const magnitude = Math.abs(dyPad);
      findings.push({ kind: "asymmetric-padding", severity: magnitude >= 4 ? 2 : 1, magnitude, message: `${r.kind} padding top ${fmt(t)} / bottom ${fmt(b)}`, el: r.i, related: [], values: { axis: "y", top: t, bottom: b } });
    }
  }
  return { findings, notes, checked };
}

const SCOPE_ROLES = new Set(["menu", "menubar", "listbox", "tablist", "radiogroup", "toolbar", "tree", "grid", "list", "navigation", "group"]);

/**
 * Per record: does its subtree hold any text? (icon-only buttons are a
 * different kind from labelled ones). Records are in pre-order, so one
 * backwards pass carries each flag up to every ancestor.
 */
export function textFlags(records) {
  const flags = new Array(records.length).fill(false);
  for (let k = records.length - 1; k >= 0; k--) {
    if (records[k].txt) flags[k] = true;
    if (flags[k] && records[k].p >= 0) flags[records[k].p] = true;
  }
  return flags;
}

function familyKey(r, hasText) {
  const h = r.hooks || {};
  return [r.tag, r.role || "", r.kind || "", r.comp || "", h["data-variant"] || "", h["data-size"] || "", h["data-slot"] || "", h["data-part"] || "", r.disp, hasText ? "text" : "glyph"].join("|");
}

function scopeOf(records, r) {
  let k = r.p;
  let hops = 0;
  while (k >= 0 && hops < 4) {
    const a = records[k];
    if (a.role && SCOPE_ROLES.has(a.role) && a.role !== "group") return a.i;
    k = a.p;
    hops++;
  }
  return r.p;
}

/**
 * Siblings of the same kind (menu items in one menu, rows in one list, cards
 * in one grid) should share their padding and their corner radius. Group by scope + family; report
 * the members that differ from the group's most common padding.
 */
export function checkSiblingPadding(records, tree, ctx) {
  const findings = [];
  const checked = new Set();
  const groups = new Map();
  const hasText = textFlags(records);
  for (const r of records) {
    if (r.p < 0 || !inFlow(r)) continue;
    const parent = records[r.p];
    const gridish = /grid|flex/.test(parent.disp || "") && !!r.paint;
    const item = isControl(r) || r.role === "listitem" || r.tag === "li" || gridish;
    if (!item || r.inline) continue;
    if (r.kind === "link" && !(r.pad[1] > 0 || r.pad[3] > 0) && !r.paint) continue;
    const key = `${scopeOf(records, r)}#${familyKey(r, hasText[r.i])}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  // Each group should share one padding and one corner shape; members that
  // differ from the most common value (ties: the lexically first) are flagged.
  const commonOf = (members, sig) => {
    const counts = new Map();
    for (const m of members) counts.set(sig(m), (counts.get(sig(m)) || 0) + 1);
    let common = null;
    let commonCount = -1;
    for (const [value, count] of [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
      if (count > commonCount) {
        common = value;
        commonCount = count;
      }
    }
    return { common, commonCount, distinct: counts.size };
  };
  const radiiOf = (m) => effectiveRadii(m.rad || [0, 0, 0, 0], m.w, m.h).map((v) => (isFullRadius(v, m.w, m.h) ? Infinity : v));
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    for (const m of members) checked.add(m.i);

    const padSig = (m) => m.pad.map((v) => half(v)).join(" ");
    const pad = commonOf(members, padSig);
    if (pad.distinct > 1) {
      const reference = members.find((m) => padSig(m) === pad.common);
      for (const m of members) {
        if (padSig(m) === pad.common) continue;
        const magnitude = round2(Math.max(...m.pad.map((v, k) => Math.abs(v - reference.pad[k]))));
        if (magnitude <= ctx.tol.sibling) continue;
        findings.push({
          kind: "sibling-padding",
          severity: magnitude >= 4 ? 2 : 1,
          magnitude,
          message: `padding ${m.pad.map(fmt).join(" ")} where ${pad.commonCount} of ${members.length} siblings use ${reference.pad.map(fmt).join(" ")}`,
          el: m.i,
          related: [reference.i],
          values: { padding: m.pad, common: reference.pad, members: members.length },
        });
      }
    }

    const radSig = (m) => radiiOf(m).map((v) => (v === Infinity ? "full" : half(v))).join(" ");
    const rad = commonOf(members, radSig);
    if (rad.distinct > 1) {
      const reference = members.find((m) => radSig(m) === rad.common);
      const refRadii = radiiOf(reference);
      for (const m of members) {
        if (radSig(m) === rad.common) continue;
        const mine = radiiOf(m);
        const diffs = mine.map((v, k) => (v === refRadii[k] ? 0 : v === Infinity || refRadii[k] === Infinity ? 8 : Math.abs(v - refRadii[k])));
        const magnitude = round2(Math.max(...diffs));
        if (magnitude <= ctx.tol.sibling) continue;
        const show = (list) => [...new Set(list.map((v) => (v === Infinity ? "full" : fmt(v))))].join("/");
        findings.push({
          kind: "sibling-radius",
          severity: magnitude >= 4 ? 2 : 1,
          magnitude,
          message: `radius ${show(mine)} where ${rad.commonCount} of ${members.length} siblings use ${show(refRadii)}`,
          el: m.i,
          related: [reference.i],
          values: { radius: mine.map((v) => (v === Infinity ? "full" : v)), common: refRadii.map((v) => (v === Infinity ? "full" : v)), members: members.length },
        });
      }
    }
  }
  return { findings, checked };
}

/**
 * The outermost visual box of each control: a painted field shell around an
 * input, a segmented control's track around its segments.
 */
export function rowItems(records, tree, ctx) {
  const tol = ctx.tol;
  const isCandidate = new Array(records.length).fill(false);
  for (const r of records) {
    if (r.kind && ROW_KINDS.has(r.kind) && isHeightControl(r, tol)) isCandidate[r.i] = true;
  }
  // Shells: painted boxes no taller than a control that hold one field (plus
  // at most two glyph buttons: clear, submit) and are mostly that field, or
  // that hold a set of segments. A toolbar with a field and labelled buttons
  // is not a shell: its buttons stay in the row check.
  const hasText = textFlags(records);
  for (const r of records) {
    if (!r.paint || r.h > tol.maxControlHeight || r.kind) continue;
    const desc = [];
    for (let k = r.i + 1; k <= tree.end[r.i]; k++) if (records[k].kind) desc.push(records[k]);
    if (!desc.length) continue;
    const fields = desc.filter((d) => d.kind === "input" || d.kind === "select" || d.kind === "textarea");
    const others = desc.filter((d) => !fields.includes(d));
    const fieldShell = fields.length === 1 && fields[0].w >= 0.5 * r.w && others.length <= 2 && others.every((d) => !hasText[d.i]);
    const segments = desc.filter((d) => d.kind === "tab" || d.kind === "radio" || (d.kind === "button" && d.sel !== undefined && d.sel !== null));
    const segmentRole = r.role === "tablist" || r.role === "radiogroup";
    if (fieldShell || segmentRole || (segments.length >= 2 && segments.length === desc.length)) {
      isCandidate[r.i] = true;
      for (const d of desc) isCandidate[d.i] = false;
    }
  }
  // Keep the outermost candidate of any nest.
  const items = [];
  for (const r of records) {
    if (!isCandidate[r.i]) continue;
    let k = r.p;
    let nested = false;
    while (k >= 0) {
      if (isCandidate[k]) {
        nested = true;
        break;
      }
      k = records[k].p;
    }
    if (!nested) items.push(r);
  }
  return items;
}

/** Controls sharing a row inside one container should share a height. */
export function checkRowHeights(records, tree, ctx) {
  const tol = ctx.tol;
  const items = rowItems(records, tree, ctx);
  const itemSet = new Set(items.map((r) => r.i));
  const hasText = textFlags(records);
  const findings = [];
  const notes = [];
  const checked = new Set();
  const reported = new Set();
  const decided = new Set();
  // Outermost containers first: a control's verdict comes from the widest row
  // it sits in (the whole composer bar, not a two-button corner of it), and a
  // control is judged once.
  const containers = records.filter((r) => tree.children[r.i].length >= 2);
  for (const c of containers) {
    const members = [];
    for (let k = c.i + 1; k <= tree.end[c.i]; k++) {
      if (!itemSet.has(k)) continue;
      // Controls nest at different depths (a composer's + sits two levels up
      // from its model chip): look up to rowDepth wrappers down.
      let depth = 0;
      let a = records[k].p;
      while (a !== c.i && a >= 0 && depth <= tol.rowDepth) {
        a = records[a].p;
        depth++;
      }
      if (a === c.i && depth <= tol.rowDepth) members.push(records[k]);
    }
    if (members.length < 2) continue;
    // Group into visual rows by shared vertical centre.
    const rows = [];
    for (const m of members.slice().sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2) || a.x - b.x || a.i - b.i)) {
      const mid = m.y + m.h / 2;
      const row = rows.find((rw) => Math.abs(rw.mid - mid) <= 2);
      if (row) row.items.push(m);
      else rows.push({ mid, items: [m] });
    }
    // A row is a cluster of side-by-side controls: a gap wider than rowGap
    // starts a new cluster (the + at a composer's far left is not part of the
    // controls cluster at its right; a sidebar row is not part of the composer).
    const clusters = [];
    for (const row of rows) {
      const sorted = row.items.slice().sort((a, b) => a.x - b.x || a.i - b.i);
      let current = [];
      for (const m of sorted) {
        const prev = current[current.length - 1];
        if (prev && m.x - (prev.x + prev.w) > tol.rowGap) {
          clusters.push(current);
          current = [];
        }
        current.push(m);
      }
      clusters.push(current);
    }
    for (const sorted of clusters) {
      if (sorted.length < 2) continue;
      // Not wrapped in a column: they must sit side by side.
      const sideBySide = sorted.every((m, k) => k === 0 || m.x >= sorted[k - 1].x + sorted[k - 1].w - 1);
      if (!sideBySide) continue;
      for (const m of sorted) checked.add(m.i);
      const heights = sorted.map((m) => half(m.h));
      const distinct = [...new Set(heights)];
      if (distinct.length < 2 || Math.max(...heights) - Math.min(...heights) <= tol.rowHeight) continue;
      // One finding per odd control out.
      const byHeight = new Map();
      for (const m of sorted) {
        const k = half(m.h);
        const e = byHeight.get(k) || { n: 0, w: 0 };
        e.n++;
        e.w += m.w;
        byHeight.set(k, e);
      }
      // The row's height is the one that covers the most width (the dominant
      // controls), then the most controls: three 16px glyph buttons do not
      // make a 36px field the odd one out.
      const common = [...byHeight.entries()].sort((a, b) => b[1].w - a[1].w || b[1].n - a[1].n || a[0] - b[0])[0][0];
      const fresh = sorted.filter((m) => !decided.has(m.i));
      for (const m of sorted) decided.add(m.i);
      for (const m of fresh) {
        if (Math.abs(m.h - common) <= tol.rowHeight || reported.has(m.i)) continue;
        reported.add(m.i);
        // A smaller icon-only control beside a wide labelled row (the chevron
        // or + at a list row's end) is the row's accessory, not its peer.
        const row = sorted.find((x) => x !== m && x.h > m.h && x.w >= 4 * x.h && hasText[x.i]);
        if (!hasText[m.i] && row) {
          notes.push({ kind: "row-height", reason: "icon accessory smaller than the row beside it", el: m.i, values: { height: round2(m.h), row: round2(row.h) } });
          continue;
        }
        const magnitude = round2(Math.abs(m.h - common));
        findings.push({
          kind: "row-height",
          severity: magnitude >= 4 ? 3 : 2,
          magnitude,
          message: `${fmt(m.h)} px tall in a row of ${fmt(common)} px controls (${sorted.map((x) => fmt(x.h)).join(" / ")})`,
          el: m.i,
          related: sorted.filter((x) => x.i !== m.i).map((x) => x.i),
          values: { height: round2(m.h), heights: sorted.map((x) => round2(x.h)), common, container: c.i },
        });
      }
    }
  }
  return { findings, notes, checked };
}

function isColumn(kids) {
  if (kids.length < 2) return false;
  const sorted = kids.slice().sort((a, b) => a.y - b.y || a.i - b.i);
  for (let k = 1; k < sorted.length; k++) if (sorted[k].y < sorted[k - 1].y + sorted[k - 1].h - 1) return false;
  return true;
}

function firstTextIn(records, tree, r) {
  for (let k = r.i; k <= tree.end[r.i]; k++) {
    const d = records[k];
    if (d.txt && d.tl !== null && d.tl !== undefined) {
      const ta = d.ta || "start";
      const rtl = d.dir === "rtl";
      const startAligned = rtl ? ta === "start" || ta === "right" || ta === "end" : ta === "start" || ta === "left" || ta === "justify";
      if (!startAligned) return null;
      if (rtl) return { value: d.tr, i: d.i };
      return { value: d.tl, i: d.i };
    }
  }
  return null;
}

/**
 * In each column container, the first text of each child should either share
 * a left edge with its neighbours or sit clearly apart from them. Edges 1-3 px
 * apart are near misses: they read as a mistake, not an indent.
 */
export function checkAlignment(records, tree, ctx) {
  const tol = ctx.tol;
  const findings = [];
  const notes = [];
  const checked = new Set();
  const reported = new Set();
  for (const c of records) {
    const kids = tree.children[c.i].map((k) => records[k]).filter(inFlow);
    if (!isColumn(kids)) continue;
    const texts = [];
    for (const kid of kids) {
      const t = firstTextIn(records, tree, kid);
      if (t) texts.push(t);
    }
    if (texts.length < 2) continue;
    const values = texts.map((t) => t.value);
    for (const cluster of clusterValues(values, tol.alignMax)) {
      if (cluster.length < 2) continue;
      for (const k of cluster) checked.add(texts[k].i);
      const vals = cluster.map((k) => values[k]);
      const spread = Math.max(...vals) - Math.min(...vals);
      if (spread <= tol.alignMin) continue;
      const mode = modeOf(vals);
      const anchor = cluster.find((k) => Math.abs(values[k] - mode) <= tol.alignMin) ?? cluster[0];
      for (const k of cluster) {
        const off = round2(values[k] - values[anchor]);
        if (Math.abs(off) <= tol.alignMin) continue;
        const a = texts[k].i;
        const b = texts[anchor].i;
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        if (reported.has(key)) continue;
        reported.add(key);
        // Display type is often pulled a px or two so its ink, not its
        // advance box, lines up with the body: that is optical, not a miss.
        const fa = records[a].fs || 0;
        const fb = records[b].fs || 0;
        if (fa && fb && Math.max(fa, fb) / Math.min(fa, fb) >= 1.5) {
          notes.push({ kind: "text-misalignment", reason: "optical offset between display and body type", el: a, values: { offset: off, fontSizes: [fa, fb] } });
          continue;
        }
        findings.push({
          kind: "text-misalignment",
          severity: 2,
          magnitude: Math.abs(off),
          message: `text starts ${off > 0 ? "+" : ""}${fmt(off)} px from the edge its column shares (${fmt(values[anchor])})`,
          el: a,
          related: [b],
          values: { offset: off, edge: round2(values[anchor]), container: c.i },
        });
      }
    }
  }
  return { findings, notes, checked };
}

/** Icon-to-text gaps should be one value within a component family. */
export function checkIconGaps(records, ctx) {
  const tol = ctx.tol;
  const findings = [];
  const checked = new Set();
  const families = new Map();
  const hasText = textFlags(records);
  for (const r of records) {
    if (!r.ig) continue;
    for (const [side, gap] of [["lead", r.ig[0]], ["trail", r.ig[1]]]) {
      if (gap === null || gap === undefined || gap < 0 || gap > tol.maxIconGap) continue;
      const key = `${side}|${familyKey(r, hasText[r.i])}`;
      if (!families.has(key)) families.set(key, []);
      families.get(key).push({ r, gap });
    }
  }
  for (const [key, members] of families) {
    if (members.length < 2) continue;
    for (const m of members) checked.add(m.r.i);
    const gaps = members.map((m) => m.gap);
    const common = modeOf(gaps);
    const offs = members.filter((m) => Math.abs(m.gap - common) > tol.iconGap);
    if (!offs.length) continue;
    const side = key.split("|")[0];
    for (const m of offs) {
      const magnitude = round2(Math.abs(m.gap - common));
      findings.push({
        kind: "icon-gap",
        severity: magnitude >= 3 ? 2 : 1,
        magnitude,
        message: `${side === "lead" ? "icon-to-text" : "text-to-icon"} gap ${fmt(m.gap)} where its family uses ${fmt(common)} (${members.length} members)`,
        el: m.r.i,
        related: [],
        values: { side, gap: m.gap, common, members: members.length },
      });
    }
  }
  return { findings, checked };
}

/** Pointer and touch targets. */
export function checkTargets(records, ctx) {
  const tol = ctx.tol;
  const size = ctx.phone ? tol.targetTouch : tol.targetPointer;
  const findings = [];
  const notes = [];
  const checked = new Set();
  const targets = records.filter((r) => r.inter && !r.inline && !r.disabled && !r.covered);
  const boxes = targets.map((r) => {
    const w = r.tgt ? Math.max(r.w, r.tgt[0]) : r.w;
    const h = r.tgt ? Math.max(r.h, r.tgt[1]) : r.h;
    return { r, x: r.x + r.w / 2 - w / 2, y: r.y + r.h / 2 - h / 2, w, h };
  });
  // Nested interactive elements (an icon button inside a clickable row) are
  // judged on their own box, but the outer one is not "another target" that
  // the spacing exception has to clear.
  for (const box of boxes) {
    const r = box.r;
    checked.add(r.i);
    if (box.w >= size - 0.01 && box.h >= size - 0.01) continue;
    const others = boxes.filter((o) => o !== box && !contains(o, box, 0.5) && !contains(box, o, 0.5));
    if (!ctx.phone && spacingExceptionOk(box, others, size)) {
      notes.push({ kind: "target-size", reason: "undersized but spaced (WCAG 2.5.8 spacing exception)", el: r.i, values: { w: round2(box.w), h: round2(box.h) } });
      continue;
    }
    const shortfall = round2(size - Math.min(box.w, box.h));
    findings.push({
      kind: "target-size",
      severity: shortfall >= 8 ? 3 : 2,
      magnitude: shortfall,
      message: `${r.kind || "interactive"} target ${fmt(box.w)}×${fmt(box.h)} under the ${size} px ${ctx.phone ? "touch" : "pointer"} minimum`,
      el: r.i,
      related: [],
      values: { w: round2(box.w), h: round2(box.h), min: size },
    });
  }
  return { findings, notes, checked };
}

// ---------------------------------------------------------------------------
// Route analysis, ranking and scoring

/**
 * @param {{
 *   scales?: { spacing?: number[], radius?: number[], radiusPercent?: number[], controlHeight?: number[], iconSize?: number[] },
 *   tolerances?: Partial<Record<keyof typeof DEFAULT_TOLERANCES, number>>,
 *   viewport?: { width: number, height: number },
 * }} [options]
 */
export function makeContext({ scales, tolerances = {}, viewport = { width: 1440, height: 900 } } = {}) {
  return {
    scales: {
      spacing: scales?.spacing || DEFAULT_SPACING_SCALE,
      radius: scales?.radius || FALLBACK_RADIUS_SCALE,
      radiusPercent: scales?.radiusPercent || [],
      controlHeight: scales?.controlHeight || DEFAULT_CONTROL_HEIGHTS,
      iconSize: scales?.iconSize || DEFAULT_ICON_SIZES,
    },
    tol: { ...DEFAULT_TOLERANCES, ...tolerances },
    viewport,
    phone: isPhoneViewport(viewport),
  };
}

const SEVERITY_WEIGHT = { 1: 1, 2: 2.5, 3: 5 };

export function badness(f) {
  return SEVERITY_WEIGHT[f.severity] * (1 + Math.min(f.magnitude || 0, 24) / 4);
}

/** Worst first, with a stable tie-break on element index then kind. */
export function rankFindings(findings) {
  return findings
    .map((f, k) => ({ f, k }))
    .sort((a, b) => badness(b.f) - badness(a.f) || a.f.el - b.f.el || a.f.kind.localeCompare(b.f.kind) || a.k - b.k)
    .map((x) => x.f);
}

/**
 * The per-route score: half "values on scale", half "elements free of
 * structural violations". Both halves are shares, so a page with more
 * elements is not punished for its size.
 */
export function scoreFrom({ scaleTotal, scaleOn, checked, flagged }) {
  const scaleShare = scaleTotal ? scaleOn / scaleTotal : 1;
  const cleanShare = checked ? 1 - flagged / checked : 1;
  return {
    score: round2(50 * scaleShare + 50 * cleanShare),
    scaleShare: round2(scaleShare * 100),
    cleanShare: round2(cleanShare * 100),
  };
}

export function analyzeRoute(input, ctx) {
  const records = normalizeRecords(input);
  const tree = buildTree(records);
  const flowChildren = tree.children.map((kids) => kids.filter((k) => inFlow(records[k])).length);
  const nested = checkNestedRadius(records, ctx);
  const overlays = new Map();
  for (const r of records) {
    if (r.kind !== "input" && r.kind !== "select" && r.kind !== "textarea") continue;
    const edges = overlayIconEdges(records, tree, r, ctx.tol);
    if (edges.lead !== null || edges.trail !== null) overlays.set(r.i, edges);
  }
  const vctx = { ...ctx, flowChildren, concentric: nested.concentric, overlays };

  // 1. Values, histograms and the scale check.
  /** @type {Record<string, Array<number | string>>} */
  const hist = {};
  const scale = { spacing: { total: 0, on: 0 }, radius: { total: 0, on: 0 }, controlHeight: { total: 0, on: 0 }, iconSize: { total: 0, on: 0 } };
  const offScaleMap = new Map();
  const offScaleFindings = [];
  for (const r of records) {
    for (const m of measuredValues(r, vctx)) {
      const label = m.property === "radius" && m.full ? "full" : m.value;
      (hist[m.property] ||= []).push(label);
      const j = judgeValue(m, ctx.scales, ctx.tol);
      if (!j.scored) continue;
      const group = SCORED_GROUPS[m.property];
      scale[group].total++;
      if (j.on) {
        scale[group].on++;
        continue;
      }
      const key = `${m.property}|${m.value}`;
      if (!offScaleMap.has(key)) offScaleMap.set(key, { property: m.property, value: m.value, nearest: j.nearest, delta: j.delta, count: 0, examples: [] });
      const entry = offScaleMap.get(key);
      entry.count++;
      if (entry.examples.length < 5) entry.examples.push(r.i);
      offScaleFindings.push({ kind: "off-scale", severity: 1, magnitude: Math.abs(j.delta), message: `${m.property} ${fmt(m.value)} is off scale (nearest ${fmt(j.nearest)})`, el: r.i, related: [], values: { property: m.property, value: m.value, nearest: j.nearest } });
    }
  }
  for (const d of siblingDistances(records, tree)) (hist["sibling-distance"] ||= []).push(d.value);
  /** @type {Record<string, Array<[number | string, number]>>} */
  const histograms = {};
  for (const [prop, values] of Object.entries(hist)) histograms[prop] = histogram(values);

  // 2-6. Structural checks (nested radii ran first: they feed the radius scale).
  const asym = checkAsymmetry(records, tree, ctx);
  const siblings = checkSiblingPadding(records, tree, ctx);
  const rows = checkRowHeights(records, tree, ctx);
  const align = checkAlignment(records, tree, ctx);
  const gaps = checkIconGaps(records, ctx);
  const targets = checkTargets(records, ctx);

  const findings = [...nested.findings, ...asym.findings, ...siblings.findings, ...rows.findings, ...align.findings, ...gaps.findings, ...targets.findings];
  const notes = [...asym.notes, ...rows.notes, ...align.notes, ...targets.notes];
  const checked = new Set();
  for (const part of [nested, asym, siblings, rows, align, gaps, targets]) for (const i of part.checked) checked.add(i);
  const flaggedSet = new Set(findings.map((f) => f.el));

  const byKind = Object.fromEntries(VIOLATION_KINDS.map((k) => [k, 0]));
  for (const f of findings) byKind[f.kind]++;

  const scaleTotal = Object.values(scale).reduce((s, g) => s + g.total, 0);
  const scaleOn = Object.values(scale).reduce((s, g) => s + g.on, 0);
  const score = scoreFrom({ scaleTotal, scaleOn, checked: checked.size, flagged: flaggedSet.size });

  const offScale = [...offScaleMap.values()].sort((a, b) => b.count - a.count || a.property.localeCompare(b.property) || a.value - b.value);

  return {
    elements: records.length,
    histograms,
    scale,
    offScale,
    findings: rankFindings(findings),
    offScaleFindings: rankFindings(offScaleFindings),
    notes,
    counts: { byKind, violations: findings.length, checked: checked.size, flagged: flaggedSet.size, scaleTotal, scaleOn, notes: notes.length },
    score,
  };
}

/**
 * The offenders to outline on the screenshot: structural findings first
 * (worst first), then off-scale values, one entry per element.
 *
 * @param {{ findings: Array<any>, offScaleFindings: Array<any> }} analysis
 * @param {number} n
 * @param {Array<any> | null} [records] when given, identical findings on look-alike elements count once
 */
export function pickOffenders(analysis, n, records = null) {
  const seen = new Set();
  const seenSig = new Set();
  const out = [];
  for (const f of [...analysis.findings, ...analysis.offScaleFindings]) {
    if (out.length >= n) break;
    if (seen.has(f.el)) continue;
    // Fifteen identical rows with one identical problem are one offender, and
    // a component drawn twice (same name, label, text and size) is outlined once.
    const r = records ? records[f.el] : null;
    const sig = r ? `${f.kind}|${f.message}|${r.comp || ""}|${r.tag}|${r.role || ""}` : null;
    const look = r ? `${r.comp || ""}|${r.tag}|${r.role || ""}|${r.label || ""}|${r.text || ""}|${half(r.w)}x${half(r.h)}` : null;
    if ((sig && seenSig.has(sig)) || (look && seenSig.has(look))) continue;
    seen.add(f.el);
    if (sig) seenSig.add(sig);
    if (look) seenSig.add(look);
    out.push(f);
  }
  return out;
}

/** Merge per-route histograms into one. */
export function mergeHistograms(list) {
  const merged = {};
  for (const h of list) {
    for (const [prop, pairs] of Object.entries(h)) {
      const m = (merged[prop] ||= new Map());
      for (const [v, c] of pairs) m.set(v, (m.get(v) || 0) + c);
    }
  }
  const out = {};
  for (const [prop, m] of Object.entries(merged)) {
    out[prop] = [...m.entries()].sort((a, b) => {
      if (typeof a[0] === "number" && typeof b[0] === "number") return a[0] - b[0];
      if (typeof a[0] === "number") return -1;
      if (typeof b[0] === "number") return 1;
      return String(a[0]).localeCompare(String(b[0]));
    });
  }
  return out;
}

/** Whole-site totals: counts are summed (not route scores averaged), then scored the same way. */
export function aggregateSite(routes) {
  const ok = routes.filter((r) => r.analysis);
  const byKind = Object.fromEntries(VIOLATION_KINDS.map((k) => [k, 0]));
  let scaleTotal = 0;
  let scaleOn = 0;
  let checked = 0;
  let flagged = 0;
  let elements = 0;
  const scale = { spacing: { total: 0, on: 0 }, radius: { total: 0, on: 0 }, controlHeight: { total: 0, on: 0 }, iconSize: { total: 0, on: 0 } };
  const offScale = new Map();
  for (const r of ok) {
    const a = r.analysis;
    elements += a.elements;
    scaleTotal += a.counts.scaleTotal;
    scaleOn += a.counts.scaleOn;
    checked += a.counts.checked;
    flagged += a.counts.flagged;
    for (const k of VIOLATION_KINDS) byKind[k] += a.counts.byKind[k] || 0;
    for (const [g, v] of Object.entries(a.scale)) {
      scale[g].total += v.total;
      scale[g].on += v.on;
    }
    for (const o of a.offScale) {
      const key = `${o.property}|${o.value}`;
      if (!offScale.has(key)) offScale.set(key, { property: o.property, value: o.value, nearest: o.nearest, delta: o.delta, count: 0, routes: [] });
      const e = offScale.get(key);
      e.count += o.count;
      e.routes.push(r.name);
    }
  }
  const score = ok.length ? scoreFrom({ scaleTotal, scaleOn, checked, flagged }) : { score: null, scaleShare: null, cleanShare: null };
  const meanRouteScore = ok.length ? round2(ok.reduce((s, r) => s + r.analysis.score.score, 0) / ok.length) : null;
  return {
    routes: routes.length,
    measured: ok.length,
    failed: routes.length - ok.length,
    elements,
    score: score.score,
    scaleShare: score.scaleShare,
    cleanShare: score.cleanShare,
    meanRouteScore,
    scale,
    byKind,
    violations: Object.values(byKind).reduce((s, v) => s + v, 0),
    checked,
    flagged,
    histograms: mergeHistograms(ok.map((r) => r.analysis.histograms)),
    offScale: [...offScale.values()].sort((a, b) => b.count - a.count || a.property.localeCompare(b.property) || a.value - b.value),
  };
}

/** Before/after: per-route score and violation deltas against an earlier geometry.json. */
export function compareRuns(previous, current) {
  const prev = new Map((previous.routes || []).map((r) => [r.name, r]));
  const rows = [];
  for (const r of current.routes) {
    const p = prev.get(r.name);
    if (!p || !p.score || !r.score) continue;
    rows.push({ name: r.name, before: p.score.score, after: r.score.score, delta: round2(r.score.score - p.score.score), violationsBefore: p.counts.violations, violationsAfter: r.counts.violations });
  }
  return {
    site: previous.site && current.site ? { before: previous.site.score, after: current.site.score, delta: round2(current.site.score - previous.site.score) } : null,
    routes: rows,
  };
}

// ---------------------------------------------------------------------------
// Routes

/** Turn a routes file (or a comma list) into route objects. */
export function normalizeRoutes(input) {
  let list = input;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
      const parsed = JSON.parse(trimmed);
      list = Array.isArray(parsed) ? parsed : parsed.routes;
    } else {
      list = trimmed
        .split(/[\n,]/)
        .map((s) => s.replace(/#.*$/, "").trim())
        .filter(Boolean);
    }
  }
  if (!Array.isArray(list)) throw new Error("Routes must be a list");
  const names = new Set();
  return list.map((entry, k) => {
    const route = typeof entry === "string" ? { path: entry } : { ...entry };
    if (!route.path || !route.path.startsWith("/")) throw new Error(`Route ${k + 1} needs a path that starts with "/"`);
    checkWhen(route, `Route ${k + 1}`);
    if (Array.isArray(route.open)) route.open.forEach((step, s) => typeof step === "function" || checkWhen(step, `Route ${k + 1}, open step ${s + 1}`));
    route.name = route.name || route.path;
    let unique = route.name;
    let n = 2;
    while (names.has(unique)) unique = `${route.name}#${n++}`;
    route.name = unique;
    names.add(unique);
    route.slug = slugify(unique);
    route.open = route.open || [];
    return route;
  });
}

/**
 * An h1/h2 matching this (case-insensitive) is an error screen, never scored:
 * Next's own screens, and the product's error boundaries and not-found screens
 * ("This conversation couldn’t load", "Chat couldn’t start", "This page isn’t here").
 */
export const DEFAULT_ERROR_TEXT =
  "^(Something went wrong|This page could not be found\\.?|Page not found|Application error.*|Unhandled Runtime Error|Build Error|Failed to compile|.*couldn[’']t (load|open|start|be read).*|.*isn[’']t here)$";

const WHEN = new Set(["phone", "desktop"]);

function checkWhen(item, where) {
  if (item && item.when !== undefined && !WHEN.has(item.when)) throw new Error(`${where}: "when" is "phone" or "desktop", not ${JSON.stringify(item.when)}`);
}

/**
 * Whether a route or an open step applies at this viewport: `"when": "phone"`
 * runs only below 600 px, `"when": "desktop"` only at or above it (a phone
 * opens the sidebar drawer before it can reach a row menu, a desktop hovers).
 */
export function appliesAt(item, phone) {
  if (!item || typeof item !== "object" || item.when === undefined) return true;
  return item.when === "phone" ? !!phone : !phone;
}

export function slugify(name) {
  const s = String(name)
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "root";
}
