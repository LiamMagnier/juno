"use client";

/**
 * Juno's icon set (design round 3). The drawings are data in ./drawings.ts
 * (Node-importable, so the native generator can project the same geometry to
 * SF Symbol templates); this file renders them for the web; ./icons.css holds
 * the motion. RATIONALE: scratchpad/design-v3/icons/RATIONALE.md.
 *
 * <Icon name="search" />                      20 px, rest
 * <Icon name="plus" state="active" />         the "on" form: plus turns into a close
 * <Icon name={copied ? "check" : "copy"} />   a name change cross-fades (IconSwap), or
 *                                             turns, between chevrons and arrows
 * <Icon name="voice" levels={[.2,.8,.5,.9,.3]} />   the bars follow live input
 * <Icon name="progress" value={0.42} />       the arc shows real progress
 *
 * MOTION CONTRACT (revision 1: hover is opt-in, INTERACTION_SPEC I-7).
 *
 *   .jicon-trigger           the control that owns the icon. Gives the press
 *                            dip (scale 0.9, 70 ms) only when the control is the
 *                            icon alone (an icon button: the Icon detects it and
 *                            marks itself data-solo); a row or a labelled button
 *                            presses tonally and its glyph stays still. State
 *                            changes (state="active", a name change) always run.
 *   .jicon-hover             opt-in hover articulation, on the trigger itself or
 *                            on a region of triggers. For F2 destinations only
 *                            (New chat, Projects, Library, Customize) and the
 *                            gallery; never the composer, the action row, menus
 *                            or rows scanned in lists. Fine pointer only, never
 *                            on keyboard focus.
 *   .jicon-quiet             turns hover off for everything inside (wins over
 *                            .jicon-hover). Kept for older call sites.
 *   .jicon-press             forces the press dip on a trigger that has a label.
 *   data-force="hover|press" on a trigger, or pose="hover|press" on the Icon,
 *                            draws a pose without a pointer (stills).
 *
 * `state="active"` shows the icon's on form (filled, turned, swapped or drawn,
 * per drawing). Reduced motion keeps every state and changes it with a short
 * cross-fade, never a transform.
 *
 * CRISPNESS. fitDrawing hints each drawing to the device pixel grid for its
 * size; Chrome and WebKit paint an inline SVG at a whole device pixel whatever
 * its layout position, so the only thing that can still leave a glyph between
 * pixels is a fractional translate on an ancestor (a centring -50%, a popover
 * mid-flight). The Icon measures that and cancels it on its own .jsnap group
 * (useCrispPlacement), re-measuring when an ancestor's transition or animation
 * ends and on resize.
 */
import * as React from "react";
import type { CSSProperties, SVGProps } from "react";
import { ICON_ALIASES, ICONS, resolveIcon, resolveIconAt, xform, type IconDrawing, type IconElement, type IconMove } from "./drawings";

export type KnownIconName = keyof typeof ICONS | keyof typeof ICON_ALIASES;
/** Any drawn name (autocompletes), or any string: an unknown name renders a placeholder. */
export type IconName = KnownIconName | (string & {});

export const ICON_NAMES = Object.keys(ICONS);

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "name"> {
  name: IconName;
  size?: 16 | 20 | 24 | number;
  state?: "rest" | "active" | "disabled";
  title?: string;
  /** progress: 0..1 */
  value?: number;
  /** voice: five input levels 0..1, drawn as the bars' heights (no timer, no loop). */
  levels?: number[];
  /** Stills only: draw the hover or press pose without a pointer. */
  pose?: "hover" | "press";
  /** The line in grid units, instead of the optical ladder: display sizes (a 192 px drawing review draws 1.5, as 24 px does). */
  line?: number;
  /** Grid fitting (default on at UI sizes, 12 to 32 px). `false` draws the raw geometry: the pixel proof's before column. */
  fit?: boolean;
  /** Labs only: the line in px instead of the optical ladder, still fitted. */
  px?: number;
}

/* —————————————————————————————— Optical sizing —————————————————————————————— */

/**
 * One optical line. 18 px and up draw 1.5 px; 16 px draws 1.25 px, which is
 * where Inter's 14 px stem sits, so a sidebar row's glyph and its label carry
 * the same weight (the stroke lab, ?view=lab, shows 1, 1.25 and 1.5 side by
 * side). Relative weight falls gently as the glyph grows: 7.8% of the box at
 * 16, 7.5% at 20, 6.25% at 24, the optical sizing type uses.
 */
