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
 * Thinking effort, as a flat segmented control.
 *
 * This was a range slider with a neumorphic track, a gradient fill at the
 * top tier and a shadowed thumb — the one control on the composer that kept
 * the Soft UI recipes after the flat retune (docs/design/FLAT_UI.md §6), and
 * the only one that made you drag to choose between four words. Effort is a
 * discrete choice with at most five values, which is what a radio group is
 * for: every option is visible, one press picks it, arrows move between
 * them, and the selected one is a tonal fill rather than a coloured bar.
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
          "flex h-9 items-stretch gap-0.5 rounded-control bg-secondary p-0.5",
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
                // `md` (8), concentric with the track: `rounded-control` (10)
                // minus its `p-0.5` (2). `items-stretch` means a segment is
                // inset by that 2px on all four sides, so its corners and the
                // track's are struck from one centre.
                "flex min-w-0 flex-1 items-center justify-center rounded-md px-2 text-ui font-medium transition-[background-color,color] duration-fast ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring motion-reduce:transition-none",
                selected
                  ? "bg-card text-foreground shadow-raised"
                  : "text-muted-foreground hover:text-foreground",
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
