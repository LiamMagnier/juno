"use client";

/*
 * ALEVR BRAND, STAND-IN.
 *
 * Every screen takes the Alevr identity from this file only: the Continuum
 * mark, the wordmark and its lockups, the Orbit and Code glyphs, and the
 * ThinkingMark. The production components are being built on the trunk under
 * src/components/brand/; until they land, these are clearly marked stand-ins
 * (the Continuum geometry is traced from the raster reference, see
 * brand-geometry.ts). When the production exports exist, re-export them here
 * and the screens follow without another change.
 *
 * Contracts (docs/rework/brand, D-035..D-037):
 *   ContinuumMark   uniform graphite on light, pale neutral on dark (the ink);
 *                   optical masters below 48 px widen the open channels so they
 *                   stay visible at 16, 20 and 24 px.
 *   AlevrWordmark   upright Newsreader 600, never italic.
 *   AlevrLogo       mark + wordmark, the gap about 1.5 path widths; an optional
 *                   product word (Chat, Orbit, Code) in the same serif at 400.
 *   OrbitGlyph      two separated open elliptical arcs (b/a = 0.618), static.
 *   CodeGlyph       opposed square brackets with an inset cursor.
 *   ThinkingMark    the Continuum, stationary, beside truthful phase words: a
 *                   tonal path handoff (220 ms tone, 70 ms stagger, one pass on
 *                   start, real events may ask for another, coalesced to at most
 *                   one every 1.6 s), then a quiet stable pose. No rotation,
 *                   glow, shimmer or loop. Static under reduced motion. Hidden
 *                   (off screen, background tab): no pass runs.
 */

import * as React from "react";
import { CONTINUUM_BLADES, CONTINUUM_H, CONTINUUM_W } from "./brand-geometry";
import { useReduced } from "./motion";

/** True while the brand pieces here are the stand-ins (shown on the brand scene). */
export const BRAND_STANDIN = true;

const cleanId = (id: string) => `jb${id.replace(/[^a-zA-Z0-9_-]/g, "")}`;

/**
 * How much to erode each blade (a stroke of the mask, in viewBox units of the
 * 100-wide drawing) so the channels between blades stay open at small sizes.
 * The raster's channels are about 2.4 units; at 20 px that is half a pixel.
 */
function opticalErosion(width: number): number {
  const target = width <= 20 ? 1 : width <= 32 ? 1.15 : 1.4;
  return Math.max(0, Math.round((target * (CONTINUUM_W / width) - 2.4) * 100) / 100);
}

export interface ContinuumProps {
  /** The mark's width in px (its height follows, 0.68 of it). */
  size?: number;
  className?: string;
  /** Give it a name only when nothing beside it says "Alevr". */
  title?: string;
  /** Draw the optical master for this size (default) or the raw geometry. */
  optical?: boolean;
  style?: React.CSSProperties;
  /** Internal: per-blade class names and attributes (the ThinkingMark). */
  bladeProps?: (i: number) => React.SVGProps<SVGPathElement>;
  svgProps?: React.SVGProps<SVGSVGElement>;
}

export function ContinuumMark({ size = 20, className, title, optical = true, style, bladeProps, svgProps }: ContinuumProps) {
  const rid = React.useId();
  const id = cleanId(rid);
  const h = Math.round(((size * CONTINUUM_H) / CONTINUUM_W) * 100) / 100;
  const erode = optical ? opticalErosion(size) : 0;
  return (
    <svg
      width={size}
      height={h}
      viewBox={`0 0 ${CONTINUUM_W} ${CONTINUUM_H}`}
      className={className ? `jn-cmk ${className}` : "jn-cmk"}
      style={style}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
      {...svgProps}
    >
      {erode ? (
        <defs>
          <mask id={id} maskUnits="userSpaceOnUse" x={-4} y={-4} width={CONTINUUM_W + 8} height={CONTINUUM_H + 8}>
            {CONTINUUM_BLADES.map((d, i) => (
              <path key={`f${i}`} d={d} fill="#fff" />
            ))}
            {CONTINUUM_BLADES.map((d, i) => (
              <path key={`s${i}`} d={d} fill="none" stroke="#000" strokeWidth={erode} strokeLinejoin="round" />
            ))}
          </mask>
        </defs>
      ) : null}
      <g mask={erode ? `url(#${id})` : undefined}>
        {CONTINUUM_BLADES.map((d, i) => (
          <path key={i} d={d} className="jn-cmk__b" {...bladeProps?.(i)} />
        ))}
      </g>
    </svg>
  );
}

/** "Alevr" in upright Newsreader 600, optically kerned. */
export function AlevrWordmark({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <span className={className ? `jn-alevr ${className}` : "jn-alevr"} style={{ fontSize: size }}>
      Alevr
    </span>
  );
}

/**
 * The application lockup: Continuum + Alevr. `product` adds the product word
 * (Alevr Chat, Alevr Orbit, Alevr Code) for explanatory places; navigation
 * uses the bare lockup. The mark is sized from the wordmark so the pair
 * always balances: about 1.1 em wide, its gap about 1.5 path widths.
 */
export function AlevrLogo({
  size = 20,
  product,
  className,
  label = true,
}: {
  /** The wordmark's font size in px. */
  size?: number;
  product?: "Chat" | "Orbit" | "Code";
  className?: string;
  /** Read as "Alevr" (default) or hidden (when the surrounding control already names it). */
  label?: boolean;
}) {
  const mark = Math.round(size * 1.12);
  return (
    <span className={className ? `jn-lockup ${className}` : "jn-lockup"} style={{ "--lk": `${size}px` } as React.CSSProperties} aria-label={label ? (product ? `Alevr ${product}` : "Alevr") : undefined} role={label ? "img" : undefined} aria-hidden={label ? undefined : true}>
      <ContinuumMark size={mark} className="jn-lockup__mark" />
      <span className="jn-alevr" style={{ fontSize: size }} aria-hidden="true">
        Alevr
      </span>
      {product ? (
        <span className="jn-lockup__product" style={{ fontSize: size }} aria-hidden="true">
          {product}
        </span>
      ) : null}
    </span>
  );
}

