"use client";

import * as React from "react";
import { motion, useReducedMotion } from "framer-motion";
import { RollingNumber, useTravelSquash } from "@/components/ui/micro";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * A segmented control on the product's lighting model (docs/design/FLAT_UI.md
 * §2.2): the track is an inset well and the live segment is a raised key
 * standing proud of it.
 *
 * ONE thumb, carried between segments by framer-motion's `layoutId`. The old
 * version measured `offsetLeft` and wrote a `translate3d` by hand, with a
 * ResizeObserver, a first-placement snap and a one-frame "stretch" — ~150
 * lines to approximate what a shared-layout element does natively, and it
 * still snapped when a segment's width changed underneath it. With `layoutId`
 * the thumb simply IS wherever the selected segment is; framer measures both
 * boxes and runs the spring between them, interruptible, and a resize just
 * re-measures. The spring is `spring.standard` (lib/motion.ts) — the settle
 * the product switch, the page tabs and `<Tabs>` also run, so every selection
 * mark in the product lands the same way. It was a private stiffness/damping
 * triple, which is how four thumbs end up with four tempos.
 *
 * Labels cross-fade their ink over `--dur-fast`; icons stay put (no scale,
 * no bounce — the thumb is the thing that moves). A press dips the whole
 * segment, thumb and legend together, to 0.97 for `--dur-press`.
 *
 * Radiogroup semantics: one tab stop, arrows move the selection with wrap.
 * This is the shared idiom behind the sidebar's Chat / Code switch, the
 * Chat / Work switch above the transcript and every list filter.
 */

export type SegmentedOption<T extends string> = {
  value: T;
  label: string;
  /** Rendered before the label (or alone, when `labelHidden`). */
  icon?: React.ReactNode;
  /**
   * A live tally shown after the label — "All 12", "Images 5" — in the mono
   * tabular face, so a digit arriving or leaving moves no segment and sends
   * the thumb nowhere (the equal-width grid below does the rest).
   */
  count?: number;
  /**
   * Things waiting on the reader behind this segment — the Work switch's
   * "needs you" number. Unlike `count` it is drawn as a small accent disc,
   * because it is a call to act rather than a tally, and it is part of the
   * segment's accessible name so the number is announced with the label.
   */
  badge?: number;
  /** Disables just this segment (still announced, not selectable). */
  disabled?: boolean;
};

export type SegmentedSize = "md" | "sm";

/**
 * The two rungs, worked out once. Every number follows from three rules:
 * equal padding on all four sides (p-1), segments of a fixed height so the
 * track's height is exactly segment + 2 × padding + 2 × hairline, and a thumb
 * radius of track radius − hairline − padding so the two curves stay parallel.
 *
 *   md: 26 + 8 + 2 = 36 (coarse 34 → 44) · rounded-menu 14 → thumb 9
 *   sm: 22 + 8 + 2 = 32 (coarse 30 → 40) · rounded-card 12 → thumb 7
 *
 * Exported so `TabsList`, the same idiom on Radix, reads the same numbers.
 */
export const SEGMENTED_METRICS: Record<
  SegmentedSize,
  { track: string; segment: string; iconSegment: string; thumbRadius: number }
