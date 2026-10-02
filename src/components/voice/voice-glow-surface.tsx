"use client";

import * as React from "react";
import { useTheme } from "next-themes";

import { usePrefersReducedMotion } from "@/components/effects/use-effect-theme";
import {
  createGlowState,
  frameVector,
  glowFrame,
  isDark,
  sameFrame,
  simulateGlow,
  stepGlow,
  type GlowInput,
  type GlowMode,
  type GlowState,
} from "@/components/voice/voice-glow-engine";
import { resolveGlowPalette, type ResolvedGlowPalette } from "@/components/voice/voice-glow-palette";
import { GLOW_MARGIN, glowRenderer, type GlowVariant } from "@/components/voice/voice-glow-renderer";
import { VoiceGlowStageContext, type GlowLevel } from "@/components/voice/voice-glow-stage";
import { cn } from "@/lib/utils";

/* ————————————————————— one animation loop for every glow ————————————————————— */

type Tick = (now: number) => void;
const ticks = new Set<Tick>();
let raf = 0;

function run(now: number) {
  raf = 0;
  for (const tick of Array.from(ticks)) tick(now);
  if (ticks.size > 0) raf = requestAnimationFrame(run);
}

function schedule(tick: Tick) {
  ticks.add(tick);
  if (!raf) raf = requestAnimationFrame(run);
}

function unschedule(tick: Tick) {
  ticks.delete(tick);
  if (ticks.size === 0 && raf) {
    cancelAnimationFrame(raf);
    raf = 0;
  }
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(false);
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const update = () => setMatches(mql.matches);
    update();
    mql.addEventListener?.("change", update);
    return () => mql.removeEventListener?.("change", update);
  }, [query]);
  return matches;
}

interface Geometry {
  /** Canvas box in CSS px, relative to the glow's root. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** The composer's border box inside the canvas, CSS px. */
  rect: [number, number, number, number];
  radius: number;
  dpr: number;
}

/**
 * THE VOICE LIGHT ON A SURFACE. Wraps exactly one element that carries the
 * radius (the composer, or the call bar) and draws the light at and outside
 * its edge on a canvas laid over it. The element itself is not touched: its
 * own 1px V3 edge, its surface and every word inside stay crisp, because the
 * light is zero inside the box apart from a 2.5px rim.
 *
 * Cost: a frame is drawn only when it differs from the last one. A silent,
 * muted or off light draws nothing; off and muted stop the loop entirely, as
 * does reduced motion once a pose is reached. Offscreen or in a hidden tab
 * the loop is not scheduled at all.
 */
