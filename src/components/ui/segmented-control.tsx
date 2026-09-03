"use client";

import * as React from "react";
import { motion, useReducedMotion, type Transition } from "framer-motion";
import { cn } from "@/lib/utils";

/**
 * A segmented control on the product's lighting model (docs/design/SOFT_UI.md
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
 * re-measures. The spring (stiffness 420, damping 34, mass 0.8) is a firm
 * settle with no visible overrun — the key lands, it does not bounce.
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
  /** Disables just this segment (still announced, not selectable). */
  disabled?: boolean;
};

/** The thumb's spring: firm, quick, no overrun. */
const THUMB_SPRING: Transition = { type: "spring", stiffness: 420, damping: 34, mass: 0.8 };

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  orientation = "horizontal",
  labelHidden = false,
  className,
  optionClassName,
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
}) {
  const refs = React.useRef<Partial<Record<T, HTMLButtonElement | null>>>({});
  const reduceMotion = useReducedMotion() ?? false;
  // `layoutId` is global to the page, so two controls on screen at once must
  // not share one — the thumb would try to fly between them.
  const thumbId = `${React.useId()}-thumb`;

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
        // Concentric: track `rounded-menu` (14) − p-1 (4) = the thumb's
        // `rounded-control` (10). TabsList shares this string — two renderings
        // of one idiom.
        "surface-inset relative gap-1 rounded-menu p-1",
        orientation === "vertical" ? "flex flex-col items-center" : "grid",
        className,
      )}
      style={
        orientation === "horizontal"
          ? { gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }
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
            aria-label={labelHidden ? opt.label : undefined}
            title={labelHidden ? opt.label : undefined}
            disabled={opt.disabled}
            // Roving tabindex: the group is one tab stop; arrows move within it.
            tabIndex={selected ? 0 : -1}
            onClick={() => !opt.disabled && onChange(opt.value)}
            onKeyDown={handleKeyDown}
            className={cn(
              // The key and its legend dip TOGETHER: the thumb is a child of
              // the segment, so one transform moves both. --dur-press, matching
              // `.pressable`.
              "group relative flex items-center justify-center rounded-control font-medium",
              "transition-[color,transform,background-color] duration-fast ease-out-soft",
              "active:scale-[0.97] active:duration-press disabled:pointer-events-none disabled:opacity-50",
              "motion-reduce:transition-none motion-reduce:active:scale-100",
              labelHidden ? "size-8 coarse:size-10" : "gap-1.5 px-3 py-1 text-sm",
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
                transition={reduceMotion ? { duration: 0 } : THUMB_SPRING}
                // The raised key. `.surface-raised` supplies fill, hairline and
                // the dual shadow in both themes. The radius rides `style` too,
                // so framer can keep the corners true while it scales the box
                // between two segments of different widths.
                className="surface-raised absolute inset-0 rounded-control"
                style={{ borderRadius: 10 }}
              />
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
            {/* The tally, in the register a `Badge` count wears: mono, tabular,
                dimmed by opacity so the segment's own ink decides its colour. */}
            {!labelHidden && opt.count !== undefined && (
              <span className="relative z-10 font-mono text-micro tabular-nums opacity-70">{opt.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