export function iconStrokePx(size: number): number {
  // 18 px draws 1.5 too: 1.375 px is 2.75 device pixels at 2x and can never be crisp; 1.5 is 3.
  if (size >= 18) return 1.5;
  if (size >= 16) return 1.25;
  if (size >= 14) return 1.125;
  return 1;
}

/* —————————————————————————————— Grid fitting —————————————————————————————— */

/**
 * Hinting, done the way a font's autohinter does it, per rendered size and
 * device pixel ratio. Every straight horizontal and vertical run in a drawing
 * is a stem; each stem's centre moves (at most half a device pixel) to where
 * the rendered line covers whole device pixels: a pixel boundary when the
 * line's whole device pixels are even (2 dp, or 2.5 as 16 px at 2x draws), a
 * pixel centre when odd (1.5 px at 2x is 3 dp). Every other point (curves,
 * diagonals, circle centres, knockouts) is interpolated between the stems
 * around it, so joins stay joined and proportions hold: the drawing is the
 * same, only its straight edges are crisp. One lattice cannot be crisp at 16
 * and at 20 px (a 1.5 unit step is 2 dp at 16 but 2.5 dp at 20), which is why
 * the fit happens here and not in the data. The native projection reads the
 * unfitted drawing (SF Symbols scale as vectors).
 */
type AxisMap = (v: number) => number;

/** A straight run this long or longer is a stem (a member's 1.5 unit eyes count). */
const STEM_MIN = 0.75;
const r3 = (v: number) => Math.round(v * 1000) / 1000;

function stemsOf(els: IconElement[], xs: Set<number>, ys: Set<number>) {
  for (const el of els) {
    if (el.tag === "g") {
      stemsOf(el.children ?? [], xs, ys);
      continue;
    }
    if (el.tag === "rect") {
      const x = Number(el.attrs.x ?? 0);
      const y = Number(el.attrs.y ?? 0);
      xs.add(r3(x)).add(r3(x + Number(el.attrs.width ?? 0)));
      ys.add(r3(y)).add(r3(y + Number(el.attrs.height ?? 0)));
      continue;
    }
    if (el.tag !== "path") continue;
    const t = String(el.attrs.d).match(/[MLHVCQAZ]|-?\d*\.?\d+(?:e-?\d+)?/g) ?? [];
    let i = 0;
    let cmd = "";
    let x = 0;
    let y = 0;
    let sx = 0;
    let sy = 0;
    const num = () => Number(t[i++]);
    const line = (x1: number, y1: number) => {
      if (Math.abs(x1 - x) < 1e-3 && Math.abs(y1 - y) >= STEM_MIN) xs.add(r3(x));
      if (Math.abs(y1 - y) < 1e-3 && Math.abs(x1 - x) >= STEM_MIN) ys.add(r3(y));
      x = x1;
      y = y1;
    };
    while (i < t.length) {
      if (/[MLHVCQAZ]/.test(t[i])) {
        cmd = t[i++];
        if (cmd === "Z") {
          line(sx, sy);
          continue;
        }
      }
      if (cmd === "M") {
        x = sx = num();
        y = sy = num();
        cmd = "L";
      } else if (cmd === "L") line(num(), num());
      else if (cmd === "H") line(num(), y);
      else if (cmd === "V") line(x, num());
      else if (cmd === "C" || cmd === "Q" || cmd === "A") {
        i += cmd === "C" ? 4 : cmd === "Q" ? 2 : 5;
        x = num();
        y = num();
      } else i++;
    }
  }
}

/**
 * One axis: stems snap to the device lattice, points between two stems follow
 * linearly, points outside shift with the nearest stem. `off` shifts the
 * lattice so the glyph's centre line (12 units) is itself a stem position, and
 * a stem exactly between two targets rounds away from the centre: a symmetric
 * drawing stays symmetric (a pin's body stays centred on its needle) and its
 * counters open rather than close.
 */