> = {
  md: {
    track: "rounded-menu",
    segment: "h-[1.625rem] px-3 coarse:h-[2.125rem]",
    iconSegment: "h-[1.625rem] w-8 coarse:h-[2.125rem] coarse:w-10",
    thumbRadius: 9,
  },
  sm: {
    track: "rounded-card",
    segment: "h-[1.375rem] px-2.5 coarse:h-[1.875rem]",
    iconSegment: "h-[1.375rem] w-7 coarse:h-[1.875rem] coarse:w-9",
    thumbRadius: 7,
  },
};

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  orientation = "horizontal",
  labelHidden = false,
  className,
  optionClassName,
  columns = "equal",
  size = "md",
}: {
  value: T;
  onChange: (value: T) => void;
  options: readonly SegmentedOption<T>[];
  ariaLabel: string;
  orientation?: "horizontal" | "vertical";
  /** Icon-only segments (the label rides `aria-label`/`title` instead). */
  labelHidden?: boolean;
  /** Extra classes on the track. */
  className?: string;
  /** Extra classes on each segment button (sizing/typography). */
  optionClassName?: string;
  /**
   * `equal` (the default) gives every segment the widest one's width, which
   * is what a two- or three-way switch wants. `content` sizes each segment to
   * its label, for a long run of filters (Artifacts' eight kinds) where equal
   * columns would stretch "All" to the width of "Components".
   */
  columns?: "equal" | "content";
  /**
   * `md` (the default) is the 36px toolbar rung, level with an `Input` or a
   * `SelectTrigger` beside it. `sm` is the 32px rung for a dense header row
   * (the canvas toolbar, an artifact card's header). The track is the size;
   * callers do not set a height on it — a forced height used to crush the
   * segments into the track's padding, so the thumb sat 5px from the top
   * edge and 3px from the bottom, its hairline grazing the track's.
   */
  size?: SegmentedSize;
}) {
  const metrics = SEGMENTED_METRICS[size];
  const refs = React.useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const reduceMotion = useReducedMotion() ?? false;
  // `layoutId` is global to the page, so two controls on screen at once must
  // not share one — the thumb would try to fly between them.
  const thumbId = `${React.useId()}-thumb`;
  /* The thumb deforms along its travel (lib/micro.ts). The counter is the
     selected index rather than a mount-time flag, so the control squashes when
     the selection MOVES and sits still when it is merely rendered — and it has
     to live on the group, since the segment receiving the thumb has only just
     mounted and cannot tell a move from a first paint. */
  const thumbSquash = useTravelSquash(
    options.findIndex((o) => o.value === value),
    orientation === "vertical" ? "y" : "x"
  );

  const move = (dir: 1 | -1) => {
    const enabled = options.filter((o) => !o.disabled);
    if (enabled.length === 0) return;
    const currentIdx = enabled.findIndex((o) => o.value === value);
    const from = currentIdx === -1 ? 0 : currentIdx;
    const next = enabled[(from + dir + enabled.length) % enabled.length];
    onChange(next.value);
    refs.current[next.value]?.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
    e.preventDefault();
    move(e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1);
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={cn(
        // `.surface-inset` (SOFT_UI.md): the recess the thumb stands out of.
        // The same 4px all round, at every size, so the thumb sits dead centre
        // in the well. Concentric: the thumb's radius is the track's minus the
        // hairline (1) and the padding (4) — see SEGMENTED_METRICS. TabsList
        // shares these numbers: two renderings of one idiom.
        "surface-inset relative gap-1 p-1",
        metrics.track,
        orientation === "vertical" ? "flex flex-col items-center" : "grid",
        className,
      )}
      style={
        orientation === "horizontal"
          ? { gridTemplateColumns: `repeat(${options.length}, ${columns === "content" ? "auto" : "minmax(0, 1fr)"})` }
          : undefined
      }
    >
      {options.map((opt) => {
        const selected = value === opt.value;
        return (
          <button
            key={opt.value}
            ref={(el) => {
              refs.current[opt.value] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={
              labelHidden
                ? opt.badge
                  ? `${opt.label}, ${opt.badge} waiting on you`
                  : opt.label
                : opt.badge
                  ? `${opt.label}, ${opt.badge} waiting on you`
                  : undefined
            }
            title={labelHidden ? opt.label : undefined}
            disabled={opt.disabled}
            // Roving tabindex: the group is one tab stop; arrows move within it.
            tabIndex={selected ? 0 : -1}
            onClick={() => !opt.disabled && onChange(opt.value)}
            onKeyDown={handleKeyDown}
            style={{ borderRadius: metrics.thumbRadius }}
            className={cn(
              // The key and its legend dip TOGETHER: the thumb is a child of
              // the segment, so one transform moves both. --dur-press, matching
              // `.pressable`.
              // No radius class: the hover wash takes the thumb's radius from
              // `style` below, so the wash and the key are the same shape.
              "group relative flex items-center justify-center font-medium",
              "transition-[color,transform,background-color] duration-fast ease-out-soft",
              "active:scale-[0.97] active:duration-press disabled:pointer-events-none disabled:opacity-50",
              "motion-reduce:transition-none motion-reduce:active:scale-100",
              labelHidden ? metrics.iconSegment : cn("gap-1.5 text-ui", metrics.segment),
              selected
                ? "text-foreground"
                : // A faint wash names the target under the pointer — far below
                  // the thumb's own contrast, so it reads as "you can press here",
                  // not as a second selected state.
                  "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              optionClassName,
            )}
          >
            {selected && (
              <motion.span
                layoutId={thumbId}
                aria-hidden="true"
                transition={reduceMotion ? { duration: 0 } : spring.standard}
                // The raised key. `.surface-raised` supplies fill, hairline and
                // the dual shadow in both themes. The radius rides `style` too,
                // so framer can keep the corners true while it scales the box
                // between two segments of different widths.
                className="absolute inset-0"
                style={{ borderRadius: metrics.thumbRadius }}
              >
                {/* Carriage / body: framer's layout projection owns the outer
                    transform, so the deformation needs a node of its own. */}
                <motion.span
                  aria-hidden="true"
                  style={{ ...thumbSquash, borderRadius: metrics.thumbRadius }}
                  className="surface-key block size-full"
                />
              </motion.span>
            )}
            {/* Steady: the mark neither scales nor bounces. Only its ink
                follows the selection, on the same fast ramp as the label. */}
            {opt.icon && (
              <span className="relative z-10 inline-flex transition-colors duration-fast ease-out-soft motion-reduce:transition-none">
                {opt.icon}
              </span>
            )}
            {!labelHidden && (
              <span className="relative z-10 transition-colors duration-fast ease-out-soft motion-reduce:transition-none">
                {opt.label}
              </span>
            )}
            {/* The tally, in the register a `Badge` count wears: mono and
                tabular, at the segment's own ink so it follows the selection.
                It used to be dimmed to 70% on top of that, which put the
                unselected count at 2.9:1 in the light theme; the mono face and
                the smaller rung already set it apart from the label. */}
            {!labelHidden && opt.count !== undefined && (
              <span className="relative z-10 font-mono text-micro">
                <RollingNumber value={opt.count} />
              </span>
            )}
            {/* The call to act: a small accent disc. Absent at zero, and never
                drawn while the segment is the one selected — the reader is
                already looking at what it counts. */}
            {!!opt.badge && !selected && (
              <span
                aria-hidden="true"
                className="relative z-10 grid h-4 min-w-4 place-items-center rounded-full bg-primary px-1 font-mono text-micro tabular-nums leading-none text-primary-foreground"
              >
                {/* Over 99 stops being a number and becomes a word, so it
                    cuts rather than rolls — there is nothing to roll to. */}
                {opt.badge > 99 ? "99+" : <RollingNumber value={opt.badge} />}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
