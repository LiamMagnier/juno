import * as React from "react";
import { cn } from "@/lib/utils";
import type { DirectionId } from "./tokens";

/*
 * The signature glyphs: the only drawings in the gallery that are not from the
 * icon set. Geometry on a 24-unit grid with 1px hairlines (non-scaling, so a
 * 48px specimen draws the same line as a 16px one), no gradients, no glow.
 * Motion lives in directions.css on transform and opacity; under reduced
 * motion each holds one frame and the text beside it says the state.
 *
 *   idle      the mark: what the product is when nothing is happening
 *   thinking  the mark at work, inline on a line of text
 */

export type GlyphState = "idle" | "thinking";

interface GlyphProps {
  state?: GlyphState;
  /** Rendered size in px. */
  size?: number;
  className?: string;
  /** Accessible name; omit when the words beside the glyph already say it. */
  label?: string;
}

function Frame({
  state,
  size,
  className,
  label,
  children,
}: GlyphProps & { children: React.ReactNode }) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-state={state}
      className={cn("dir-glyph", className)}
      style={{ "--glyph-size": `${size}px` } as React.CSSProperties}
    >
      {children}
    </span>
  );
}

/** Ion: a small disc inside a thin tilted ellipse; thinking sends a point round it. */
export function OrbitGlyph({ state = "idle", size = 16, className, label }: GlyphProps) {
  return (
    <Frame state={state} size={size} className={className} label={label}>
      <svg viewBox="0 0 24 24" fill="none">
        <ellipse cx={12} cy={12} rx={10} ry={4.4} stroke="currentColor" strokeWidth={1} transform="rotate(-25 12 12)" />
        <circle cx={12} cy={12} r={2.7} fill="currentColor" />
      </svg>
      <span className="dir-orbit__track">
        <span className="dir-orbit__x">
          <span className="dir-orbit__y">
            <span className="dir-orbit__dot" />
          </span>
        </span>
      </span>
    </Frame>
  );
}

/** Graphite: three points joined by hairlines; thinking lights points along a short arc. */
export function ConstellationGlyph({ state = "idle", size = 16, className, label }: GlyphProps) {
  if (state === "thinking") {
    return (
      <Frame state={state} size={size} className={className} label={label}>
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M3.5 16 Q12 4.5 20.5 16" stroke="currentColor" strokeOpacity={0.28} strokeWidth={1} />
          <circle className="dir-constellation__point" cx={5.6} cy={13.3} r={2.1} fill="currentColor" />
          <circle className="dir-constellation__point" cx={12} cy={10.3} r={2.1} fill="currentColor" />
          <circle className="dir-constellation__point" cx={18.4} cy={13.3} r={2.1} fill="currentColor" />
        </svg>
      </Frame>
    );
  }
  return (
    <Frame state={state} size={size} className={className} label={label}>
      <svg viewBox="0 0 24 24" fill="none">
        <polyline points="4.5,17 11,6.5 19.5,13.5" stroke="currentColor" strokeWidth={1} />
        <circle cx={4.5} cy={17} r={2.2} fill="currentColor" />
        <circle cx={11} cy={6.5} r={2.2} fill="currentColor" />
        <circle cx={19.5} cy={13.5} r={2.2} fill="currentColor" />
      </svg>
    </Frame>
  );
}

/** Meridian: a circle crossed by a meridian arc; thinking sweeps the arc round. */
export function MeridianGlyph({ state = "idle", size = 16, className, label }: GlyphProps) {
  return (
    <Frame state={state} size={size} className={className} label={label}>
      <svg viewBox="0 0 24 24" fill="none">
        <circle cx={12} cy={12} r={9} stroke="currentColor" strokeWidth={1} />
        <path className="dir-meridian__arc" d="M12 3 A5 9 0 0 1 12 21" stroke="currentColor" strokeWidth={1} />
        <circle cx={12} cy={12} r={1.6} fill="currentColor" />
      </svg>
    </Frame>
  );
}

const GLYPHS: Record<DirectionId, (props: GlyphProps) => React.JSX.Element> = {
  ion: OrbitGlyph,
  graphite: ConstellationGlyph,
  meridian: MeridianGlyph,
};

/** The direction's own glyph. */
export function SignatureGlyph({ direction, ...props }: GlyphProps & { direction: DirectionId }) {
  const Glyph = GLYPHS[direction];
  return <Glyph {...props} />;
}

/**
 * The wordmark: the mark and "Juno" set in the interface face at 600.
 * Graphite draws its mark in ink (blue is kept for Juno at work); the other
 * two draw it in the brand.
 */
export function Wordmark({ direction, className }: { direction: DirectionId; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <SignatureGlyph
        direction={direction}
        size={20}
        className={direction === "graphite" ? "text-foreground" : "dir-text-brand"}
      />
      <span translate="no" className="dir-display text-heading text-foreground">
        Juno
      </span>
    </span>
  );
}

/**
 * Juno thinking, inline on a line: the glyph in the brand, then the words.
 * The words are the state for a screen reader and under reduced motion.
 */
export function ThinkingLine({
  direction,
  children,
  className,
}: {
  direction: DirectionId;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <p className={cn("flex items-center gap-2.5 text-body text-muted-foreground", className)} role="status">
      <SignatureGlyph direction={direction} state="thinking" size={16} className="dir-text-brand" />
      <span>{children}</span>
    </p>
  );
}

/** Graphite's progress line: one point per step on a hairline, the current one in ion. */
export function PointsProgress({ steps, current }: { steps: number; current: number }) {
  return (
    <span className="dir-points w-full" aria-hidden="true">
      {Array.from({ length: steps }, (_, i) => (
        <React.Fragment key={i}>
          {i > 0 && <span className="dir-points__seg" data-done={i <= current ? "" : undefined} />}
          <span className="dir-points__pt" data-state={i < current ? "done" : i === current ? "active" : "pending"} />
        </React.Fragment>
      ))}
    </span>
  );
}