function axisMap(stems: Set<number>, k: number, frac: number, off: number): AxisMap {
  const from = [...stems].sort((a, b) => a - b);
  if (from.length === 0) return (v) => v;
  const to: number[] = [];
  from.forEach((c, j) => {
    const v = c * k + off - frac;
    const tie = Math.abs(v - Math.floor(v) - 0.5) < 1e-6;
    const n = tie ? (c < 12 ? Math.floor(v) : c > 12 ? Math.ceil(v) : Math.round(v)) : Math.round(v);
    let tgt = (n + frac) / k;
    // Two stems closer than a device pixel must not swap or merge: the later one keeps the earlier one's shift.
    if (j > 0 && tgt <= to[j - 1] + 1e-6) tgt = c + (to[j - 1] - from[j - 1]);
    to.push(tgt);
  });
  const last = from.length - 1;
  return (v) => {
    if (v <= from[0]) return r3(v + to[0] - from[0]);
    if (v >= from[last]) return r3(v + to[last] - from[last]);
    let j = 0;
    while (from[j + 1] < v) j++;
    return r3(to[j] + ((v - from[j]) / (from[j + 1] - from[j])) * (to[j + 1] - to[j]));
  };
}

/**
 * A point (a filled dot with no stroke: the dots of more, a list's bullets,
 * an i's dot) is fitted on its own: its diameter rounds to whole device pixels
 * (never below one) and its centre goes to a pixel boundary when that diameter
 * is even, a pixel centre when odd, so a 2 dp dot is a clean 2 x 2 block at 1x
 * instead of a grey smudge across four pixels.
 */
function fitDot(cx: number, cy: number, r: number, k: number): [number, number, number] {
  const n = Math.max(1, Math.round(2 * r * k));
  const at = (v: number) => (n % 2 ? Math.floor(v * k) + 0.5 : Math.round(v * k)) / k;
  return [r3(at(cx)), r3(at(cy)), r3(n / (2 * k))];
}

function fitEls(els: IconElement[], mx: AxisMap, my: AxisMap, k: number): IconElement[] {
  return els.map((el) => {
    if (el.tag === "g") return { ...el, children: fitEls(el.children ?? [], mx, my, k) };
    const a = { ...el.attrs };
    if (el.tag === "path") a.d = xform(String(a.d), (x, y) => [mx(x), my(y)]);
    else if (el.tag === "circle" && a.stroke === "none" && !el.knockout) {
      [a.cx, a.cy, a.r] = fitDot(mx(Number(a.cx)), my(Number(a.cy)), Number(a.r), k);
    } else if (el.tag === "circle") {
      a.cx = mx(Number(a.cx));
      a.cy = my(Number(a.cy));
    } else if (el.tag === "rect") {
      const x = Number(a.x ?? 0);
      const y = Number(a.y ?? 0);
      a.x = mx(x);
      a.y = my(y);
      a.width = r3(mx(x + Number(a.width ?? 0)) - mx(x));
      a.height = r3(my(y + Number(a.height ?? 0)) - my(y));
    }
    return { ...el, attrs: a };
  });
}

const fitCache = new WeakMap<IconDrawing, Map<string, IconDrawing>>();

/**
 * The drawing fitted to `size` px at `dpr` with a `strokePx` line. The rest
 * and on drawings share one fit (the fill must land exactly on the outline it
 * replaces); a swap target or hover drawing is fitted on its own.
 */
export function fitDrawing(d: IconDrawing, size: number, dpr: number, strokePx: number): IconDrawing {
  const key = `${size}|${dpr}|${strokePx}`;
  let bySize = fitCache.get(d);
  const hit = bySize?.get(key);
  if (hit) return hit;
  const k = (size * dpr) / 24;
  const frac = Math.floor(strokePx * dpr + 1e-6) % 2 === 1 ? 0.5 : 0;
  const centre = 12 * k - frac;
  const off = Math.round((Math.round(centre) - centre) * 1000) / 1000;
  const xs = new Set<number>();
  const ys = new Set<number>();
  stemsOf(d.elements, xs, ys);
  if (d.fill) stemsOf(d.fill, xs, ys);
  const mx = axisMap(xs, k, frac, off);
  const my = axisMap(ys, k, frac, off);
  const out: IconDrawing = { ...d, elements: fitEls(d.elements, mx, my, k), fill: d.fill ? fitEls(d.fill, mx, my, k) : undefined };
  if (!bySize) {
    bySize = new Map();
    fitCache.set(d, bySize);
  }
  bySize.set(key, out);
  return out;
}

