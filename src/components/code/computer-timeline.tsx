"use client";

import * as React from "react";

import type { ComputerActionItem, TurnItem } from "@/lib/code-v2/contracts";
import {
  buildComputerTimeline,
  defaultScreenshotResolver,
  followsLive,
  indexFromRatio,
  ratioFromIndex,
  ringPosition,
  stageFrameIndex,
  stepSelection,
  timelineSummary,
  type TimelineFrame,
} from "@/lib/code-v2/computer-timeline";
import { cn } from "@/lib/utils";
import { prefersReducedMotion } from "@/lib/motion-preference";

/*
 * THE SCREENSHOT TIMELINE FOR COMPUTER USE (SPEC §3.12).
 *
 * Every computer action is a `computer_action` turn item with a screenshot
 * reference — or, for a Work run on a cloud computer, a step built from its
 * events (src/components/work/computer-steps.tsx). This draws them as one
 * object: a stage (the screenshot at the scrubber, a ring where the action
 * landed, the sentence underneath), a scrubber, and a strip of thumbnails.
 * While the agent works, the stage follows the newest step until the reader
 * scrubs back; ← → Home and End step.
 *
 * Design rules: no pills, no dots. State is the caption's words, the ring's
 * colour (coral only while a step is running — "working") and the strip's
 * selection outline. Two weights (400 and 500). One motion family, all on the
 * motion tokens: the stage crossfades on the base rung (the previous frame
 * stays underneath until the next one has loaded, so following a live run
 * never flashes the empty stage), the ring scales in once, thumbnails tint on
 * the fast rung. No looping animation; under reduced motion no transform and
 * no smooth scrolling, and the crossfade is a cut.
 *
 * `resolveScreenshot` maps a ref to a URL; the default handles data/https URLs
 * and same-origin paths. A frame that cannot be loaded says so in words
 * (`unavailableLabel`) rather than drawing a broken image.
 */

export interface ComputerTimelineProps {
  /** The thread's items; anything but `computer_action` is ignored. */
  items?: readonly (TurnItem | ComputerActionItem)[];
  /** Ready-made frames (a Work run's steps). Used instead of `items` when given. */
  frames?: readonly TimelineFrame[];
  /** Pixel size of `frames`' screenshots, for the stage's aspect ratio. */
  frameSize?: { width: number; height: number } | null;
  resolveScreenshot?: (ref: string) => string | null;
  /** Starts folded to its header line (inline in a long thread). */
  defaultCollapsed?: boolean;
  className?: string;
  /** Called when the reader opens a step (e.g. to scroll the thread to it). */
  onSelectStep?: (frame: TimelineFrame) => void;
  /** Shown on the stage when a step's screenshot cannot be loaded. */
  unavailableLabel?: string;
}

const NO_ITEMS: readonly (TurnItem | ComputerActionItem)[] = [];

