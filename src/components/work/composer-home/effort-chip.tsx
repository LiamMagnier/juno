"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import { composerChevronClass, composerChipClass } from "@/components/ui/composer-shell";
import type { ReasoningEffort, ReasoningOption } from "@/lib/model-metrics";
import { cn } from "@/lib/utils";

/*
 * How hard the model thinks, as a chip in the composer's controls row.
 *
 * Extracted from `work-composer.tsx`, where the two branches — the disabled
 * "Auto" twin and the real popover trigger — were an inline IIFE inside the
 * `controls` prop, indented eleven levels. Both wear the product-wide composer
 * chip, verbatim what chat's identical trigger carries.
 */

export function WorkEffortChip({
  /** True for the Auto model, where the depth is chosen with the model. */
  auto,
  options,
  /** The CLAMPED effort — what this model would honour, not what is stored. */
  value,
  onChange,
  disabled,
}: {
  auto: boolean;
  options: ReasoningOption[];
  value: ReasoningEffort;
  onChange: (next: ReasoningEffort) => void;
  disabled: boolean;
}) {
  if (auto) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* The disabled twin of the trigger below, on the same chip. */}
          <span
            className={cn(composerChipClass, "cursor-default text-muted-foreground hover:bg-transparent hover:text-muted-foreground")}
            aria-label="Thinking effort: Auto — chosen with the model"
          >
            <span className="truncate">Auto</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>Thinking depth is chosen automatically with the model</TooltipContent>
      </Tooltip>
    );
  }

  // A one-stop slider is a question with one answer, and a model that exposes no
  // tiers at all has nothing to ask.
  if (options.length === 0) return null;

  /*
   * Matched against the clamped value, never the raw preference.
   *
   * The two disagree whenever a tier chosen elsewhere is wider than this model
   * offers, and matching the raw one falls through to `options[0]` — the LOWEST
   * tier — while the run goes out at the highest tier at or below it. The label
   * would read "Instant" for a task that thought hard.
   */
  const current = options.find((option) => option.value === value) ?? options[0];
  const compact = current.label === "Extra high" ? "X-high" : current.label;
  const atTopTier = options.length > 1 && current.value === options[options.length - 1].value;

  return (
    <Tooltip>
        <Popover>
          <PopoverTrigger asChild>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                aria-label={`Thinking effort: ${current.label}`}
                className={cn(composerChipClass, atTopTier && "text-primary hover:text-primary")}
              >
                <span className="min-w-0 truncate">{compact}</span>
                <ChevronDown className={composerChevronClass} />
              </Button>
            </TooltipTrigger>
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={10} className="w-[264px] origin-popper p-3">
            {/* No Flash-mode switch, unlike chat's. That toggle swaps the
                transport for a lower-latency one the Work runner does not use, so
                offering it would be a control with nothing behind it — the exact
                mistake this whole surface was carrying until the executor learned
                to carry an effort. */}
            <ReasoningSlider
              options={options}
              value={value}
              onChange={onChange}
              disabled={disabled}
            />
          </PopoverContent>
        </Popover>
        <TooltipContent>Thinking effort</TooltipContent>
    </Tooltip>
  );
}