/** The device pixel ratio the fit targets: 2 on the server (Retina is the reference frame), the screen's own on the client. */
const dprListeners = new Set<() => void>();
let dprQuery: MediaQueryList | null = null;
function watchDpr() {
  if (typeof window === "undefined" || !window.matchMedia) return;
  dprQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
  dprQuery.addEventListener(
    "change",
    () => {
      watchDpr();
      dprListeners.forEach((f) => f());
    },
    { once: true },
  );
}
function subscribeDpr(cb: () => void) {
  dprListeners.add(cb);
  if (!dprQuery) watchDpr();
  return () => {
    dprListeners.delete(cb);
  };
}
const dprNow = () => Math.min(3, Math.max(1, Math.round(window.devicePixelRatio || 1)));
const dprServer = () => 2;

/* —————————————————————————————— Rendering —————————————————————————————— */

const KNOCKOUT_GAP = 1.5;
/** A tight cut grows a little past its own stroke, so a hole (a filled member's eyes) stays open at 16 px. */
const TIGHT_GROW = 0.75;

type Ctx = {
  uid: string;
  /** The rendered size: picks the small cut for swap and hover targets too. */
  size: number;
  /** Device pixels per grid unit when fitted (a held hover pose then moves by whole device pixels), else 0. */
  k: number;
  sw: number;
  value?: number;
  levels?: number[];
  levelIndex: { i: number };
};

/** A held translation, rounded to whole device pixels (never to nothing), so a part at rest in its hover pose stays crisp. */
function snapMove(v: number, k: number): number {
  if (!k) return v;
  const dp = Math.round(v * k) || Math.sign(v);
  return Math.round((dp / k) * 1000) / 1000;
}

function moveStyle(m: IconMove | undefined, k = 0): CSSProperties | undefined {
  if (!m) return undefined;
  const s: Record<string, string | number> = {};
  if (m.x) s["--hx"] = `${snapMove(m.x, k)}px`;
  if (m.y) s["--hy"] = `${snapMove(m.y, k)}px`;
  if (m.r) s["--hr"] = `${m.r}deg`;
  const sx = m.sx ?? m.s;
  const sy = m.sy ?? m.s;
  if (sx != null && sx !== 1) s["--hsx"] = sx;
  if (sy != null && sy !== 1) s["--hsy"] = sy;
  if (m.rest != null) s["--ro"] = m.rest;
  if (m.op != null) s["--ho"] = m.op;
  if (m.delay) s["--hd"] = `${m.delay}ms`;
  const [ox, oy] = m.o ?? [12, 12];
  s.transformOrigin = `${ox}px ${oy}px`;
  return s as CSSProperties;
}

function attrsFor(el: IconElement, ctx: Ctx): Record<string, string | number> {
  const a: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(el.attrs)) a[k] = v;
  if (ctx.value != null && a.strokeDasharray != null) {
    const v = Math.max(0, Math.min(1, ctx.value));
    a.strokeDasharray = `${v} 2`;
    // At zero a round cap on an empty dash would still paint a dot at twelve o'clock.
    if (v === 0) a.strokeOpacity = 0;
  }
  if (el.draw) {
    a.pathLength = 1;
    a.className = "jd";
  }
  return a;
}

function renderShape(el: IconElement, key: React.Key, ctx: Ctx, extra?: Record<string, string | number>): React.ReactNode {
  const a = { ...attrsFor(el, ctx), ...extra };
  if (el.tag === "path") return <path key={key} {...(a as SVGProps<SVGPathElement>)} />;
  if (el.tag === "circle") return <circle key={key} {...(a as SVGProps<SVGCircleElement>)} />;
  if (el.tag === "rect") return <rect key={key} {...(a as SVGProps<SVGRectElement>)} />;
  return null;
}

/**
 * A live bar's scale: level 0..1 maps to a height of 3 to 16.5 units whatever
 * the bar's rest height (a loud outer bar can stand as tall as the middle
 * one), inside the live area. The bar is the group's first path, drawn upright.
 */
