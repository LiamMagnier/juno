"use client";

import * as React from "react";
import { applyBackingStore, watchCanvas, type CanvasSize, type RedrawReason } from "@/lib/canvas/canvas-lifecycle";

export interface CanvasRenderInfo extends CanvasSize {
  ctx: CanvasRenderingContext2D;
  reason: RedrawReason | "resize" | "invalidate";
}

/**
 * A 2D canvas that is always drawn at its box's real size and DPR, and drawn
 * again whenever the browser may have taken its pixels (context restored,
 * bfcache, tab shown, fonts loaded). The caller's `render` paints the CURRENT
 * state from scratch; it is called with the transform already set to CSS px.
 *
 * `host` defaults to the canvas itself. Returns `invalidate()` for state
 * changes the hook cannot see (the caller's own props or pointer).
 * See src/lib/canvas/canvas-lifecycle.ts for what each event guards against.
 */
export function useCanvasRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  render: (info: CanvasRenderInfo) => void,
  options: { hostRef?: React.RefObject<HTMLElement | null>; maxDpr?: number; onVisible?: (on: boolean) => void } = {},
) {
  const renderRef = React.useRef(render);
  const visibleRef = React.useRef(options.onVisible);
  React.useEffect(() => {
    renderRef.current = render;
    visibleRef.current = options.onVisible;
  });
  const state = React.useRef<{ size: CanvasSize | null; ctx: CanvasRenderingContext2D | null }>({ size: null, ctx: null });

  const paint = React.useCallback((reason: CanvasRenderInfo["reason"]) => {
    const { size, ctx } = state.current;
    if (!size || !ctx) return;
    ctx.setTransform(size.dpr, 0, 0, size.dpr, 0, 0);
    renderRef.current({ ...size, ctx, reason });
  }, []);

  const hostRef = options.hostRef;
  const maxDpr = options.maxDpr ?? 2;
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const host = hostRef?.current ?? canvas;
    state.current.ctx = canvas.getContext("2d");
    const dispose = watchCanvas(
      host,
      canvas,
      {
        resize: (size) => {
          state.current.size = size;
          applyBackingStore(canvas, size);
          paint("resize");
        },
        redraw: (reason) => paint(reason),
        visible: (on) => visibleRef.current?.(on),
      },
      { maxDpr },
    );
    return () => {
      dispose();
      state.current = { size: null, ctx: null };
    };
  }, [canvasRef, hostRef, maxDpr, paint]);

  return React.useCallback(() => paint("invalidate"), [paint]);
}
