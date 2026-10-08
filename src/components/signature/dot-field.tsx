"use client";

import * as React from "react";
import { useCanvasRenderer } from "@/hooks/use-canvas-renderer";
import { cn } from "@/lib/utils";

/**
 * A faint dotted grid background. Sizes to its own box; honors
 * prefers-reduced-motion and can opt into cursor reactivity when needed.
 *
 * Sizing, DPR, context loss and page restores come from `useCanvasRenderer`:
 * the box is measured at its layout size (a dialog scaling in no longer bakes
 * its mid-animation size into the bitmap), a 0 × 0 box keeps its last frame,
 * and the grid is drawn again whenever the browser may have dropped it.
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
  const mouse = React.useRef({ x: -9999, y: -9999, active: false });
  const colors = React.useRef<{ fg: string; primary: string; at: number }>({ fg: "", primary: "", at: -1 });

  const invalidate = useCanvasRenderer(
    ref,
    ({ ctx, w, h }) => {
      const now = performance.now();
      if (now - colors.current.at > 1000) {
        const root = getComputedStyle(document.documentElement);
        colors.current = { fg: root.getPropertyValue("--foreground").trim(), primary: root.getPropertyValue("--primary").trim(), at: now };
      }
      const { fg, primary } = colors.current;
      const m = mouse.current;
      ctx.clearRect(0, 0, w, h);
      const radius = 120;
      const radiusSq = radius * radius;
      for (let x = spacing / 2; x < w; x += spacing) {
        for (let y = spacing / 2; y < h; y += spacing) {
          let t = 0;
          if (m.active) {
            const dx = x - m.x;
            const dy = y - m.y;
            const dSq = dx * dx + dy * dy;
            t = dSq < radiusSq ? 1 - Math.sqrt(dSq) / radius : 0;
          }
          ctx.fillStyle = t > 0.02 ? `hsl(${primary} / ${0.18 + t * 0.7})` : `hsl(${fg} / 0.05)`;
          ctx.beginPath();
          ctx.arc(x, y, 0.7 + t * 1.9, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    },
    { maxDpr: 1.5 },
  );

  // Spacing is read at draw time; redraw when it changes.
  React.useEffect(() => invalidate(), [spacing, invalidate]);

  // Theme flips repaint at once.
  React.useEffect(() => {
    const watch = new MutationObserver(() => {
      colors.current.at = -1;
      invalidate();
    });
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style", "data-accent"] });
    return () => watch.disconnect();
  }, [invalidate]);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !interactive || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let lastMove = 0;
    let lastSample = 0;
    const loop = () => {
      invalidate();
      // Keep animating briefly after the last movement, then idle to a static frame.
      if (mouse.current.active && performance.now() - lastMove < 420) {
        raf = requestAnimationFrame(loop);
      } else {
        mouse.current.active = false;
        raf = 0;
        invalidate();
      }
    };
    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      if (document.hidden || now - lastSample < 24) return;
      lastSample = now;
      const rect = canvas.getBoundingClientRect();
      mouse.current = { x: e.clientX - rect.left, y: e.clientY - rect.top, active: true };
      lastMove = now;
      if (!raf) raf = requestAnimationFrame(loop);
    };
    const onLeave = () => {
      mouse.current.active = false;
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerleave", onLeave, { passive: true });
    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerleave", onLeave);
    };
  }, [interactive, invalidate]);

  return <canvas ref={ref} className={cn("pointer-events-none block size-full", className)} aria-hidden="true" />;
}