function levelScale(el: IconElement, level: number): number {
  const d = String(el.children?.[0]?.attrs.d ?? "");
  const ys = [...d.matchAll(/[ML]\s*-?[\d.]+\s+(-?[\d.]+)/g)].map((m) => Number(m[1]));
  const rest = ys.length >= 2 ? Math.abs(ys[ys.length - 1] - ys[0]) : 9;
  const h = 3 + Math.max(0, Math.min(1, level)) * 13.5;
  return Math.round((h / rest) * 1000) / 1000;
}

function renderEl(el: IconElement, key: string, ctx: Ctx): React.ReactNode {
  if (el.tag === "g") {
    let lv: CSSProperties | undefined;
    let isLevel = false;
    if (el.hover?.anim === "levels") {
      const i = ctx.levelIndex.i++;
      if (ctx.levels) {
        isLevel = true;
        lv = { "--lv": levelScale(el, ctx.levels[i] ?? 0) } as CSSProperties;
      }
    }
    const style = el.hover || lv ? { ...moveStyle(el.hover, ctx.k), ...lv } : undefined;
    return (
      <g key={key} className={el.hover ? "jp" : undefined} data-anim={el.hover?.anim} data-lv={isLevel ? "" : undefined} style={style}>
        {renderList(el.children ?? [], ctx, key)}
      </g>
    );
  }
  return renderShape(el, key, ctx);
}

/**
 * Paint a list in order. A knockout element cuts itself (its fill and its
 * stroke, grown by the house gap unless it is "tight") out of everything
 * painted before it, through a mask; its own hover moves the cut with the
 * part it belongs to. The gap follows the rendered line, so it stays 1.5
 * units clear of the stroke at every size.
 */
function renderList(els: IconElement[], ctx: Ctx, prefix: string): React.ReactNode[] {
  let painted: React.ReactNode[] = [];
  els.forEach((el, i) => {
    const key = `${prefix}.${i}`;
    if (!el.knockout) {
      painted.push(renderEl(el, key, ctx));
      return;
    }
    const id = `${ctx.uid}-${key.replace(/\./g, "-")}`;
    const grow = el.knockout === "tight" ? TIGHT_GROW : KNOCKOUT_GAP * 2;
    const shape = renderShape(el, "s", ctx, {
      fill: "black",
      stroke: "black",
      strokeWidth: Math.round((ctx.sw + grow) * 1000) / 1000,
    });
    painted = [
      <mask key={`${key}m`} id={id} maskUnits="userSpaceOnUse" x={-4} y={-4} width={32} height={32}>
        <rect x={-4} y={-4} width={32} height={32} fill="white" stroke="none" />
        {el.hover ? (
          <g className="jp" data-anim={el.hover.anim} style={moveStyle(el.hover, ctx.k)}>
            {shape}
          </g>
        ) : (
          shape
        )}
      </mask>,
      <g key={`${key}g`} mask={`url(#${id})`}>
        {painted}
      </g>,
    ];
  });
  return painted;
}

function Wrap({ move, k, children }: { move?: IconMove; k: number; children: React.ReactNode }) {
  if (!move) return <>{children}</>;
  return (
    <g className="jp" data-anim={move.anim} style={moveStyle(move, k)}>
      {children}
    </g>
  );
}

type Fit = (d: IconDrawing) => IconDrawing;
const noFit: Fit = (d) => d;

/**
 * One drawing's layers: base, hover swap, fill, and the swap target, each
 * fitted to the rendered size. A glyph on its way out (`exiting`) paints its
 * base only: its own on layers would otherwise answer the new state (a copy
 * leaving with state="active" would draw a second check).
 */
