"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

export type OrbStatus = "idle" | "listening" | "thinking" | "speaking" | "error";

const AMP: Record<OrbStatus, number> = { idle: 0.18, listening: 0.6, thinking: 0.42, speaking: 1, error: 0.1 };

/** A sphere of dots whose density/brightness pulse with the conversation state. */
export function VoiceOrb({ status, className }: { status: OrbStatus; className?: string }) {
  const ref = React.useRef<HTMLCanvasElement>(null);
  const statusRef = React.useRef(status);
  statusRef.current = status;

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    let size = 0;
    const particles = Array.from({ length: 130 }, () => ({
      ang: Math.random() * Math.PI * 2,
      baseR: 0.56 + Math.random() * 0.44,
      spd: (Math.random() - 0.5) * 0.0016,
      phase: Math.random() * Math.PI * 2,
      r: 0.8 + Math.random() * 1.4,
    }));

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      size = rect.width;
      canvas.width = Math.floor(size * dpr);
      canvas.height = Math.floor(size * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    let raf = 0;
    let amp = AMP[statusRef.current];

    const frame = (t: number) => {
      const target = AMP[statusRef.current];
      amp += (target - amp) * 0.06;
      const primary = getComputedStyle(document.documentElement).getPropertyValue("--primary").trim();
      const cx = size / 2;
      const cy = size / 2;
      const R = size * 0.4;
      ctx.clearRect(0, 0, size, size);

      // soft central glow
      const grad = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, R * 1.15);
      grad.addColorStop(0, `hsl(${primary} / ${0.18 + amp * 0.18})`);
      grad.addColorStop(1, `hsl(${primary} / 0)`);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size, size);

      for (const p of particles) {
        p.ang += p.spd * (0.4 + amp);
        const pulse = 1 + Math.sin(t * 0.002 + p.phase) * 0.07 * (0.4 + amp);
        const rr = R * p.baseR * pulse;
        const x = cx + Math.cos(p.ang) * rr;
        const y = cy + Math.sin(p.ang) * rr;
        const depth = (Math.sin(p.ang) + 1) / 2; // fake front/back shading
        ctx.fillStyle = `hsl(${primary} / ${0.25 + depth * 0.55 * (0.4 + amp)})`;
        ctx.beginPath();
        ctx.arc(x, y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(frame);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();
    if (reduced) {
      frame(0);
      cancelAnimationFrame(raf);
      raf = 0;
    } else {
      raf = requestAnimationFrame(frame);
    }

    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);

  return <canvas ref={ref} className={cn("block aspect-square w-full", className)} aria-hidden="true" />;
}
