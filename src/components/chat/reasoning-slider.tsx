"use client";

import * as React from "react";
import { cn } from "@/lib/utils";
import type { ReasoningOption } from "@/lib/model-metrics";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Thinking effort, as a slider.
 *
 * IT HAS BEEN ALL THREE THINGS, so the history is worth keeping.
 *
 * It began as a range input with a neumorphic track and a shadowed thumb —
 * the one control that kept the Soft UI recipes after the flat retune
 * (docs/design/FLAT_UI.md §6). Then it became a row of words, on the argument
 * that effort is a discrete choice with at most six values and that is what a
 * radio group is for. That argument is still correct about SEMANTICS and was
 * wrong about the thing being chosen: effort is ORDERED. Instant is less than
 * Max, and every value between them is on the way. A row of equal words says
 * "these are six options"; a slider says "this is one quantity and you are
 * here on it", which is the true sentence.
 *
 * So: a slider again, but nothing of the first one. No track box, no shadow,
 * no gradient, no drag-to-discover. A 3px rail, a fill up to where you are, a
 * tick at every stop so the discreteness is visible, and the value named in
 * words beside it so nobody has to count notches.
 *
 * THE INTERACTION IS A NATIVE `input[type=range]`, invisible, stretched over
 * the whole control. Drag, click-to-jump, arrows, Home/End, page keys and
 * every touch gesture come from the platform rather than from this file, and
 * the painted parts below are decoration that cannot fall out of sync with
 * them. `aria-valuetext` is what makes it say "High" rather than "3".
 *
 * The alignment between the invisible input and the painted rail is not a
 * coincidence and not a fudge: the browser insets a range thumb by half its
 * width at each end, so `.effort-range` in globals.css pins that thumb to
 * exactly THUMB px and the same inset is written into `atStop()` here. Change
 * one and you must change the other, which is why the number lives in one
 * place.
 *
 * The export keeps its old name so every composer that mounts it keeps
 * compiling; the props are unchanged.
 */

/** Thumb diameter, px. Must equal the width pinned in `.effort-range`. */
const THUMB = 14;

/** Where stop `i` of `count` sits along the rail, as a CSS length. */
const atStop = (i: number, count: number) => {
  const t = count > 1 ? i / (count - 1) : 0;
  return `calc(${(t * 100).toFixed(4)}% + ${(THUMB / 2 - t * THUMB).toFixed(3)}px)`;
};

export function ReasoningSlider({
  options,
  value,
  onChange,
  disabled,
  className,
  fastMode = false,
  onFastModeChange,
  proMode = false,
  onProModeChange,
}: {
  options: ReasoningOption[];
  value: ReasoningOption["value"];
  onChange: (value: ReasoningOption["value"]) => void;
  disabled?: boolean;
  className?: string;
  fastMode?: boolean;
  onFastModeChange?: (value: boolean) => void;
  proMode?: boolean;
  onProModeChange?: (value: boolean) => void;
}) {
  const count = options.length;
  const found = options.findIndex((option) => option.value === value);
  const index = found < 0 ? 0 : found;
  const current = options[index];

  if (count < 2) return null;

  // "Extra high" is two words for a rung that has to sit in a 3.5rem gutter
  // beside every other rung's one word.
  const label = current?.label === "Extra high" ? "X-high" : (current?.label ?? "");
  const head = atStop(index, count);

  return (
    <div className={cn("select-none", className)}>
      <div className={cn("flex items-center gap-3", disabled && "opacity-55")}>
        <div className="relative h-7 min-w-0 flex-1 coarse:h-9">
          {/* The rail. `bg-secondary`, the same tonal fill that means
              "a thing with state" everywhere else in the product. */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-secondary"
          />

          {/* How far along you are. This is the one moving part, and it is a
              fill — which is all rule 10 of the premium audit allows chrome
              to animate. */}
          <div
            aria-hidden
            className="pointer-events-none absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-foreground transition-[width] duration-fast ease-out-soft motion-reduce:transition-none"
            style={{ width: head }}
          />

          {/* A tick per stop, so the control looks like the discrete choice it
              is rather than a continuous one that happens to snap. Past the
              thumb they sit on the rail; behind it they sit on the fill and
              have to invert to stay visible. */}
          {options.map((option, i) => (
            <div
              key={`tick-${option.value}-${option.label}`}
              aria-hidden
              className={cn(
                "pointer-events-none absolute top-1/2 size-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full transition-colors duration-fast motion-reduce:transition-none",
                i <= index ? "bg-background/70" : "bg-muted-foreground/45",
              )}
              style={{ left: atStop(i, count) }}
            />
          ))}

          {/* The thumb. NO RING AND NO SHADOW. A ring would have to be the
              colour of the paper behind it to separate the thumb from the
              rail, and this control mounts on four different surfaces — the
              model popover, the chat composer, the work composer and the new
              code page — so any one colour is wrong on three of them. A 14px
              disc over a 3px rail already separates itself, and where it meets
              the fill they are the same ink on purpose: the bar simply ends in
              a round cap. */}
          <div
            aria-hidden
            className="pointer-events-none absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-foreground transition-[left] duration-fast ease-out-soft motion-reduce:transition-none"
            style={{ left: head }}
          />

          <input
            type="range"
            min={0}
            max={count - 1}
            step={1}
            value={index}
            disabled={disabled}
            aria-label="Thinking effort"
            aria-valuetext={current?.label ?? String(index)}
            onChange={(event) => {
              const next = options[Number(event.target.value)];
              if (next) onChange(next.value);
            }}
            className="effort-range peer absolute inset-0 m-0 h-full w-full cursor-pointer appearance-none bg-transparent opacity-0 focus-visible:outline-none disabled:cursor-not-allowed"
          />

          {/* Focus is drawn on the rail rather than on the invisible input,
              which has no box of its own to ring. */}
          <div
            aria-hidden
            className="pointer-events-none absolute -inset-x-1 inset-y-0 rounded-control ring-2 ring-ring ring-offset-0 opacity-0 transition-opacity duration-fast peer-focus-visible:opacity-100 motion-reduce:transition-none"
          />
        </div>

        <span className="w-14 shrink-0 text-right text-ui font-medium text-foreground">{label}</span>
      </div>

      {(onFastModeChange || onProModeChange) && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {onFastModeChange && (
            <ModeChip
              label="Flash"
              help="Prefer faster generation when the selected model supports it."
              pressed={fastMode}
              disabled={disabled}
              onPress={() => onFastModeChange(!fastMode)}
            />
          )}
          {onProModeChange && (
            <ModeChip
              label="Pro"
              help="Prefer the model's deeper reasoning mode when available."
              pressed={proMode}
              disabled={disabled}
              onPress={() => onProModeChange(!proMode)}
            />
          )}
        </div>
      )}
    </div>
  );
}

function ModeChip({
  label,
  help,
  pressed,
  disabled,
  onPress,
}: {
  label: string;
  help: string;
  pressed: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-pressed={pressed}
          onClick={onPress}
          className={cn(
            "inline-flex h-7 items-center rounded-control border px-2.5 text-caption font-medium transition-[background-color,color,border-color] duration-fast focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring coarse:h-9 motion-reduce:transition-none",
            pressed
              ? "border-foreground bg-foreground text-background"
              : "border-border bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
            disabled && "cursor-not-allowed opacity-50",
          )}
        >
          {label}
        </button>
      </TooltipTrigger>
      <TooltipContent>{help}</TooltipContent>
    </Tooltip>
  );
}