function Layers({ d: raw, ctx, fit, exiting }: { d: IconDrawing; ctx: Ctx; fit: Fit; exiting?: boolean }) {
  const d = fit(raw);
  const on = exiting ? undefined : d.on;
  const [ox, oy] = on?.kind === "turn" && on.o ? on.o : [12, 12];
  const turn = on?.kind === "turn" ? ({ "--on-turn": `${on.deg}deg`, transformOrigin: `${ox}px ${oy}px` } as CSSProperties) : undefined;
  const altRaw = on?.kind === "swap" ? resolveIconAt(on.to, ctx.size) : undefined;
  const hoverRaw = d.hoverSwap && !exiting ? resolveIconAt(d.hoverSwap, ctx.size) : undefined;
  const alt = altRaw ? fit(altRaw) : undefined;
  const hoverAlt = hoverRaw ? fit(hoverRaw) : undefined;
  return (
    <>
      <g className="jg jg-base" style={turn}>
        <Wrap move={d.hover} k={ctx.k}>{renderList(d.elements, ctx, "b")}</Wrap>
      </g>
      {hoverAlt ? (
        <g className="jg jg-hover">
          <Wrap move={hoverAlt.hover} k={ctx.k}>{renderList(hoverAlt.elements, { ...ctx, uid: `${ctx.uid}h` }, "h")}</Wrap>
        </g>
      ) : null}
      {d.fill && on?.kind === "fill" ? (
        <g className="jg jg-fill">
          <Wrap move={d.hover} k={ctx.k}>{renderList(d.fill, { ...ctx, uid: `${ctx.uid}f` }, "f")}</Wrap>
        </g>
      ) : null}
      {alt ? (
        <g className="jg jg-alt">
          <Wrap move={alt.hover} k={ctx.k}>{renderList(alt.elements, { ...ctx, uid: `${ctx.uid}a`, levelIndex: { i: 0 } }, "a")}</Wrap>
        </g>
      ) : null}
    </>
  );
}

/* —————————————————————————————— Name changes —————————————————————————————— */

/** Glyphs that are one drawing turned: a change between them turns instead of cross-fading. */
const TURNS: Record<string, [string, number]> = {
  "chevron-right": ["chevron", 0],
  "chevron-down": ["chevron", 90],
  "chevron-left": ["chevron", 180],
  "chevron-up": ["chevron", 270],
  "arrow-right": ["arrow", 0],
  "arrow-down": ["arrow", 90],
  "arrow-left": ["arrow", 180],
  "arrow-up": ["arrow", 270],
};

const ALIASES: Record<string, string> = ICON_ALIASES;

function turnBetween(from: string, to: string): number | null {
  const a = TURNS[ALIASES[from] ?? from];
  const b = TURNS[ALIASES[to] ?? to];
  if (!a || !b || a[0] !== b[0]) return null;
  let delta = a[1] - b[1];
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

const warned = new Set<string>();

/* —————————————————————————————— Live levels —————————————————————————————— */

const RM_QUERY = "(prefers-reduced-motion: reduce)";
/** INTERACTION_SPEC §1.7: under reduced motion a level meter is a static bar that updates at most four times a second. */
const RM_LEVEL_INTERVAL = 250;

function reducedMotionAt(el: Element | null): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.matchMedia?.(RM_QUERY).matches || el?.closest("[data-rm], [data-motion='reduced']"));
}

/**
 * The levels the bars draw. With full motion, every update the caller sends
 * (one per animation frame, smoothed by the analyser). Under reduced motion,
 * the latest value at most every 250 ms, drawn with no easing (icons.css).
 */
function useCalmLevels(levels: number[] | undefined, svg: React.RefObject<SVGSVGElement | null>): number[] | undefined {
  const [held, setHeld] = React.useState<number[] | undefined>(undefined);
  const [reduced, setReduced] = React.useState(false);
  const latest = React.useRef(levels);
  const last = React.useRef(0);
  const timer = React.useRef<number | null>(null);
  latest.current = levels;

  React.useEffect(() => {
    if (!levels) return;
    const rm = reducedMotionAt(svg.current);
    setReduced(rm);
    if (!rm) return;
    const wait = RM_LEVEL_INTERVAL - (performance.now() - last.current);
    if (wait <= 0) {
      last.current = performance.now();
      setHeld(levels);
    } else if (timer.current == null) {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        last.current = performance.now();
        setHeld(latest.current);
      }, wait);
    }
  }, [levels, svg]);

  React.useEffect(
    () => () => {
      if (timer.current != null) window.clearTimeout(timer.current);
    },
    [],
  );

  if (!levels) return undefined;
  return reduced ? (held ?? levels) : levels;
}

/* —————————————————————————————— Placement —————————————————————————————— */

/**
 * The translation an icon's ancestors add, in CSS px, or null while one of
 * them scales or rotates (mid-animation: nothing to fit to). Layout offsets
 * are not counted: the browser already paints an SVG root at a whole device
 * pixel (tools/snaptest*.mjs in the icon scratchpad prove it for Chrome).
 */
