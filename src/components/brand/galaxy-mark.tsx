"use client";

import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  GALAXY_COUNT_SMALL,
  GALAXY_ENTER_MS,
  GALAXY_EXIT_MS,
  GALAXY_STATIC_TIME,
  easeOutCubic,
  galaxyAngle,
  GALAXY_TRAIL_STEP,
  GALAXY_TRAIL_FADES,
  galaxyCoreBreath,
  galaxyField,
  galaxyProject,
  galaxyTwinkle,
  type GalaxyField,
} from "./galaxy-field";
import type { ThinkingPhase } from "./thinking-schedule";

export type { ThinkingPhase } from "./thinking-schedule";

export type GalaxyMarkProps = {
  /** The truthful runtime phase of the row this mark sits in. Thinking and working turn the galaxy. */
  phase: ThinkingPhase;
  /**
   * Accepted for a 1:1 swap with ThinkingMark. The galaxy turns continuously
   * while work is real, so a step needs no separate pass; the words beside it
   * carry the step.
   */
  eventKey?: string | number;
  /** CSS px. 14 to 20 beside text; 64 to 96 for a hero. */
  size?: number;
  /** Accessible name. Omit when adjacent text states the phase (it should): the mark is then hidden. */
  label?: string;
  /** Force reduced motion (galleries, tests); otherwise the OS setting is followed, live. */
  reducedMotion?: boolean;
  className?: string;
};

/* One field for every mark on the page: the generator is deterministic, so this is the galaxy. */
let FIELD: GalaxyField | null = null;
const field = () => (FIELD ??= galaxyField());

const PRESENCE_LIGHT: RGB = [45, 73, 201]; // #2d49c9
const PRESENCE_DARK: RGB = [151, 166, 230]; // #97a6e6
const WARM_LIGHT: RGB = [138, 106, 62]; // #8A6A3E
const WARM_DARK: RGB = [243, 217, 177]; // #F3D9B1

type RGB = [number, number, number];

function parseColor(value: string): RGB {
  const m = value.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [128, 128, 128];
}

const mix = (a: RGB, b: RGB, k: number): RGB => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const rgb = (c: RGB) => `rgb(${c[0] | 0} ${c[1] | 0} ${c[2] | 0})`;

const isPending = (p: ThinkingPhase) => p === "thinking" || p === "working";

/**
 * The galaxy thinking mark (GALAXY_SPEC.md): a small two-armed spiral of dots,
 * seen from above and turned, rotating differentially while the model is
 * thinking or working. It replaces the moving Continuum mark as the working
 * indicator only; the static Continuum stays the brand.
 *
 * One 2D canvas per mark, drawn on requestAnimationFrame only while it is on
 * screen and the tab is visible. Ink is the row's own colour (currentColor),
 * so it never outweighs its words; one accent, the presence blue, on ~8% of
 * arm stars. Reduced motion draws one still frame. Outside a pending phase the
 * galaxy slows to a stop over a short ease rather than cutting, and finished
 * or idle marks step back to 60% over the exit duration.
 */
