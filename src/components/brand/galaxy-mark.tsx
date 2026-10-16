"use client";

import * as React from "react";
import { watchCanvas } from "@/lib/canvas/canvas-lifecycle";
import { DURATION, SCRIPT_COLOR, TIMING_TOKENS } from "@/lib/design/tokens.generated";
import { TIMING } from "@/lib/interaction";
import { reducedMotionAt, subscribeReducedMotion } from "@/lib/motion-preference";
import { cn } from "@/lib/utils";
import { GALAXY_STATIC_TIME, easeOutCubic } from "./galaxy-field";
import { breathAt, galaxyCoreRadius, galaxyDots, galaxyStillKey, galaxyStillRule } from "./galaxy-frame";
import { galaxyRegistry, type GalaxyPriority, type GalaxyRegistry } from "./galaxy-registry";
import type { ThinkingPhase } from "./thinking-schedule";

export type { ThinkingPhase } from "./thinking-schedule";
export type { GalaxyPriority } from "./galaxy-registry";

/** What the mark shows (spec §3.4). */
export type GalaxyStatus = "running" | "needsYou" | "ready" | "blocked" | "idle";

/**
 * The status for a runtime phase, unless the caller names one. `waiting` is
 * a still, full-strength frame and NOT "needs you": the run line uses it for
 * every mark that does not own the loop, so needs-you must be asked for with
 * `status="needsYou"`.
 */
export function galaxyStatusFor(phase: ThinkingPhase, status?: Exclude<GalaxyStatus, "idle">): GalaxyStatus {
  if (status) return status;
  switch (phase) {
    case "thinking":
    case "working":
      return "running";
    case "finished":
      return "ready";
    case "error":
      return "blocked";
    default:
      return "idle";
  }
}

/** How strong a mark at rest is: a settled (finished or idle) or ready mark steps back to 60%. */
export function galaxyRestDim(phase: ThinkingPhase, status: GalaxyStatus): number {
  if (status === "running" || status === "needsYou" || status === "blocked") return 1;
  return status === "ready" || phase === "finished" || phase === "idle" ? GALAXY_SETTLED_DIM : 1;
}

const GALAXY_SETTLED_DIM = 0.6;

/** The motion constants of the mark (spec §3.4, P2 (12)). */
export const GALAXY_MOTION = {
  /** The entrance: a spiral in from 0.6 of the radius. */
  enterMs: DURATION.slow,
  /** The step back to 60% after a stop. */
  dimMs: DURATION.base,
  /** The exponential stop's time constant. */
  stopTauMs: 350,
  /** The running period, and the calmer one after `calmAfterMs` of continuous work. */
  periodMs: TIMING_TOKENS.loop.galaxy,
  calmPeriodMs: TIMING_TOKENS.loop.galaxyCalm,
  calmAfterMs: 20_000,
  settledDim: GALAXY_SETTLED_DIM,
} as const;

export type GalaxyMarkProps = {
  /** The truthful runtime phase of the row this mark sits in. Thinking and working turn the galaxy. */
  phase: ThinkingPhase;
  /** Accepted for a 1:1 swap with ThinkingMark; the galaxy turns continuously while work is real. */
  eventKey?: string | number;
  /** CSS px: 10 in rows, 12 in lines and plan rows, 14 in the live line; 64 to 96 for a hero. */
  size?: number;
  /** Accessible name. Omit when adjacent text states the phase (it should): the mark is then hidden. */
  label?: string;
  /** Override reduced motion (galleries, tests); otherwise follow the OS and app choice live. */
  reducedMotion?: boolean;
  /**
   * Its claim on one of the three animation slots: `live` for the TurnStatus
   * live line. Otherwise a row raises itself to `focus` while it is hovered
   * or holds focus, and is `other` the rest of the time.
   */
  priority?: GalaxyPriority;
  /** How long the reader watched the run, in ms: the ready check draws only past 10s. */
  watchedMs?: number;
  /**
   * Show a status rather than the phase's: `needsYou` (the hand, signal ink,
   * one pulse), `ready` (60%, or the drawn check after a watched run),
   * `blocked` (a still frame in the destructive ink).
   */
  status?: Exclude<GalaxyStatus, "idle">;
  className?: string;
  /** Tests: a registry other than the document's. */
  registry?: GalaxyRegistry;
};

type RGB = [number, number, number];

const fromHex = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB;
const PRESENCE_LIGHT = fromHex(SCRIPT_COLOR.presence.light);
const PRESENCE_DARK = fromHex(SCRIPT_COLOR.presence.dark);
const WARM_LIGHT = fromHex(SCRIPT_COLOR.galaxyCore.light);
const WARM_DARK = fromHex(SCRIPT_COLOR.galaxyCore.dark);

