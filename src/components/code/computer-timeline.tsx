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

/*
 * THE SCREENSHOT TIMELINE FOR COMPUTER USE (SPEC §3.12).
 *
 * Every computer action is a `computer_action` turn item with a screenshot
 * reference. This draws them as one object: a stage (the screenshot at the
 * scrubber, a ring where the action landed, the sentence underneath), a
 * scrubber, and a strip of thumbnails. While the agent works, the stage
 * follows the newest step until the reader scrubs back; ← and → step.
 *
 * Design rules: no pills, no dots. State is the caption's words, the ring's
 * colour (coral only while a step is running — "working") and the strip's
 * selection outline. Two weights (400 and 500). One motion family: 180 ms
 * ease-out fades on the stage, a single ring scale-in; no looping animation,
 * and none at all under reduced motion.
 *
 * The web lane places it (inline under a run of computer steps, and in the
 * side panel). `resolveScreenshot` maps a ref to a URL; the default handles
 * data/https URLs and `alevr-shot://` refs served by the env server.
 */

export interface ComputerTimelineProps {
  /** The thread's items; anything but `computer_action` is ignored. */
  items: readonly (TurnItem | ComputerActionItem)[];
  resolveScreenshot?: (ref: string) => string | null;
  /** Starts folded to its header line (inline in a long thread). */
  defaultCollapsed?: boolean;
  className?: string;
  /** Called when the reader opens a step (e.g. to scroll the thread to it). */
  onSelectStep?: (frame: TimelineFrame) => void;
}

export function ComputerTimeline({
  items,
  resolveScreenshot = defaultScreenshotResolver,
  defaultCollapsed = false,
  className,
  onSelectStep,
}: ComputerTimelineProps) {
  const frames = React.useMemo(() => buildComputerTimeline(items, resolveScreenshot), [items, resolveScreenshot]);
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
    strip.scrollTo({ left, behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
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

  return (
    <section
      className={cn(
        "computer-timeline group/ct rounded-card border border-border/70 bg-card text-card-foreground",
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
              className="relative overflow-hidden rounded-lg border border-border/60 bg-muted/40"
              style={{ aspectRatio: (stage && frameAspect(items, stage.id)) ?? "16 / 10" }}
            >
              {stage?.src ? (
                // eslint-disable-next-line @next/next/no-img-element -- screenshots are local refs and data URLs
                <img
                  key={stage.id}
                  src={stage.src}
                  alt={stage.caption}
                  className="absolute inset-0 h-full w-full object-contain motion-safe:animate-[ct-fade_180ms_ease-out]"
                  draggable={false}
                />
              ) : (
                <div className="absolute inset-0 grid place-items-center text-label text-muted-foreground">
                  No screenshot for this step
                </div>
              )}
              {ring && (
                <span
                  key={`ring-${frame.id}-${frame.status}`}
                  aria-hidden
                  className={cn(
                    "pointer-events-none absolute h-7 w-7 -translate-x-1/2 -translate-y-1/2 rounded-full border-[1.5px]",
                    "shadow-[0_0_0_3px_hsl(var(--background)/0.55)] motion-safe:animate-[ct-ring_180ms_ease-out]",
                    frame.live
                      ? "border-[hsl(var(--agent-coral))]"
                      : frame.failed
                        ? "border-muted-foreground"
                        : "border-foreground/85",
                  )}
                  style={ring}
                />
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
              className="ct-scrubber mt-3 block w-full"
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
                    "group/thumb flex w-[76px] shrink-0 flex-col gap-1 rounded-md p-1 text-left",
                    "transition-colors duration-[120ms] ease-out hover:bg-accent/60",
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
                    {f.src ? (
                      // eslint-disable-next-line @next/next/no-img-element -- see above
                      <img
                        src={f.src}
                        alt=""
                        loading="lazy"
                        draggable={false}
                        className={cn("h-full w-full object-cover", f.failed && "opacity-45 grayscale")}
                      />
                    ) : null}
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
      <style>{TIMELINE_CSS}</style>
    </section>
  );
}

/** The aspect ratio of a step's screenshot, from the item's frameSize. */
function frameAspect(items: ComputerTimelineProps["items"], id: string): string | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item.kind === "computer_action" && item.id === id && item.frameSize) {
      return `${item.frameSize.width} / ${item.frameSize.height}`;
    }
  }
  return null;
}

const TIMELINE_CSS = `
@keyframes ct-fade { from { opacity: 0 } to { opacity: 1 } }
@keyframes ct-ring { from { opacity: 0; transform: translate(-50%, -50%) scale(1.6) } to { opacity: 1; transform: translate(-50%, -50%) scale(1) } }
.computer-timeline .ct-scrubber { appearance: none; height: 16px; background: transparent; cursor: pointer; }
.computer-timeline .ct-scrubber::-webkit-slider-runnable-track { height: 2px; border-radius: 1px; background: hsl(var(--border)); }
.computer-timeline .ct-scrubber::-moz-range-track { height: 2px; border-radius: 1px; background: hsl(var(--border)); }
.computer-timeline .ct-scrubber::-webkit-slider-thumb { appearance: none; width: 3px; height: 14px; margin-top: -6px; border-radius: 1.5px; background: hsl(var(--foreground)); }
.computer-timeline .ct-scrubber::-moz-range-thumb { width: 3px; height: 14px; border: 0; border-radius: 1.5px; background: hsl(var(--foreground)); }
.computer-timeline .ct-scrubber:focus-visible { outline: none; }
.computer-timeline .ct-scrubber:focus-visible::-webkit-slider-thumb { box-shadow: 0 0 0 3px hsl(var(--ring) / 0.35); }
`;
