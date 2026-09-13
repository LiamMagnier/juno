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
 * Thinking effort, as a row of words.
 *
 * IT HAD A TRACK, AND THE TRACK WAS THE PROBLEM. The row sat in a
 * `bg-secondary` box with six `flex-1` segments stretched across the whole
 * footer of the model picker — roughly 130px of fill around each four-letter
 * word — and the selected one carried `shadow-raised`. So the last framed,
 * shadowed object in the picker was the control for its smallest decision,
 * and it read as a settings row rather than a choice
 * (docs/design/PREMIUM_AUDIT.md §3, rules 3 and 7).
 *
 * Now: no box, no shadow, no stretch. Each tier is sized to its own word,
 * the row sits left against its label, and the selected tier is the tonal
 * `bg-secondary` fill — the same "selected" recipe the sidebar's active row
 * and the product switch's thumb already use, so the product has one way of
 * saying which of several things is chosen.
 *
 * Before that it was a range slider with a neumorphic track and a shadowed
 * thumb — the one control that kept the Soft UI recipes after the flat
 * retune (docs/design/FLAT_UI.md §6), and the only one that made you drag to
 * choose between four words. Effort is a discrete choice with at most six
 * values, which is what a radio group is for: every option visible, one
 * press to pick, arrows to move between them.
 *
 * The export keeps its old name so every composer that mounts it keeps
 * compiling; the props are unchanged.
 */
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
  const groupRef = React.useRef<HTMLDivElement>(null);

  // Arrow keys move the selection and the focus together, which is what a
  // radio group does natively — but these are buttons so the selected one
  // can carry a tooltip, so the roving is written out.
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (disabled) return;
    const delta =
      event.key === "ArrowRight" || event.key === "ArrowDown"
        ? 1
        : event.key === "ArrowLeft" || event.key === "ArrowUp"
          ? -1
          : event.key === "Home"
            ? -index
            : event.key === "End"
              ? count - 1 - index
              : 0;
    if (!delta) return;
    event.preventDefault();
    const next = options[(index + delta + count) % count];
    if (!next) return;
    onChange(next.value);
    groupRef.current
      ?.querySelector<HTMLButtonElement>(`[data-effort="${next.value}"]`)
      ?.focus();
  };

  if (count < 2) return null;

  return (
    <div className={cn("select-none", className)}>
      <div
        ref={groupRef}
        role="radiogroup"
        aria-label="Thinking effort"
        onKeyDown={onKeyDown}
        className={cn(
          // `flex-wrap` because the row is now as wide as its words rather
          // than as wide as its container: six tiers in a narrow composer
          // wrap onto a second line instead of truncating to initials.
          "flex flex-wrap items-center gap-0.5",
          disabled && "opacity-55",
        )}
      >
        {options.map((option, optionIndex) => {
          const selected = optionIndex === index;
          const label =
            option.label === "Extra high" ? "X-high" : option.label;
          return (
            <button
              key={`${option.value}-${option.label}`}
              type="button"
              role="radio"
              aria-checked={selected}
              data-effort={option.value}
              tabIndex={selected ? 0 : -1}
              disabled={disabled}
              onClick={() => onChange(option.value)}
              className={cn(
                // Sized to the word, not to a share of the container. `h-7`
                // and `text-ui` put it on the same rung as every other dense
                // row in the product; `coarse:h-9` keeps the touch target.
                "flex h-7 shrink-0 items-center justify-center rounded-control px-2 text-ui transition-[background-color,color] duration-fast ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring coarse:h-9 motion-reduce:transition-none",
                selected
                  // Tonal, no fill-behind-a-fill and no shadow: the same
                  // "selected" recipe as the sidebar's active row.
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <span className="truncate">{label}</span>
            </button>
          );
        })}
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