function parseColor(value: string): RGB {
  const m = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [128, 128, 128];
}
const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const rgb = (c: RGB) => `rgb(${c[0] | 0} ${c[1] | 0} ${c[2] | 0})`;

const HOST_SELECTOR = "[data-galaxy-host], a, button, [role='row'], [role='option'], [role='treeitem'], li";
/** Media and attribute changes after which the ink is re-read (spec P2 (12)). */
const INK_QUERIES = ["(prefers-contrast: more)", "(forced-colors: active)", "(prefers-color-scheme: dark)"] as const;

interface StillState {
  s: number;
  dim: number;
}

/**
 * The galaxy working mark (GALAXY_SPEC.md; spec D9, §3.4, P2 (12)): a small
 * two-armed spiral of dots that turns while the model is thinking or working.
 *
 * STILL BY DEFAULT. Whenever it is not animating, the mark is a static still
 * frame: one element whose CSS mask is the galaxy drawn as SVG
 * (galaxy-frame.ts), filled with currentColor. A canvas mounts only while the
 * mark holds one of the document's three animation slots (galaxy-registry.ts:
 * the live line first, then a hovered or focused row, then the rest) and
 * unmounts after the stop, so fifty running rows cost fifty spans, not fifty
 * canvases. Off screen, in a hidden tab, or under reduced motion (Tier C) it
 * holds the still frame.
 *
 * MOTION. Entrance: a 360ms spiral in from 0.6 of the radius. Running period
 * `--loop-galaxy` (2.4s), calming to `--loop-galaxy-calm` (4.8s) after 20s of
 * continuous work. A stop slows exponentially (tau 350ms), then the mark steps
 * back to 60% over 220.
 *
 * STATES. needsYou: the hand cross-fades in over 160 in the signal ink and
 * pulses once (1 → 1.08 → 1 over 560). ready: after a run the reader watched
 * for more than 10s, a check draws over 360 on --ease-spring after 120;
 * otherwise the still galaxy simply rests at 60%. blocked: a still frame in
 * the destructive ink. Status is never colour alone: the words beside the
 * mark carry it, and `label` names it when there are none.
 *
 * INK. The row's computed `color`, re-read when contrast, forced colours or
 * the colour scheme change and when <html>'s class or data-contrast change.
 * Under forced colours the mark is Highlight (brand.css).
 */