/* ———————————————————————— Product glyphs (on the icon set's grid) ———————————————————————— */

const strokeFor = (size: number) => (size >= 18 ? 1.5 : size >= 16 ? 1.25 : 1.125);

/** An ellipse point at parameter t (degrees), on a 24 grid. */
function ellipsePoint(t: number, cx: number, cy: number, rx: number, ry: number, rot: number): [number, number] {
  const a = (t * Math.PI) / 180;
  const r = (rot * Math.PI) / 180;
  const x = rx * Math.cos(a);
  const y = ry * Math.sin(a);
  return [cx + x * Math.cos(r) - y * Math.sin(r), cy + x * Math.sin(r) + y * Math.cos(r)];
}

function arc(t0: number, t1: number, cx: number, cy: number, rx: number, ry: number, rot: number): string {
  const [x0, y0] = ellipsePoint(t0, cx, cy, rx, ry, rot);
  const [x1, y1] = ellipsePoint(t1, cx, cy, rx, ry, rot);
  const large = Math.abs(t1 - t0) > 180 ? 1 : 0;
  const f = (v: number) => Math.round(v * 100) / 100;
  return `M${f(x0)} ${f(y0)}A${rx} ${ry} ${rot} ${large} 1 ${f(x1)} ${f(y1)}`;
}

/** Orbit: two separated open arcs of one ellipse (b/a = 0.618, tilted 22 degrees), in equilibrium. Never a spinner. */
export const ORBIT_ARCS = [arc(198, 334, 12, 12, 9.5, 5.87, -22), arc(18, 154, 12, 12, 9.5, 5.87, -22)];

export function OrbitGlyph({ size = 16, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className ? `jn-pglyph ${className}` : "jn-pglyph"} fill="none" stroke="currentColor" strokeWidth={(strokeFor(size) * 24) / size} strokeLinecap="round" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      {ORBIT_ARCS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

/** Code: opposed square brackets with an inset cursor. */
export function CodeGlyph({ size = 16, className, title }: { size?: number; className?: string; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className ? `jn-pglyph ${className}` : "jn-pglyph"} fill="none" stroke="currentColor" strokeWidth={(strokeFor(size) * 24) / size} strokeLinecap="round" strokeLinejoin="round" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
      <path d="M8 4.75H5.75v14.5H8" />
      <path d="M16 4.75h2.25v14.5H16" />
      <path d="M12 9v6" />
    </svg>
  );
}

/* ———————————————————————————— ThinkingMark ———————————————————————————— */

export type ThinkingState = "active" | "done" | "waiting" | "error";

/** The handoff's tuning (MOTION_AND_THINKING): a tone step, the stagger between paths, the coalescing window. */
export const HANDOFF = { tone: 220, stagger: 70, coalesce: 1600 } as const;

/**
 * The Continuum as the thinking indicator. It never moves: on thinking start
 * one pass of tone runs through the blades clockwise from the top (each
 * shifts toward the presence ink for 220 ms and hands on 70 ms later), and
 * the last blade keeps a quiet presence tone while the work is live. Each new
 * real event (`pulse` increments: a phase change, a tool result) may ask for
 * another pass; requests inside 1.6 s of the last pass coalesce into one.
 * `done` settles once to the plain ink; `waiting` and `error` are still.
 * Decorative: the words beside it carry the meaning.
 */
export function ThinkingMark({
  size = 20,
  state = "active",
  pulse = 0,
  className,
}: {
  size?: number;
  state?: ThinkingState;
  /** Increment on each real event that should hand attention on. */
  pulse?: number;
  className?: string;
}) {
  const reduced = useReduced();
  const ref = React.useRef<SVGSVGElement | null>(null);
  const [pass, setPass] = React.useState(0);
  const last = React.useRef(-Infinity);
  const pending = React.useRef<number | null>(null);
  const visible = React.useRef(true);

  React.useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => (visible.current = e.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const request = React.useCallback(() => {
    if (reduced) return;
    const run = () => {
      pending.current = null;
      if (!visible.current || document.hidden) return;
      last.current = performance.now();
      setPass((p) => p + 1);
    };
    const wait = last.current + HANDOFF.coalesce - performance.now();
    if (wait <= 0) run();
    else if (pending.current === null) pending.current = window.setTimeout(run, wait);
  }, [reduced]);

  // One pass on start, and one per real event (coalesced).
  React.useEffect(() => {
    if (state === "active") request();
  }, [state, pulse, request]);
  React.useEffect(
    () => () => {
      if (pending.current !== null) window.clearTimeout(pending.current);
    },
    [],
  );

  const parity = pass === 0 ? undefined : pass % 2 ? "a" : "b";
  return (
    <ContinuumMark
      size={size}
      className={className ? `jn-tm ${className}` : "jn-tm"}
      svgProps={{
        ref,
        "data-state": state,
        "data-pass": state === "active" && !reduced ? parity : undefined,
      } as React.SVGProps<SVGSVGElement>}
      bladeProps={(i) => ({ style: { "--i": i } as React.CSSProperties, "data-last": i === CONTINUUM_BLADES.length - 1 ? "" : undefined } as React.SVGProps<SVGPathElement>)}
    />
  );
}