export function GalaxyMark({ phase, size = 16, label, reducedMotion, className }: GalaxyMarkProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const phaseRef = useRef(phase);
  const wake = useRef<() => void>(() => {});

  // Phase changes wake the loop (it sleeps once a stopped galaxy has settled).
  useEffect(() => {
    phaseRef.current = phase;
    wake.current();
  }, [phase]);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const ctx = el.getContext("2d");
    if (!ctx) return;

    const mq = typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
    const reduced = () => reducedMotion ?? mq?.matches ?? false;

    let raf = 0;
    let last = 0;
    let s = GALAXY_STATIC_TIME; // galaxy clock, seconds
    let speed = isPending(phaseRef.current) ? 1 : 0;
    let dim = phaseRef.current === "finished" || phaseRef.current === "idle" ? 0.6 : 1;
    const mounted = performance.now();
    let inView = true;
    let ink: RGB = [128, 128, 128];
    let dark = false;
    let inkReadAt = -1;

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
      const { particles, core } = field();
      const list = size < 18 ? particles.slice(0, GALAXY_COUNT_SMALL) : particles;
      const half = (size / 2) * 0.95;
      const unit = size / 24;
      const cx = size / 2;
      const cy = size / 2;
      const enter = reduced() ? 1 : easeOutCubic((now - mounted) / GALAXY_ENTER_MS);
      const presence = dark ? PRESENCE_DARK : PRESENCE_LIGHT;
      // Small marks lift faint stars a touch so the disc still reads at 14-16 px.
      const lift = size < 20 ? 1.18 : 1;
      // Stars are fine points: at hero sizes a dot that scales with the mark turns the disc into a
      // clump of beads, so the dot grows slower than the galaxy (diameter ~ size/24 at 24 px, less above).
      const dotScale = size <= 24 ? 0.5 : 0.5 * Math.sqrt(24 / size);
      const minDot = 0.5 / dpr + 0.2;

      ctx.fillStyle = rgb(ink);
      for (const p of list) {
        const rr = p.r * (0.6 + 0.4 * enter);
        const angle = galaxyAngle(p.theta, p.r, s) + (1 - enter) * 0.9;
        const { x, y } = galaxyProject(rr, angle);
        const a = Math.min(1, p.alpha * galaxyTwinkle(p.i, s) * enter * dim * lift);
        if (a < 0.01) continue;
        ctx.fillStyle = p.accent ? rgb(presence) : rgb(ink);
        if (!p.dust) {
          // A short wake along the orbit, like a long exposure: it is what lets a field of dots read
          // as a disc that spins. Inner stars turn faster and leave longer wakes (native parity).
          const step = GALAXY_TRAIL_STEP * (0.6 + 0.8 * (1 - Math.min(p.r, 1)));
          GALAXY_TRAIL_FADES.forEach((fade, k) => {
            const w = galaxyProject(rr, angle + step * (k + 1));
            ctx.globalAlpha = a * fade;
            ctx.beginPath();
            ctx.arc(cx + w.x * half, cy + w.y * half, Math.max(minDot, p.size * unit * dotScale * (0.85 - 0.12 * k)), 0, Math.PI * 2);
            ctx.fill();
          });
        }
        ctx.globalAlpha = a;
        ctx.beginPath();
        ctx.arc(cx + x * half, cy + y * half, Math.max(minDot, p.size * unit * dotScale), 0, Math.PI * 2);
        ctx.fill();
      }

      // The core: one soft disc and six tight stars, slightly warm, breathing.
      const warm = mix(ink, dark ? WARM_DARK : WARM_LIGHT, 0.12);
      const breath = reduced() ? 1 : galaxyCoreBreath(s);
      const coreR = 0.11 * half * 1.6;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreR);
      const w = rgb(warm);
      g.addColorStop(0, w);
      g.addColorStop(0.45, w);
      g.addColorStop(1, `rgb(${warm[0] | 0} ${warm[1] | 0} ${warm[2] | 0} / 0)`);
      ctx.globalAlpha = 0.9 * breath * enter * dim;
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.ellipse(cx, cy, coreR, coreR * 0.78, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = w;
      for (const p of core) {
        const { x, y } = galaxyProject(p.r, galaxyAngle(p.theta, p.r, s));
        ctx.globalAlpha = 0.9 * breath * enter * dim;
        ctx.beginPath();
        ctx.arc(cx + x * half, cy + y * half, Math.max(minDot, p.size * unit * dotScale), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    const frame = (now: number) => {
      raf = 0;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
      last = now;
      const pending = isPending(phaseRef.current);
      const stepBack = phaseRef.current === "finished" || phaseRef.current === "idle";
      // Ease the clock's speed toward its target: a stop is a slowing, never a cut.
      const targetSpeed = pending ? 1 : 0;
      speed += (targetSpeed - speed) * (1 - Math.exp(-dt / 0.35));
      if (Math.abs(targetSpeed - speed) < 0.002) speed = targetSpeed;
      const targetDim = stepBack ? 0.6 : 1;
      dim += (targetDim - dim) * (1 - Math.exp(-dt / (GALAXY_EXIT_MS / 3000)));
      if (Math.abs(targetDim - dim) < 0.002) dim = targetDim;
      s += dt * speed;
      draw(now);
      const entering = now - mounted < GALAXY_ENTER_MS;
      const settled = speed === 0 && dim === targetDim && !entering;
      if (!settled && inView && document.visibilityState === "visible") raf = requestAnimationFrame(frame);
    };

    const start = () => {
      if (raf) return;
      if (reduced()) {
        s = GALAXY_STATIC_TIME;
        dim = phaseRef.current === "finished" || phaseRef.current === "idle" ? 0.6 : 1;
        draw(performance.now());
        return;
      }
      if (!inView || document.visibilityState !== "visible") {
        draw(performance.now());
        return;
      }
      last = 0;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };
    wake.current = () => {
      stop();
      start();
    };

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      io = new IntersectionObserver((entries) => {
        inView = entries.some((e) => e.isIntersecting);
        if (inView) start();
        else stop();
      });
      io.observe(el);
    }
    const onVisibility = () => (document.visibilityState === "visible" ? start() : stop());
    document.addEventListener("visibilitychange", onVisibility);
    const onMotion = () => wake.current();
    mq?.addEventListener("change", onMotion);
    // Theme flips repaint at once (the ink is otherwise re-read twice a second).
    const themeWatch = new MutationObserver(() => {
      inkReadAt = -1;
      if (!raf) draw(performance.now());
    });
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    start();
    return () => {
      stop();
      io?.disconnect();
      themeWatch.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      mq?.removeEventListener("change", onMotion);
      wake.current = () => {};
    };
  }, [size, reducedMotion]);

  return (
    <span
      className={cn("alevr-galaxy-mark inline-flex shrink-0 leading-none", className)}
      data-phase={phase}
      style={{ width: size, height: size }}
      {...(label ? { role: "img", "aria-label": label } : { "aria-hidden": true })}
    >
      <canvas ref={canvas} width={size} height={size} style={{ width: size, height: size, display: "block" }} />
    </span>
  );
}