export function GalaxyMark({
  phase,
  status: statusProp,
  size = 16,
  label,
  reducedMotion,
  priority,
  watchedMs = 0,
  className,
  registry = galaxyRegistry,
}: GalaxyMarkProps) {
  const host = React.useRef<HTMLSpanElement>(null);
  const status = galaxyStatusFor(phase, statusProp);
  const restDim = galaxyRestDim(phase, status);
  const statusRef = React.useRef(status);
  statusRef.current = status;
  const restDimRef = React.useRef(restDim);
  restDimRef.current = restDim;
  const pending = status === "running";
  const [animating, setAnimating] = React.useState(false);
  const [still, setStill] = React.useState<StillState>(() => ({ s: GALAXY_STATIC_TIME, dim: restDim }));
  const stopping = React.useRef(false);
  const entryRef = React.useRef<ReturnType<GalaxyRegistry["register"]> | null>(null);
  const entered = React.useRef(false);
  const pendingSince = React.useRef<number | null>(null);
  if (pending && pendingSince.current === null) pendingSince.current = typeof performance === "undefined" ? 0 : performance.now();
  if (!pending) pendingSince.current = null;

  // Register with the cap; the registry says when this mark may animate.
  React.useEffect(() => {
    const el = host.current;
    if (!el) return;
    const reduced = () => reducedMotion ?? reducedMotionAt(el);
    let inView = true;
    let hovered = false;
    const visible = () => inView && document.visibilityState === "visible";
    const wants = () => !reduced() && (statusRef.current === "running" || stopping.current);
    const rank = (): GalaxyPriority => priority ?? (hovered ? "focus" : "other");
    const entry = registry.register({ wants: wants(), visible: visible(), priority: rank() }, (granted) => setAnimating(granted));
    entryRef.current = entry;
    const refresh = () => entry.update({ wants: wants(), visible: visible(), priority: rank() });

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((entries) => {
        inView = entries.some((e) => e.isIntersecting);
        refresh();
      });
      io.observe(el);
    }
    const onVisibility = () => refresh();
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribeMotion = subscribeReducedMotion(refresh);
    const motionWatch = typeof MutationObserver === "undefined" ? null : new MutationObserver(refresh);
    for (let ancestor = el.parentElement; ancestor && motionWatch; ancestor = ancestor.parentElement) {
      motionWatch.observe(ancestor, { attributes: true, attributeFilter: ["data-motion"] });
    }
    const row = priority ? null : el.parentElement?.closest<HTMLElement>(HOST_SELECTOR) ?? null;
    const enter = () => {
      hovered = true;
      refresh();
    };
    const leave = () => {
      hovered = row?.matches(":focus-within") ?? false;
      refresh();
    };
    row?.addEventListener("pointerenter", enter);
    row?.addEventListener("pointerleave", leave);
    row?.addEventListener("focusin", enter);
    row?.addEventListener("focusout", leave);
    return () => {
      io?.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribeMotion();
      motionWatch?.disconnect();
      row?.removeEventListener("pointerenter", enter);
      row?.removeEventListener("pointerleave", leave);
      row?.removeEventListener("focusin", enter);
      row?.removeEventListener("focusout", leave);
      entry.release();
      entryRef.current = null;
    };
  }, [registry, priority, reducedMotion]);

  // A phase change: running asks for a slot; leaving it keeps the slot only long enough to slow to a stop.
  React.useEffect(() => {
    const entry = entryRef.current;
    if (!entry) return;
    if (pending) stopping.current = false;
    else if (animating) stopping.current = true;
    const el = host.current;
    const reduced = reducedMotion ?? (el ? reducedMotionAt(el) : false);
    entry.update({ wants: !reduced && (pending || stopping.current) });
    if (!animating) setStill((prev) => (prev.dim === restDim ? prev : { s: prev.s, dim: restDim }));
  }, [pending, animating, reducedMotion, restDim]);

  const onSettled = React.useCallback((s: number, dim: number) => {
    stopping.current = false;
    setStill({ s, dim });
    entryRef.current?.update({ wants: false });
  }, []);
  const onRevoked = React.useCallback((s: number, dim: number) => setStill({ s, dim }), []);

  const showEntrance = animating && pending && !entered.current;
  if (animating) entered.current = true;

  const watched = watchedMs > TIMING.finishCheckMinWatched;
  const stillKey = galaxyStillKey(size, still.s);
  return (
    <span
      ref={host}
      className={cn("alevr-galaxy-mark relative inline-flex shrink-0 leading-none", className)}
      data-phase={phase}
      data-status={status}
      data-animating={animating ? "" : undefined}
      data-watched={status === "ready" && watched ? "" : undefined}
      style={{ width: size, height: size }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      {/* One rule per still frame, hoisted into <head> and deduplicated by
          `href` (React 19): fifty marks of one size share one mask. */}
      <style href={`alevr-galaxy-${stillKey}`} precedence="low">
        {galaxyStillRule(size, still.s)}
      </style>
      <span
        className="alevr-galaxy-still"
        data-galaxy-still={stillKey}
        style={{ "--galaxy-dim": still.dim, visibility: animating ? "hidden" : undefined } as React.CSSProperties}
      />
      {animating ? (
        <GalaxyCanvas
          size={size}
          statusRef={statusRef}
          restDimRef={restDimRef}
          startS={still.s}
          startDim={still.dim}
          entrance={showEntrance}
          pendingSince={pendingSince}
          onSettled={onSettled}
          onUnmount={onRevoked}
        />
      ) : null}
      {status === "needsYou" ? <HandGlyph size={size} /> : null}
      {status === "ready" && watched ? <CheckDraw size={size} /> : null}
    </span>
  );
}