function ancestorShift(svg: SVGSVGElement): [number, number] | null {
  let tx = 0;
  let ty = 0;
  for (let el = svg.parentElement; el && el !== document.documentElement; el = el.parentElement) {
    const cs = getComputedStyle(el);
    const t = cs.transform;
    const tr = cs.translate;
    const sc = cs.scale;
    const ro = cs.rotate;
    if ((!t || t === "none") && (!tr || tr === "none") && (!sc || sc === "none") && (!ro || ro === "none")) continue;
    if (sc && sc !== "none" && sc.split(/\s+/).some((v) => Number(v) !== 1)) return null;
    if (ro && ro !== "none" && parseFloat(ro) !== 0) return null;
    if (tr && tr !== "none") {
      const parts = tr.split(/\s+(?![^(]*\))/);
      const one = (v: string | undefined, ref: number): number => (v == null ? 0 : v.endsWith("%") ? (parseFloat(v) / 100) * ref : v.endsWith("px") || v === "0" ? parseFloat(v) : NaN);
      const x = one(parts[0], el.offsetWidth);
      const y = one(parts[1], el.offsetHeight);
      if (Number.isNaN(x) || Number.isNaN(y)) return null;
      tx += x;
      ty += y;
    }
    if (t && t !== "none") {
      const m = new DOMMatrixReadOnly(t);
      if (!m.is2D || m.a !== 1 || m.d !== 1 || m.b !== 0 || m.c !== 0) return null;
      tx += m.e;
      ty += m.f;
    }
  }
  return [tx, ty];
}

const placed = new Map<SVGSVGElement, () => void>();
let settledTargets: Set<Element> | null = null;
let listening = false;

function flushSettled() {
  const targets = settledTargets;
  settledTargets = null;
  if (!targets) return;
  for (const [svg, place] of placed) {
    for (const t of targets) {
      if (t.contains(svg)) {
        place();
        break;
      }
    }
  }
}

function onSettled(e: Event) {
  const t = e.target;
  // An icon's own parts moving never move the icon.
  if (!(t instanceof Element) || t.closest("svg.ji")) return;
  if (!settledTargets) {
    settledTargets = new Set();
    requestAnimationFrame(flushSettled);
  }
  settledTargets.add(t);
}

function onResize() {
  requestAnimationFrame(() => placed.forEach((place) => place()));
}

function listen() {
  if (listening || typeof document === "undefined") return;
  listening = true;
  document.addEventListener("transitionend", onSettled, true);
  document.addEventListener("animationend", onSettled, true);
  window.addEventListener("resize", onResize, { passive: true });
}

/**
 * After mount and whenever its trigger or size changes: (1) mark the icon
 * data-solo when its .jicon-trigger holds nothing but this glyph (an icon
 * button, which gets the press dip; a row or a labelled button does not), and
 * (2) cancel any fractional translate its ancestors add, on the .jsnap group,
 * so the fitted drawing lands on whole device pixels where it is painted.
 */
function useCrispPlacement(svgRef: React.RefObject<SVGSVGElement | null>, snapRef: React.RefObject<SVGGElement | null>, size: number, name: string) {
  React.useLayoutEffect(() => {
    const svg = svgRef.current;
    const snap = snapRef.current;
    if (!svg || !snap) return;
    const trigger = svg.closest(".jicon-trigger");
    if (trigger) {
      const own = svg.textContent ?? "";
      const text = (trigger.textContent ?? "").replace(own, "").trim();
      svg.toggleAttribute("data-solo", !text && trigger.querySelectorAll("svg.ji").length === 1);
    }
    const place = () => {
      const shift = ancestorShift(svg);
      if (!shift) return;
      const dpr = window.devicePixelRatio || 1;
      const fix = (v: number) => {
        const d = v * dpr;
        const c = (Math.round(d) - d) / dpr;
        return Math.abs(c) < 0.004 ? 0 : Math.round(((c * 24) / size) * 1000) / 1000;
      };
      const x = fix(shift[0]);
      const y = fix(shift[1]);
      const next = x || y ? `${x}px ${y}px` : "";
      if (snap.style.translate !== next) snap.style.translate = next;
    };
    place();
    placed.set(svg, place);
    listen();
    return () => {
      placed.delete(svg);
    };
  }, [svgRef, snapRef, size, name]);
}

