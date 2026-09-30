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
 * MOTION CONTRACT. An icon articulates when an ancestor with the class
 * `jicon-trigger` is hovered with a fine pointer (or carries
 * `data-force="hover"`, for stills), and presses in while that ancestor is
 * `:active` (or `data-force="press"`). Per INTERACTION_SPEC I-7 it never
 * articulates on keyboard focus, and surfaces used tens of times a day (the
 * composer, the message action row, menus) wrap themselves in `jicon-quiet`:
 * hover articulation off, press and state changes kept. `state="active"` shows
 * the icon's on form (filled, turned, swapped or drawn, per drawing). Reduced
 * motion keeps every state and changes it with a short cross-fade, never a
 * transform.
 */
import * as React from "react";
import type { CSSProperties, SVGProps } from "react";
import { ICON_ALIASES, ICONS, resolveIcon, type IconDrawing, type IconElement, type IconMove } from "./drawings";
import "./icons.css";

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
}

/* —————————————————————————————— Optical sizing —————————————————————————————— */

/**
 * One optical line. 20 px and up draw 1.5 px; 16 px draws 1.25 px, which is
 * where Inter's 14 px stem sits, so a sidebar row's glyph and its label carry
 * the same weight (the stroke lab, ?view=lab, shows 1, 1.25 and 1.5 side by
 * side). Relative weight falls gently as the glyph grows: 7.8% of the box at
 * 16, 7.5% at 20, 6.25% at 24, the optical sizing type uses.
 */
export function iconStrokePx(size: number): number {
  if (size >= 20) return 1.5;
  if (size >= 18) return 1.375;
  if (size >= 16) return 1.25;
  if (size >= 14) return 1.125;
  return 1;
}

/**
 * Half a device pixel at 2x, in grid units, when the stroke is an odd whole
 * number of device pixels (1.5 px = 3 dp): lattice lines then land on pixel
 * centres and the stroke's edges are crisp. Applied only at >= 2dppx
 * (icons.css). An even stroke (1 px = 2 dp) is already crisp on the lattice.
 */
function snapUnits(size: number, strokePx: number): number {
  const dp = strokePx * 2;
  return Number.isInteger(dp) && dp % 2 === 1 ? 6 / size : 0;
}

/* —————————————————————————————— Rendering —————————————————————————————— */

const KNOCKOUT_GAP = 1.5;
/** A tight cut grows a little past its own stroke, so a hole (a filled member's eyes) stays open at 16 px. */
const TIGHT_GROW = 0.75;

type Ctx = {
  uid: string;
  sw: number;
  value?: number;
  levels?: number[];
  levelIndex: { i: number };
};

