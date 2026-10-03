"use client";

import * as React from "react";
import type { MotionValue } from "framer-motion";
import { DotCanvas } from "./dot-engine";
import { ConstructionScene, RingsScene, type ArcSpec, type LineSpec, type RingSpec } from "./dot-scenes";

/**
 * The construction as a dot matrix: Alevr's drawing (nested orbits at a 1.5
 * ratio on the ℵ number line, one presence trajectory), rasterised onto a fine
 * grid of dots and seen at an isometric diagonal. It draws itself on ring by
 * ring on the homepage's beat, the dots settling in as the pen passes, then
 * sways very slowly while the trajectory travels its orbit.
 *
 * The canvas fills its container (absolutely positioned: no layout shift) and
 * is hidden from assistive technology. Placement, scale, pitch and colour are
 * CSS (dot-construction.css): `--construction-x/-y` place the origin as
 * fractions of the box, `--construction-span` is the width the old 1500-unit
 * drawing spans (default: the box's width), `--construction-zoom` scales it,
 * `--dots-pitch` spaces the dots, and `--dots-ink/-presence/-sub/-strength/
 * -glow` colour them. Reduced motion, and `animate={false}`, draw the final
 * frame once and never schedule another.
 */
export function DotConstruction({
  ticks = true,
  trajectory = true,
  axis = true,
  animate = true,
  parallax = false,
  zoom,
  paused = false,
  className,
}: {
  ticks?: boolean;
  trajectory?: boolean;
  axis?: boolean;
  animate?: boolean;
  /** A few degrees of eased pointer tilt. Public hero surfaces only, never product pages. */
  parallax?: boolean;
  /** A live zoom (the hero's scroll), redrawn crisp rather than scaled as a bitmap. */
  zoom?: MotionValue<number>;
  /** Hold the drawing where it is and stop scheduling frames (it is faded out under another view). */
  paused?: boolean;
  className?: string;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const instRef = React.useRef<DotCanvas | null>(null);
  const zoomRef = React.useRef(zoom);
  React.useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  const makeScene = React.useCallback(
    () =>
      new ConstructionScene({
        ticks,
        trajectory,
        axis,
        animate,
        parallax,
        zoom: () => zoomRef.current?.get() ?? 1,
      }),
    [ticks, trajectory, axis, animate, parallax],
  );

  React.useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const inst = new DotCanvas(host, canvas, makeScene());
    instRef.current = inst;
    return () => {
      inst.destroy();
      instRef.current = null;
    };
    // The instance lives as long as the element; option changes swap its scene below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const first = React.useRef(true);
  React.useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    instRef.current?.setScene(makeScene());
  }, [makeScene]);

  React.useEffect(() => {
    instRef.current?.setPaused(paused);
  }, [paused]);

  React.useEffect(() => {
    if (!zoom) return;
    return zoom.on("change", () => instRef.current?.invalidate());
  }, [zoom]);

  return (
    <div ref={hostRef} className={className ? `alv-dots ${className}` : "alv-dots"} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}

/**
 * Flat orbits in the same dot language, for drawings whose rings carry
 * things placed on them (Orbit's agents, Memory's topics, the frame chooser):
 * ellipses in fractions of the box, optional lines and presence arcs.
 */
export function DotRings({
  rings,
  lines,
  arcs,
  animate = true,
  progress,
  stagger,
  draw,
  delay,
  start,
  className,
}: {
  rings: RingSpec[];
  lines?: LineSpec[];
  arcs?: ArcSpec[];
  animate?: boolean;
  /** Scroll-driven draw-on (0..1) instead of the clock. */
  progress?: MotionValue<number>;
  stagger?: number;
  draw?: number;
  delay?: number;
  start?: number;
  className?: string;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const instRef = React.useRef<DotCanvas | null>(null);
  const sceneRef = React.useRef<RingsScene | null>(null);
  const progressRef = React.useRef(progress);
  React.useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  const opts = React.useMemo(
    () => ({
      rings,
      lines,
      arcs,
      animate,
      stagger,
      draw,
      delay,
      start,
      progress: progress ? () => progressRef.current?.get() ?? 1 : undefined,
    }),
    [rings, lines, arcs, animate, stagger, draw, delay, start, progress],
  );

  React.useEffect(() => {
    const host = hostRef.current;
    const canvas = canvasRef.current;
    if (!host || !canvas) return;
    const scene = new RingsScene(opts);
    sceneRef.current = scene;
    const inst = new DotCanvas(host, canvas, scene);
    instRef.current = inst;
    return () => {
      inst.destroy();
      instRef.current = null;
      sceneRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.update(opts);
    instRef.current?.invalidate();
  }, [opts]);

  React.useEffect(() => {
    if (!progress) return;
    return progress.on("change", () => instRef.current?.invalidate());
  }, [progress]);

  return (
    <div ref={hostRef} className={className ? `alv-dots ${className}` : "alv-dots"} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