export function Icon({ name, size = 20, state = "rest", title, value, levels, pose, line, fit: fitOn = true, px, className, style, ...rest }: IconProps) {
  const rawId = React.useId();
  const uid = `ji${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;
  const svgRef = React.useRef<SVGSVGElement | null>(null);
  const snapRef = React.useRef<SVGGElement | null>(null);
  const shownLevels = useCalmLevels(levels, svgRef);
  useCrispPlacement(svgRef, snapRef, size, name);

  /*
   * A name change starts a swap: the old glyph leaves while the new one enters.
   * The entering group keeps its key (and its class) after the swap settles,
   * so nothing remounts: a check that drew itself in does not draw again.
   */
  const [shown, setShown] = React.useState<string>(name);
  const [swap, setSwap] = React.useState<{ n: number; from: string; turn: number | null; done: boolean } | null>(null);
  if (name !== shown) {
    setSwap({ n: (swap?.n ?? 0) + 1, from: shown, turn: turnBetween(shown, name), done: false });
    setShown(name);
  }

  const strokePx = px ?? iconStrokePx(size);
  const sw = line ?? Math.round(((strokePx * 24) / size) * 1000) / 1000;
  const dpr = React.useSyncExternalStore(subscribeDpr, dprNow, dprServer);
  const fits = fitOn && line == null && size >= 12 && size <= 32;
  const fit = React.useMemo<Fit>(() => (fits ? (x) => fitDrawing(x, size, dpr, strokePx) : noFit), [fits, size, dpr, strokePx]);
  const d = resolveIconAt(name, size);
  const ctx: Ctx = { uid, size, k: fits ? (size * dpr) / 24 : 0, sw, value, levels: shownLevels, levelIndex: { i: 0 } };

  if (!d && process.env.NODE_ENV !== "production" && !warned.has(name)) {
    warned.add(name);
    console.warn(`[juno icons] no drawing named "${name}"`);
  }

  const prev = swap && !swap.done && swap.turn == null ? resolveIconAt(swap.from, size) : undefined;
  const enterCls = swap ? (swap.turn != null ? "jg-turnin" : "jg-enter") : undefined;
  const enterStyle = swap?.turn != null ? ({ "--from": `${swap.turn}deg` } as CSSProperties) : undefined;
  const settle = (e: React.AnimationEvent<SVGGElement>) => {
    if (e.target === e.currentTarget) setSwap((sw0) => (sw0 && !sw0.done ? { ...sw0, done: true } : sw0));
  };

  return (
    <svg
      ref={svgRef}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ? `ji ${className}` : "ji"}
      data-icon={name}
      data-state={state}
      data-on={d?.on?.kind}
      data-pose={pose}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
      style={style}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <g className="jsnap" ref={snapRef}>
        {d ? (
          <g key={`in${swap?.n ?? 0}`} className={enterCls ? `jl ${enterCls}` : "jl"} style={enterStyle} onAnimationEnd={swap && !swap.done ? settle : undefined}>
            <Layers d={d} ctx={ctx} fit={fit} />
          </g>
        ) : (
          <rect x={5.25} y={5.25} width={13.5} height={13.5} rx={3} strokeDasharray="2 2" opacity={0.5} />
        )}
        {prev ? (
          <g key={`out${swap?.n ?? 0}`} className="jl jg-exit">
            <Layers d={prev} ctx={{ ...ctx, uid: `${uid}p`, levelIndex: { i: 0 } }} fit={fit} exiting />
          </g>
        ) : null}
      </g>
    </svg>
  );
}

/**
 * Two glyphs in one slot, swapped by a flag: the spec's IconSwap (overlapping
 * glyphs, opacity plus scale 0.8 to 1 on `fast`). Equivalent to changing
 * <Icon name>, kept for call sites that read better with both names.
 */
export function IconSwap({ from, to, swapped, ...rest }: Omit<IconProps, "name"> & { from: IconName; to: IconName; swapped: boolean }) {
  return <Icon name={swapped ? to : from} {...rest} />;
}

export function iconDrawing(name: string, size?: number): IconDrawing | undefined {
  return size == null ? resolveIcon(name) : resolveIconAt(name, size);
}