export function ComputerTimeline({
  items = NO_ITEMS,
  frames: givenFrames,
  frameSize = null,
  resolveScreenshot = defaultScreenshotResolver,
  defaultCollapsed = false,
  className,
  onSelectStep,
  unavailableLabel = "Screenshot unavailable",
}: ComputerTimelineProps) {
  const frames = React.useMemo(
    () => givenFrames ?? buildComputerTimeline(items, resolveScreenshot),
    [givenFrames, items, resolveScreenshot],
  );
  const count = frames.length;
  // null = follow the newest step.
  const [selected, setSelected] = React.useState<number | null>(null);
  const [collapsed, setCollapsed] = React.useState(defaultCollapsed);
  const stripRef = React.useRef<HTMLDivElement>(null);

  const current = selected === null ? count - 1 : Math.min(selected, count - 1);
  const frame = frames[current];
  const stageIndex = stageFrameIndex(frames, current);
  const stage = stageIndex >= 0 ? frames[stageIndex] : undefined;
  const ring = stageIndex === current ? ringPosition(frame) : null;
  const live = followsLive(selected, count);

  const select = React.useCallback(
    (index: number) => {
      if (index < 0 || index >= count) return;
      setSelected(index >= count - 1 ? null : index);
      onSelectStep?.(frames[index]);
    },
    [count, frames, onSelectStep],
  );

  // Keep the selected thumbnail in view without moving the page.
  React.useEffect(() => {
    const strip = stripRef.current;
    const thumb = strip?.querySelector<HTMLElement>(`[data-index="${current}"]`);
    if (!strip || !thumb) return;
    const left = thumb.offsetLeft - strip.clientWidth / 2 + thumb.clientWidth / 2;
    strip.scrollTo({ left, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [current, collapsed]);

  if (count === 0) return null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      select(stepSelection(selected, count, event.key === "ArrowLeft" ? -1 : 1));
    } else if (event.key === "End") {
      event.preventDefault();
      select(count - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      select(0);
    }
  };

  const aspect =
    (stage && (givenFrames ? sizeAspect(frameSize) : frameAspect(items, stage.id))) ?? "16 / 10";

  return (
    <section
      className={cn(
        "group/ct rounded-card border border-border/70 bg-card text-card-foreground",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
        className,
      )}
      aria-label="Computer use steps"
      tabIndex={0}
      onKeyDown={onKeyDown}
    >
      <header className="flex items-center gap-3 px-3.5 py-2.5">
        <button
          type="button"
          className="min-w-0 flex-1 truncate text-left text-ui font-medium text-foreground"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          {timelineSummary(frames)}
        </button>
        <span className="shrink-0 tabular-nums text-label text-muted-foreground">
          {live && frame?.live ? "Now" : `Step ${current + 1} of ${count}`}
        </span>
      </header>

      {!collapsed && (
        <div className="px-3.5 pb-3.5">
          <figure className="m-0">
            <div
              className="relative overflow-hidden rounded-card border border-border/60 bg-muted/40"
              style={{ aspectRatio: aspect }}
            >
              <StageImage
                src={stage?.src ?? null}
                alt={stage?.caption ?? ""}
                emptyLabel="No screenshot for this step"
                unavailableLabel={unavailableLabel}
              />
              {ring && (
                // Positioned by the wrapper, scaled by the ring: the entrance
                // animates `transform`, which would otherwise replace the
                // centring translate for the length of the animation.
                <span
                  key={`ring-${frame.id}-${frame.status}`}
                  aria-hidden
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
                  style={ring}
                >
                  <span
                    className={cn(
                      "block h-7 w-7 rounded-full border-[1.5px] shadow-[0_0_0_3px_hsl(var(--background)/0.55)]",
                      "duration-base ease-out-soft motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-150",
                      frame.live
                        ? "border-[hsl(var(--agent-coral))]"
                        : frame.failed
                          ? "border-muted-foreground"
                          : "border-foreground/85",
                    )}
                  />
                </span>
              )}
            </div>
            <figcaption
              className={cn(
                "mt-2.5 min-h-[20px] text-ui",
                frame?.failed ? "text-muted-foreground" : "text-foreground",
              )}
              aria-live="polite"
            >
              {frame?.caption}
            </figcaption>
          </figure>

          {count > 1 && (
            <input
              type="range"
              min={0}
              max={1000}
              step={1}
              value={Math.round(ratioFromIndex(current, count) * 1000)}
              onChange={(e) => select(indexFromRatio(Number(e.currentTarget.value) / 1000, count))}
              aria-label="Scrub through steps"
              aria-valuetext={`Step ${current + 1} of ${count}: ${frame?.caption ?? ""}`}
              className={SCRUBBER_CLASS}
            />
          )}

          <div
            ref={stripRef}
            className="mt-2.5 flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:thin]"
            role="listbox"
            aria-label="Steps"
          >
            {frames.map((f) => {
              const isSelected = f.index === current;
              return (
                <button
                  key={f.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-index={f.index}
                  title={f.caption}
                  onClick={() => select(f.index)}
                  className={cn(
                    "group/thumb flex w-[76px] shrink-0 flex-col gap-1 rounded-control p-1 text-left",
                    "transition-colors duration-fast ease-out-soft hover:bg-accent/60 motion-reduce:transition-none",
                    isSelected && "bg-accent/70",
                  )}
                >
                  <span
                    className={cn(
                      "relative block h-[42px] w-full overflow-hidden rounded-sm border bg-muted/50",
                      isSelected ? "border-foreground/70" : "border-border/60",
                      f.live && "border-[hsl(var(--agent-coral))]",
                    )}
                  >
                    {f.src ? <Thumbnail src={f.src} failed={f.failed} /> : null}
                  </span>
                  <span
                    className={cn(
                      "truncate text-caption",
                      isSelected ? "text-foreground" : "text-muted-foreground",
                      f.failed && "line-through decoration-muted-foreground/60",
                    )}
                  >
                    {f.verb}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}

/*
 * The scrubber: a 2px track and a 3px bar, drawn with Tailwind's arbitrary
 * variants on the range input's own pseudo-elements (no stylesheet per
 * instance). The thumb's focus ring is the only focus treatment it needs.
 */
const SCRUBBER_CLASS = cn(
  "mt-3 block h-4 w-full cursor-pointer appearance-none bg-transparent focus-visible:outline-none",
  "[&::-webkit-slider-runnable-track]:h-0.5 [&::-webkit-slider-runnable-track]:rounded-micro [&::-webkit-slider-runnable-track]:bg-border",
  "[&::-moz-range-track]:h-0.5 [&::-moz-range-track]:rounded-micro [&::-moz-range-track]:bg-border",
  "[&::-webkit-slider-thumb]:-mt-1.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-[3px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-micro [&::-webkit-slider-thumb]:bg-foreground",
  "[&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-[3px] [&::-moz-range-thumb]:rounded-micro [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-foreground",
  "focus-visible:[&::-webkit-slider-thumb]:shadow-[0_0_0_3px_hsl(var(--ring)/0.35)] focus-visible:[&::-moz-range-thumb]:shadow-[0_0_0_3px_hsl(var(--ring)/0.35)]",
);

/**
 * Promotes the incoming frame even if `transitionend` never arrives (reduced
 * motion turns the transition off; a hidden tab may not run it). A little past
 * the base rung, so a running crossfade always finishes first.
 */
const PROMOTE_AFTER_MS = 400;

/**
 * The stage's screenshot, crossfaded.
 *
 * The frame on screen (`shown`) stays mounted underneath while the next one
 * (`incoming`) loads above it at opacity 0, then fades in; once it is opaque
 * it becomes the frame on screen and the old one goes. Remounting a single
 * image at opacity 0 instead — what this did before — showed the empty stage
 * for every step of a live run while each frame downloaded.
 */
function StageImage({
  src,
  alt,
  emptyLabel,
  unavailableLabel,
}: {
  src: string | null;
  alt: string;
  emptyLabel: string;
  unavailableLabel: string;
}) {
  const [shown, setShown] = React.useState<string | null>(src);
  const [incoming, setIncoming] = React.useState<string | null>(null);
  // Readiness is per URL, so a new incoming frame never inherits the last
  // one's "loaded" and paints at full opacity before it has faded in.
  const [loadedUrl, setLoadedUrl] = React.useState<string | null>(null);
  const ready = incoming !== null && loadedUrl === incoming;
  const [broken, setBroken] = React.useState<ReadonlySet<string>>(() => new Set());

  React.useEffect(() => {
    if (src === null || src === shown) {
      setIncoming(null);
      return;
    }
    setIncoming(src);
  }, [src, shown]);

  const promote = React.useCallback((url: string) => {
    setShown(url);
    setIncoming((current) => (current === url ? null : current));
  }, []);

  React.useEffect(() => {
    if (!ready || incoming === null) return;
    const url = incoming;
    const timer = window.setTimeout(() => promote(url), PROMOTE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [ready, incoming, promote]);

  const markBroken = (url: string) =>
    setBroken((current) => (current.has(url) ? current : new Set(current).add(url)));

  if (src === null) {
    return <StageNote>{emptyLabel}</StageNote>;
  }
  if (broken.has(src)) {
    // Never the previous step's frame under this step's caption.
    return <StageNote>{unavailableLabel}</StageNote>;
  }

  return (
    <>
      {shown !== null && !broken.has(shown) && (
        // eslint-disable-next-line @next/next/no-img-element -- screenshots are private refs and data URLs
        <img
          key={shown}
          src={shown}
          alt={incoming === null ? alt : ""}
          className="absolute inset-0 h-full w-full object-contain"
          draggable={false}
          onError={() => markBroken(shown)}
        />
      )}
      {incoming !== null && (
        // eslint-disable-next-line @next/next/no-img-element -- see above
        <img
          key={incoming}
          src={incoming}
          alt={alt}
          className={cn(
            "absolute inset-0 h-full w-full object-contain",
            "transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
            ready ? "opacity-100" : "opacity-0",
          )}
          draggable={false}
          onLoad={() => setLoadedUrl(incoming)}
          onError={() => markBroken(incoming)}
          onTransitionEnd={(event) => {
            if (event.propertyName === "opacity" && ready) promote(incoming);
          }}
        />
      )}
    </>
  );
}

function StageNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 grid place-items-center px-4 text-center text-label text-muted-foreground">
      {children}
    </div>
  );
}

/** A thumbnail that disappears, rather than drawing a broken image, when it cannot load. */
function Thumbnail({ src, failed }: { src: string; failed: boolean }) {
  const [broken, setBroken] = React.useState(false);
  if (broken) return null;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- see above
    <img
      src={src}
      alt=""
      loading="lazy"
      draggable={false}
      onError={() => setBroken(true)}
      className={cn("h-full w-full object-cover", failed && "opacity-45 grayscale")}
    />
  );
}

/** The aspect ratio of a step's screenshot, from the item's frameSize. */
function frameAspect(items: readonly (TurnItem | ComputerActionItem)[], id: string): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "computer_action" && item.id === id && item.frameSize) {
      return `${item.frameSize.width} / ${item.frameSize.height}`;
    }
  }
  return null;
}

function sizeAspect(size: { width: number; height: number } | null): string | null {
  return size && size.width > 0 && size.height > 0 ? `${size.width} / ${size.height}` : null;
}