function moveStyle(m: IconMove | undefined): CSSProperties | undefined {
  if (!m) return undefined;
  const s: Record<string, string | number> = {};
  if (m.x) s["--hx"] = `${m.x}px`;
  if (m.y) s["--hy"] = `${m.y}px`;
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
    a.strokeDasharray = `${v} 1`;
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

function renderEl(el: IconElement, key: string, ctx: Ctx): React.ReactNode {
  if (el.tag === "g") {
    let lv: CSSProperties | undefined;
    let isLevel = false;
    if (el.hover?.anim === "levels") {
      const i = ctx.levelIndex.i++;
      if (ctx.levels) {
        isLevel = true;
        lv = { "--lv": Math.max(0.2, Math.min(1.4, ctx.levels[i] ?? 0.2)) } as CSSProperties;
      }
    }
    const style = el.hover || lv ? { ...moveStyle(el.hover), ...lv } : undefined;
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
          <g className="jp" data-anim={el.hover.anim} style={moveStyle(el.hover)}>
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

function Wrap({ move, children }: { move?: IconMove; children: React.ReactNode }) {
  if (!move) return <>{children}</>;
  return (
    <g className="jp" data-anim={move.anim} style={moveStyle(move)}>
      {children}
    </g>
  );
}

/** One drawing's layers: base, hover swap, fill, and the swap target. */
function Layers({ d, ctx }: { d: IconDrawing; ctx: Ctx }) {
  const on = d.on;
  const turn = on?.kind === "turn" ? ({ "--on-turn": `${on.deg}deg`, transformOrigin: "12px 12px" } as CSSProperties) : undefined;
  const alt = on?.kind === "swap" ? resolveIcon(on.to) : undefined;
  const hoverAlt = d.hoverSwap ? resolveIcon(d.hoverSwap) : undefined;
  return (
    <>
      <g className="jg jg-base" style={turn}>
        <Wrap move={d.hover}>{renderList(d.elements, ctx, "b")}</Wrap>
      </g>
      {hoverAlt ? (
        <g className="jg jg-hover">
          <Wrap move={hoverAlt.hover}>{renderList(hoverAlt.elements, { ...ctx, uid: `${ctx.uid}h` }, "h")}</Wrap>
        </g>
      ) : null}
      {d.fill ? (
        <g className="jg jg-fill">
          <Wrap move={d.hover}>{renderList(d.fill, { ...ctx, uid: `${ctx.uid}f` }, "f")}</Wrap>
        </g>
      ) : null}
      {alt ? (
        <g className="jg jg-alt">
          <Wrap move={alt.hover}>{renderList(alt.elements, { ...ctx, uid: `${ctx.uid}a`, levelIndex: { i: 0 } }, "a")}</Wrap>
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

export function Icon({ name, size = 20, state = "rest", title, value, levels, pose, line, className, style, ...rest }: IconProps) {
  const rawId = React.useId();
  const uid = `ji${rawId.replace(/[^a-zA-Z0-9]/g, "")}`;

  // A name change is remembered for one swap: the old glyph leaves while the new one enters.
  const [shown, setShown] = React.useState<string>(name);
  const [leaving, setLeaving] = React.useState<{ name: string; turn: number | null; n: number } | null>(null);
  if (name !== shown) {
    setLeaving({ name: shown, turn: turnBetween(shown, name), n: (leaving?.n ?? 0) + 1 });
    setShown(name);
  }

  const strokePx = iconStrokePx(size);
  const sw = line ?? Math.round(((strokePx * 24) / size) * 1000) / 1000;
  const snap = line ? 0 : snapUnits(size, strokePx);
  const d = resolveIcon(name);
  const ctx: Ctx = { uid, sw, value, levels, levelIndex: { i: 0 } };

  if (!d && process.env.NODE_ENV !== "production" && !warned.has(name)) {
    warned.add(name);
    console.warn(`[juno icons] no drawing named "${name}"`);
  }

  const prev = leaving && leaving.turn == null ? resolveIcon(leaving.name) : undefined;
  const enterCls = leaving ? (leaving.turn != null ? "jg-turnin" : "jg-enter") : undefined;
  const enterStyle = leaving?.turn != null ? ({ "--from": `${leaving.turn}deg` } as CSSProperties) : undefined;
  const settle = (e: React.AnimationEvent<SVGGElement>) => {
    if (e.target === e.currentTarget) setLeaving(null);
  };

  const svgStyle = {
    ...(snap ? { "--ji-snap": `${Math.round(snap * 1000) / 1000}px` } : null),
    ...style,
  } as CSSProperties;

  return (
    <svg
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
      style={svgStyle}
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      <g className="jsnap">
        {d ? (
          <g key={`in${leaving?.n ?? 0}`} className={enterCls ? `jl ${enterCls}` : "jl"} style={enterStyle} onAnimationEnd={leaving ? settle : undefined}>
            <Layers d={d} ctx={ctx} />
          </g>
        ) : (
          <rect x={5.25} y={5.25} width={13.5} height={13.5} rx={3} strokeDasharray="2 2" opacity={0.5} />
        )}
        {prev ? (
          <g key={`out${leaving?.n ?? 0}`} className="jl jg-exit">
            <Layers d={prev} ctx={{ ...ctx, uid: `${uid}p`, levelIndex: { i: 0 } }} />
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

export function iconDrawing(name: string): IconDrawing | undefined {
  return resolveIcon(name);
}
