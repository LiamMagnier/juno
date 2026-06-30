"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * A faint dotted grid background. Sizes to its own box; honors
 * prefers-reduced-motion and can opt into cursor reactivity when needed.
 */
export function DotField({
  className,
  spacing = 24,
  interactive = false,
}: {
  className?: string;
  spacing?: number;
  interactive?: boolean;
}) {
  const ref = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    let width = 0;
    let height = 0;
    let dots: { x: number; y: number }[] = [];
    const mouse = { x: -9999, y: -9999, active: false };
    let lastMove = 0;
    let lastPointerSample = 0;
    let raf = 0;

    const readColor = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    let fg = readColor("--foreground");
    let primary = readColor("--primary");
    let colorTick = 0;

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const nextDots: { x: number; y: number }[] = [];
      for (let x = spacing / 2; x < width; x += spacing) {
        for (let y = spacing / 2; y < height; y += spacing) {
          nextDots.push({ x, y });
        }
      }
      dots = nextDots;
    };

    const draw = () => {
      if (document.hidden) return;
      if (colorTick++ % 60 === 0) {
        fg = readColor("--foreground");
        primary = readColor("--primary");
      }
      ctx.clearRect(0, 0, width, height);
      const radius = 120;
      const radiusSq = radius * radius;
      for (const dot of dots) {
        let t = 0;
        if (mouse.active) {
          const dx = dot.x - mouse.x;
          const dy = dot.y - mouse.y;
          const dSq = dx * dx + dy * dy;
          t = dSq < radiusSq ? 1 - Math.sqrt(dSq) / radius : 0;
        }
        const r = 0.7 + t * 1.9;
        if (t > 0.02) {
          ctx.fillStyle = `hsl(${primary} / ${0.18 + t * 0.7})`;
        } else {
          ctx.fillStyle = `hsl(${fg} / 0.05)`;
        }
        ctx.beginPath();
        ctx.arc(dot.x, dot.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const loop = () => {
      draw();
      // keep animating briefly after the last movement, then idle to a static frame
      if (mouse.active && performance.now() - lastMove < 420) {
        raf = requestAnimationFrame(loop);
      } else {
        mouse.active = false;
        raf = 0;
        draw();
      }
    };

    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      if (document.hidden || now - lastPointerSample < 24) return;
      lastPointerSample = now;
      const rect = canvas.getBoundingClientRect();
      mouse.x = e.clientX - rect.left;
      mouse.y = e.clientY - rect.top;
      mouse.active = true;
      lastMove = now;
      if (!raf && !reduced) raf = requestAnimationFrame(loop);
    };
    const onLeave = () => {
      mouse.active = false;
    };
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (raf) cancelAnimationFrame(raf);
        raf = 0;
      } else {
        draw();
      }
    };

    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(canvas);
    resize();
    draw();

    document.addEventListener("visibilitychange", onVisibilityChange);
    if (!reduced && interactive) {
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("pointerleave", onLeave, { passive: true });
    }

    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [interactive, spacing]);

  return <canvas ref={ref} className={cn("pointer-events-none block h-full w-full", className)} aria-hidden="true" />;
}