/** The hand of "needs you" (spec §3.4), drawn on the 24-unit grid in the signal ink. */
function HandGlyph({ size }: { size: number }) {
  return (
    <svg className="alevr-galaxy-hand" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M8 12.5V6.75a1.25 1.25 0 0 1 2.5 0V11m0-5.75V4.75a1.25 1.25 0 0 1 2.5 0V11m0-5.25a1.25 1.25 0 0 1 2.5 0V11.5m0-3.25a1.25 1.25 0 0 1 2.5 0v5.25A6.5 6.5 0 0 1 11.5 20h-.6a5.5 5.5 0 0 1-4.3-2.07L4.5 15.3a1.3 1.3 0 0 1 1.94-1.72L8 15"
        stroke="currentColor"
        strokeWidth={size < 14 ? 2.2 : 1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The ready check, drawn once over 360 on --ease-spring after --hold-check (brand.css). */
function CheckDraw({ size }: { size: number }) {
  return (
    <svg className="alevr-galaxy-check" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} stroke="currentColor" strokeWidth={size < 14 ? 2.6 : 2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * The animating galaxy: mounted only while the mark holds a slot. It starts
 * from the clock the still frame shows, so the hand-off is seamless, and
 * reports where it stopped when it settles or is unmounted.
 */
function GalaxyCanvas({
  size,
  statusRef,
  restDimRef,
  startS,
  startDim,
  entrance,
  pendingSince,
  onSettled,
  onUnmount,
}: {
  size: number;
  statusRef: React.RefObject<GalaxyStatus>;
  restDimRef: React.RefObject<number>;
  startS: number;
  startDim: number;
  entrance: boolean;
  pendingSince: React.RefObject<number | null>;
  onSettled: (s: number, dim: number) => void;
  onUnmount: (s: number, dim: number) => void;
}) {
  const canvas = React.useRef<HTMLCanvasElement>(null);
  const callbacks = React.useRef({ onSettled, onUnmount });
  callbacks.current = { onSettled, onUnmount };

  React.useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext("2d");
    if (!el || !ctx) return;
    let raf = 0;
    let last = 0;
    let s = startS;
    const isRunning = () => statusRef.current === "running";
    let speed = isRunning() ? 1 : 0;
    let dim = startDim;
    const mounted = performance.now();
    let ink: RGB = [128, 128, 128];
    let dark = false;
    let inkReadAt = -1;
    let done = false;

    const readInk = (now: number) => {
      if (now - inkReadAt < 500) return;
      inkReadAt = now;
      ink = parseColor(getComputedStyle(el).color);
      dark = document.documentElement.classList.contains("dark") || (ink[0] + ink[1] + ink[2]) / 3 > 140;
    };

    const draw = (now: number) => {
      readInk(now);
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const px = Math.round(size * dpr);
      if (el.width !== px || el.height !== px) {
        el.width = px;
        el.height = px;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size, size);
      const enter = entrance ? easeOutCubic((now - mounted) / GALAXY_MOTION.enterMs) : 1;
      const presence = dark ? PRESENCE_DARK : PRESENCE_LIGHT;
      const breath = breathAt(s, false);
      const warm = mix(ink, dark ? WARM_DARK : WARM_LIGHT, 0.12);
      // The soft core.
      const c = size / 2;
      const coreR = galaxyCoreRadius(size);
      const g = ctx.createRadialGradient(c, c, 0, c, c, coreR);
      g.addColorStop(0, rgb(warm));
      g.addColorStop(0.45, rgb(warm));
      g.addColorStop(1, `rgb(${warm[0] | 0} ${warm[1] | 0} ${warm[2] | 0} / 0)`);
      ctx.globalAlpha = 0.9 * breath * enter * dim;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(c, c, coreR, coreR * 0.78, 0, 0, Math.PI * 2);
      ctx.fill();
      for (const d of galaxyDots(size, { s, enter, dim, breath, dpr })) {
        ctx.globalAlpha = d.alpha;
        ctx.fillStyle = d.core ? rgb(warm) : d.accent ? rgb(presence) : rgb(ink);
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      raf = 0;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      const running = isRunning();
      const since = pendingSince.current;
      const calm = running && since !== null && now - since > GALAXY_MOTION.calmAfterMs;
      const targetSpeed = running ? (calm ? GALAXY_MOTION.periodMs / GALAXY_MOTION.calmPeriodMs : 1) : 0;
      speed += (targetSpeed - speed) * (1 - Math.exp(-dt / (GALAXY_MOTION.stopTauMs / 1000)));
      if (Math.abs(targetSpeed - speed) < 0.002) speed = targetSpeed;
      const targetDim = running ? 1 : restDimRef.current;
      dim += (targetDim - dim) * (1 - Math.exp(-dt / (GALAXY_MOTION.dimMs / 3000)));
      if (Math.abs(targetDim - dim) < 0.002) dim = targetDim;
      s += dt * speed;
      draw(now);
      const entering = entrance && now - mounted < GALAXY_MOTION.enterMs;
      if (!running && speed === 0 && dim === targetDim && !entering) {
        done = true;
        callbacks.current.onSettled(s, dim);
        return;
      }
      raf = requestAnimationFrame(frame);
    };

    const repaint = () => {
      inkReadAt = -1;
      if (!raf) draw(performance.now());
    };
    const unwatch = watchCanvas(el, el, { resize: repaint, redraw: repaint }, { maxDpr: 3 });
    // The ink follows contrast, forced colours and the colour scheme at once.
    const queries = typeof window.matchMedia === "function" ? INK_QUERIES.map((q) => window.matchMedia(q)) : [];
    for (const q of queries) q.addEventListener?.("change", repaint);
    const themeWatch = new MutationObserver(repaint);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-contrast"] });
    draw(performance.now());
    raf = requestAnimationFrame(frame);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      unwatch();
      for (const q of queries) q.removeEventListener?.("change", repaint);
      themeWatch.disconnect();
      if (!done) callbacks.current.onUnmount(s, dim);
    };
    // The canvas lives for one slot grant; its starting values are read once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  return <canvas ref={canvas} width={size} height={size} className="alevr-galaxy-canvas" style={{ width: size, height: size, display: "block" }} />;
}
