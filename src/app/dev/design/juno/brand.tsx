"use client";

/*
 * ALEVR BRAND, PRODUCTION (Revision 2).
 *
 * Every screen takes the Alevr identity from this file only. Since Revision 2
 * it re-exports the production components from src/components/brand/ (the
 * reviewed Continuum master and its 16/20/24/32 optical masters with the
 * device-pixel switch, the outlined wordmark, the 1.10 lockup, the Orbit and
 * Code glyphs, and the ThinkingMark with its tested schedule), adapted to the
 * galleries' props so no screen changed: sizes here are the mark's WIDTH (as
 * the stand-in had them), and every drawing takes the row's ink (tone
 * "current"), because the galleries theme by data-theme, not the app's .dark.
 * The traced stand-in (brand-geometry.ts) remains only for the brand scene's
 * note on where the master came from.
 *
 * Contracts (docs/rework/brand, D-035..D-037):
 *   ContinuumMark   uniform graphite on light, pale neutral on dark (the ink).
 *   AlevrWordmark   upright Newsreader 600, outlined; never italic.
 *   AlevrLogo       mark + wordmark per the production lockup (mark 1.10 cap
 *                   heights, gap 1.5 path widths); an optional product word
 *                   (Chat, Orbit, Code) in the serif at 400 for explanatory places.
 *   OrbitGlyph      two separated open elliptical arcs (b = a / phi, tilted 24
 *                   degrees), static; CodeGlyph opposed brackets with a cursor.
 *   ThinkingMark    the production mark: one blade at a time (rise 120, fall
 *                   220, next 120 ms on), absorbed requests with a backing-off
 *                   window, no held tone, one settle; static under reduced motion.
 */

import * as React from "react";
import { ContinuumMark as ProdContinuum } from "@/components/brand/continuum-mark";
import { AlevrWordmark as ProdWordmark } from "@/components/brand/alevr-wordmark";
import { AlevrLockup } from "@/components/brand/alevr-lockup";
import { OrbitGlyph as ProdOrbitGlyph } from "@/components/brand/orbit-glyph";
import { CodeGlyph as ProdCodeGlyph } from "@/components/brand/code-glyph";
import { ThinkingMark as ProdThinkingMark, type ThinkingPhase } from "@/components/brand/thinking-mark";
import { THINKING_TIMING } from "@/components/brand/thinking-schedule";
import { CONTINUUM_ASPECT } from "@/components/brand/continuum-geometry";
import { ORBIT_CONSTRUCTION, ORBIT_GLYPH } from "@/components/brand/brand-glyphs";
import { useReduced } from "./motion";

/** False since Revision 2: the production geometry is live everywhere. */
export const BRAND_STANDIN = false;

/** The mark's height for a given width (the production master's aspect, 240.5 : 164). */
export const continuumHeight = (width: number) => Math.round((width / CONTINUUM_ASPECT) * 100) / 100;

export interface ContinuumProps {
  /** The mark's width in px (its height follows the master's aspect). */
  size?: number;
  className?: string;
  /** Give it a name only when nothing beside it says "Alevr". */
  title?: string;
  /** Kept for the galleries' call sites; the production component picks its optical master by size and device pixels. */
  optical?: boolean;
  style?: React.CSSProperties;
}

export function ContinuumMark({ size = 20, className, title, style }: ContinuumProps) {
  return <ProdContinuum size={continuumHeight(size)} tight tone="current" title={title} className={className ? `jn-cmk ${className}` : "jn-cmk"} style={style} />;
}

/** "Alevr", the outlined production wordmark, sized by the serif's font size it replaces (ink 0.73 em). */
export function AlevrWordmark({ size = 20, className }: { size?: number; className?: string }) {
  return <ProdWordmark height={Math.round(size * 0.7345 * 100) / 100} tone="current" className={className ? `jn-alevr ${className}` : "jn-alevr"} />;
}

/**
 * The application lockup (production geometry). `size` is the wordmark's
 * former font size in px, so the lockup keeps its place in every layout; the
 * product word, where it explains (Alevr Code on Code's entry), follows in
 * the serif at 400, on the wordmark's baseline.
 */
export function AlevrLogo({
  size = 20,
  product,
  className,
  label = true,
}: {
  size?: number;
  product?: "Chat" | "Orbit" | "Code";
  className?: string;
  label?: boolean;
}) {
  const h = Math.round(size * 0.74 * 100) / 100;
  const name = product ? `Alevr ${product}` : "Alevr";
  return (
    <span className={className ? `jn-lockup ${className}` : "jn-lockup"} style={{ "--lk": `${size}px` } as React.CSSProperties} role={label ? "img" : undefined} aria-label={label ? name : undefined} aria-hidden={label ? undefined : true}>
      <AlevrLockup height={h} tone="current" decorative className="jn-lockup__art" />
      {product ? (
        <span className="jn-lockup__product" style={{ fontSize: size }} aria-hidden="true">
          {product}
        </span>
      ) : null}
    </span>
  );
}

/* ———————————————————————— Product glyphs (production) ———————————————————————— */

/** Orbit: two separated open arcs of one ellipse (b = a / phi, tilted 24 degrees), in point symmetry. Never a spinner. */
export function OrbitGlyph({ size = 16, className, title }: { size?: number; className?: string; title?: string }) {
  return <ProdOrbitGlyph size={size} tone="current" title={title} className={className ? `jn-pglyph ${className}` : "jn-pglyph"} />;
}

/** Code: opposed square brackets with an inset cursor. */
export function CodeGlyph({ size = 16, className, title }: { size?: number; className?: string; title?: string }) {
  return <ProdCodeGlyph size={size} tone="current" title={title} className={className ? `jn-pglyph ${className}` : "jn-pglyph"} />;
}

/** The Orbit glyph's construction (for the brand scene's one cosmic moment) and its 24 px master's arcs. */
export const ORBIT_GEOMETRY = ORBIT_CONSTRUCTION;
export const ORBIT_ARCS = ORBIT_GLYPH[24].paths;

/* ———————————————————————————— ThinkingMark ———————————————————————————— */

export type ThinkingState = "active" | "done" | "waiting" | "error";

/** The production schedule's numbers, for captions (thinking-schedule.ts). */
export const HANDOFF = {
  rise: THINKING_TIMING.rise,
  fall: THINKING_TIMING.fall,
  stagger: THINKING_TIMING.stagger,
  window: THINKING_TIMING.window,
  windowMax: THINKING_TIMING.windowMax,
  settle: THINKING_TIMING.settle,
} as const;

const PHASE: Record<ThinkingState, ThinkingPhase> = { active: "working", done: "finished", waiting: "waiting", error: "error" };

/**
 * The production ThinkingMark in the galleries' terms: `size` is the mark's
 * width (the production box is square, the ink spans its width), `state` maps
 * to the schedule's phase, and `pulse` increments once per real event (a new
 * phase, a tool result: never a count or a token). The galleries' forced
 * reduced motion (rm=1) is passed through.
 */
export function ThinkingMark({
  size = 20,
  state = "active",
  pulse = 0,
  className,
  phase,
}: {
  size?: number;
  state?: ThinkingState;
  pulse?: number;
  className?: string;
  /** Use the literal "thinking" phase (only while a model is reasoning). */
  phase?: ThinkingPhase;
}) {
  const reduced = useReduced();
  return <ProdThinkingMark phase={phase ?? PHASE[state]} eventKey={pulse} size={size} reducedMotion={reduced} className={className ? `jn-tm ${className}` : "jn-tm"} />;
}