export function VoiceGlowSurface({
  mode,
  levels,
  variant: variantProp,
  className,
  children,
}: {
  mode: GlowMode;
  levels: { you?: GlowLevel | null; alevr?: GlowLevel | null };
  variant?: GlowVariant;
  className?: string;
  children: React.ReactNode;
}) {
  const stage = React.useContext(VoiceGlowStageContext);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const prefersReduced = usePrefersReducedMotion();
  const prefersSolid = useMediaQuery("(prefers-reduced-transparency: reduce)");
  const { resolvedTheme } = useTheme();
  const reduced = stage?.reduced ?? prefersReduced;
  const solid = stage?.solid ?? prefersSolid;
  const variant = variantProp ?? stage?.variant ?? "edge";
  const clock = stage?.clock;
  const stageLevels = stage?.levels;
  const modeAt = stage?.modeAt;
  const [fallback, setFallback] = React.useState(false);

  // Everything the loop reads, current without re-subscribing it.
  const live = React.useRef({ mode, levels, variant, reduced, solid, clock, stageLevels, modeAt });
  React.useLayoutEffect(() => {
    live.current = { mode, levels, variant, reduced, solid, clock, stageLevels, modeAt };
  });

  const geometry = React.useRef<Geometry | null>(null);
  const palette = React.useRef<ResolvedGlowPalette | null>(null);
  const state = React.useRef<GlowState>(createGlowState());
  const drawn = React.useRef<number[] | null>(null);
  const ctx2d = React.useRef<CanvasRenderingContext2D | null>(null);
  const visible = React.useRef(true);
  const lastNow = React.useRef(0);
  const tickRef = React.useRef<Tick | null>(null);

  const draw = React.useCallback((vector: number[], force = false) => {
    const canvas = canvasRef.current;
    const geo = geometry.current;
    const pal = palette.current;
    if (!canvas || !geo || !pal) return;
    if (!force && sameFrame(drawn.current, vector)) return;
    const wasDark = drawn.current ? isDark(drawn.current) : true;
    drawn.current = vector;
    if (!ctx2d.current) ctx2d.current = canvas.getContext("2d");
    const ctx = ctx2d.current;
    if (!ctx) return;
    if (isDark(vector)) {
      if (!wasDark || force) ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const renderer = glowRenderer();
    if (!renderer) {
      setFallback(true);
      return;
    }
    const { variant: v, solid: s } = live.current;
    renderer.draw(ctx, {
      width: canvas.width,
      height: canvas.height,
      dpr: geo.dpr,
      rect: geo.rect,
      radius: geo.radius,
      variant: v,
      frame: vector,
      palette: pal,
      solid: s,
    });
  }, []);

  const inputAt = React.useCallback((ms: number): GlowInput => {
    const { mode: m, levels: lv, reduced: r, stageLevels: sl, modeAt: at } = live.current;
    const you = sl?.you ?? lv.you;
    const alevr = sl?.alevr ?? lv.alevr;
    return { mode: at ? at(ms) : m, you: you ? you(ms) : 0, alevr: alevr ? alevr(ms) : 0, reduced: r };
  }, []);

  /** Draw the moment the stage clock is frozen at, simulated from silence. */
  const renderFrozen = React.useCallback(() => {
    const c = live.current.clock;
    if (!c) return;
    const s = simulateGlow(c.now(), inputAt);
    state.current = s;
    draw(frameVector(glowFrame(s, live.current.reduced)), true);
  }, [draw, inputAt]);

  const stop = React.useCallback(() => {
    if (tickRef.current) unschedule(tickRef.current);
    tickRef.current = null;
  }, []);

  const start = React.useCallback(() => {
    if (tickRef.current || live.current.clock?.frozen) return;
    if (!visible.current || (typeof document !== "undefined" && document.hidden)) return;
    lastNow.current = 0;
    const tick: Tick = (now) => {
      const dt = lastNow.current ? (now - lastNow.current) / 1000 : 1 / 60;
      lastNow.current = now;
      const { clock: c, reduced: r, mode: m } = live.current;
      const input = inputAt(c ? c.now() : now);
      const s = stepGlow(state.current, input, dt);
      const vector = frameVector(glowFrame(s, r));
      const settledBefore = sameFrame(drawn.current, vector);
      draw(vector);
      // Nothing more can change without new props: stop until they arrive.
      // Off and muted hear nothing; reduced motion ignores levels altogether.
      if (settledBefore && (m === "off" || m === "muted" || r) && s.thinkT < 0) stop();
    };
    tickRef.current = tick;
    schedule(tick);
  }, [draw, inputAt, stop]);


  // Geometry: the wrapped element's border box and radius, measured on resize only.
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    const child = root?.firstElementChild as HTMLElement | null;
    if (!root || !canvas || !child || child === canvas) return;
    const measure = () => {
      const w = child.offsetWidth;
      const h = child.offsetHeight;
      if (w === 0 || h === 0) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const m = GLOW_MARGIN;
      const raw = parseFloat(getComputedStyle(child).borderTopLeftRadius) || 0;
      const geo: Geometry = {
        left: child.offsetLeft - m,
        top: child.offsetTop - m,
        width: w + 2 * m,
        height: h + 2 * m,
        rect: [m, m, w, h],
        radius: Math.min(raw, w / 2, h / 2),
        dpr,
      };
      const prev = geometry.current;
      geometry.current = geo;
      canvas.style.left = `${geo.left}px`;
      canvas.style.top = `${geo.top}px`;
      canvas.style.width = `${geo.width}px`;
      canvas.style.height = `${geo.height}px`;
      const pw = Math.round(geo.width * dpr);
      const ph = Math.round(geo.height * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      if (!prev || prev.width !== geo.width || prev.height !== geo.height || prev.radius !== geo.radius || prev.dpr !== dpr) {
        if (drawn.current) draw(drawn.current, true);
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(child);
    ro.observe(root);
    return () => ro.disconnect();
  }, [draw]);

  // Palette: the tokens as this element resolves them (a `.dark` subtree included).
  React.useLayoutEffect(() => {
    const root = rootRef.current;
    const canvas = canvasRef.current;
    if (!root || !canvas) return;
    const style = getComputedStyle(root);
    const pal = resolveGlowPalette((t) => style.getPropertyValue(t), resolvedTheme === "dark" ? "dark" : "light");
    palette.current = pal;
    canvas.style.mixBlendMode = pal.dark && !solid ? "plus-lighter" : "normal";
    if (drawn.current) draw(drawn.current, true);
  }, [resolvedTheme, solid, draw]);

  // Visibility: not scheduled offscreen or in a hidden tab.
  React.useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        visible.current = entry?.isIntersecting ?? true;
        if (visible.current) start();
        else stop();
      },
      { rootMargin: "64px" }
    );
    io.observe(root);
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      stop();
    };
  }, [start, stop]);

  // Inputs changed: a frozen stage redraws its moment; a live one wakes the loop.
  React.useEffect(() => {
    if (clock?.frozen) {
      renderFrozen();
      return;
    }
    start();
  }, [mode, levels.you, levels.alevr, variant, reduced, solid, clock, stageLevels, modeAt, renderFrozen, start]);

  return (
    <div
      ref={rootRef}
      className={cn("voice-glow", className ?? "relative w-full rounded-composer")}
      data-voice-glow={mode}
      data-voice-glow-fallback={fallback ? "" : undefined}
    >
      {children}
      <canvas ref={canvasRef} aria-hidden="true" className="voice-glow-canvas" />
    </div>
  );
}
