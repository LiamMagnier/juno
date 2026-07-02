"use client";

import * as React from "react";
import { Image as ImageIcon, Video } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * In-progress card for /api/generate runs — replaces ThinkingDots while an
 * image or video renders. A slow living gradient field (two long-period orbs
 * in primary/source tints), the skeleton shimmer sweep, and a pulsing dot-grid
 * fill an aspect-ratio frame; the bottom bar carries the stage, an elapsed
 * counter, and a determinate/indeterminate progress hairline.
 */

const STAGE_LABELS: Record<string, string> = {
  queued: "Queued…",
  generating: "Generating…",
  polling: "Rendering…",
  downloading: "Downloading…",
  uploading: "Uploading…",
};

function friendlyLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? `${stage.charAt(0).toUpperCase()}${stage.slice(1)}…`;
}

function formatElapsed(totalSec: number): string {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface GenerationPlaceholderProps {
  progress: { modality: "image" | "video"; stage: string; pct?: number };
}

export function GenerationPlaceholder({ progress }: GenerationPlaceholderProps) {
  const { modality, stage, pct } = progress;
  const isVideo = modality === "video";
  const Icon = isVideo ? Video : ImageIcon;
  const label = friendlyLabel(stage);

  // Client-side elapsed counter — starts when the placeholder mounts.
  const startRef = React.useRef(Date.now());
  const [elapsed, setElapsed] = React.useState(0);
  React.useEffect(() => {
    const t = window.setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => window.clearInterval(t);
  }, []);

  // Stage-label crossfade: keep the outgoing label around for one short fade.
  const [prevLabel, setPrevLabel] = React.useState<string | null>(null);
  const lastLabelRef = React.useRef(label);
  React.useEffect(() => {
    if (lastLabelRef.current === label) return;
    setPrevLabel(lastLabelRef.current);
    lastLabelRef.current = label;
    const t = window.setTimeout(() => setPrevLabel(null), 220);
    return () => window.clearTimeout(t);
  }, [label]);

  // Providers may report a fraction or a percentage — normalize to 0..100.
  const displayPct = pct == null ? null : Math.max(0, Math.min(100, pct < 1 ? pct * 100 : pct));

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={`${isVideo ? "Video" : "Image"} generation in progress — ${label}`}
      className={cn(
        "relative w-full overflow-hidden rounded-lg border border-border/60 bg-muted shadow-soft",
        isVideo ? "aspect-video max-w-[480px]" : "aspect-square max-w-[320px]"
      )}
    >
      {/* Living gradient field. */}
      <div aria-hidden="true" className="absolute inset-0">
        <div
          className="absolute -inset-[25%] motion-safe:animate-gen-drift-a"
          style={{ background: "radial-gradient(circle at 32% 30%, hsl(var(--primary) / 0.22), transparent 62%)" }}
        />
        <div
          className="absolute -inset-[25%] motion-safe:animate-gen-drift-b"
          style={{ background: "radial-gradient(circle at 68% 66%, hsl(var(--source) / 0.16), transparent 58%)" }}
        />
        {/* Brand dot-grid, pulsing faintly. */}
        <div
          className="absolute inset-0 opacity-50 motion-safe:animate-gen-grid-pulse"
          style={{
            backgroundImage: "radial-gradient(hsl(var(--foreground) / 0.13) 1px, transparent 1.5px)",
            backgroundSize:
              "calc(var(--dot-size) + var(--dot-gap) + 10px) calc(var(--dot-size) + var(--dot-gap) + 10px)",
          }}
        />
        {/* Skeleton shimmer sweep; the base fill stays transparent so the field shows through. */}
        <div className="skeleton absolute inset-0 !bg-transparent" />
      </div>

      {/* Breathing modality icon. */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
        <span className="flex h-12 w-12 items-center justify-center rounded-full border border-border/50 bg-background/55 shadow-soft backdrop-blur-sm">
          <Icon className="h-5 w-5 text-foreground/70 motion-safe:animate-icon-breathe" aria-hidden="true" />
        </span>
        {isVideo && elapsed >= 15 && (
          <p className="px-6 text-center text-caption text-muted-foreground motion-safe:animate-fade-in-up">
            This can take a couple of minutes.
          </p>
        )}
      </div>

      {/* Bottom bar: stage + elapsed + progress hairline. */}
      <div className="absolute inset-x-0 bottom-0">
        <div className="flex items-end justify-between gap-3 bg-gradient-to-t from-background/80 via-background/35 to-transparent px-3.5 pb-2.5 pt-7">
          <span className="relative grid font-mono text-label uppercase text-muted-foreground">
            {prevLabel && (
              <span aria-hidden="true" className="col-start-1 row-start-1 motion-safe:animate-overlay-out">
                {prevLabel}
              </span>
            )}
            <span key={label} className={cn("col-start-1 row-start-1", prevLabel && "motion-safe:animate-fade-in")}>
              {label}
            </span>
          </span>
          <span className="font-mono text-caption tabular-nums text-muted-foreground/80">{formatElapsed(elapsed)}</span>
        </div>
        <div className="relative h-0.5 w-full overflow-hidden bg-border/50">
          {displayPct != null ? (
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-slow ease-out-soft"
              style={{ width: `${displayPct}%` }}
            />
          ) : (
            <div className="h-full w-1/3 rounded-full bg-primary/80 motion-safe:animate-gen-sweep" />
          )}
        </div>
      </div>
    </div>
  );
}
