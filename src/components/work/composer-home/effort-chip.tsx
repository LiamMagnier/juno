"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ReasoningSlider } from "@/components/chat/reasoning-slider";
import type { ReasoningEffort, ReasoningOption } from "@/lib/model-metrics";
import { cn } from "@/lib/utils";

/*
 * How hard the model thinks, as a chip in the composer's inline row.
 *
 * Extracted from `work-composer.tsx`, where the two branches — the disabled
 * "Auto" twin and the real popover trigger — were an inline IIFE inside the
 * `controls` prop, indented eleven levels, and carried between them almost as
 * many lines of comment as the composer's entire opening essay.
 *
 * Both branches render the hairline that separates this from the model picker,
 * rather than the caller drawing it: the separator belongs to the control on its
 * right and has to disappear with it. Drawn by the caller, it survived the one
 * case where nothing follows it — a model that exposes no tiers at all — leaving
 * a rule with nothing on either side of it.
 */

/** The one divider in the composer's inline row, so both branches draw it alike. */
function Divider() {
  return (
    <span
      className="mx-0.5 hidden h-4 w-px shrink-0 bg-border/60 min-[380px]:block"
      aria-hidden="true"
    />
  );
}

/**
 * The three widths this chip takes, hoisted so the Auto twin and the live
 * trigger cannot drift apart.
 *
 * They were written out twice, and the pair had already diverged in every
 * property except the widths: the Auto span was `rounded-control` (9px) against
 * the trigger's `rounded-composer-control` (12px, the rung the [+] and the mic
 * beside them sit on), and it topped out at 32px on touch beside two neighbours
 * that grow to 44. Switching the model to Auto therefore changed the corner
 * radius of one chip in the row and resized the row under the reader's pointer.
 */
const CHIP_METRICS =
  "h-8 w-[4.75rem] shrink-0 rounded-composer-control px-2 font-mono text-ui coarse:h-11 min-[360px]:w-[5.5rem] min-[480px]:w-[7.25rem]";

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
      <>
        <Divider />
        <Tooltip>
          <TooltipTrigger asChild>
            {/* The disabled twin of the trigger below, at that trigger's exact
                metrics. */}
            <span
              className={cn(
                CHIP_METRICS,
                "inline-flex items-center justify-center gap-1 text-muted-foreground"
              )}
              aria-label="Thinking effort: Auto — chosen with the model"
            >
              <span className="truncate">Auto</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>Thinking depth is chosen automatically with the model</TooltipContent>
        </Tooltip>
      </>
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
    <>
      <Divider />
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
                className={cn(
                  // `.composer-chip`, which is verbatim what chat's identical
                  // trigger carries. The two `ring-0`s that used to sit here went
                  // with it: Button declares no ring at all — globals.css's
                  // `:focus-visible` outline is what draws keyboard focus — so
                  // they cancelled nothing, while `focus-visible:bg-accent`
                  // beside them painted focus in the same fill as hover and as
                  // open, leaving the three states indistinguishable.
                  "composer-chip group justify-between gap-1 tracking-tight focus-visible:ring-offset-card",
                  CHIP_METRICS,
                  // Full strength, matching the model name beside it. `/80` put
                  // one of the two most consequential values on the row below the
                  // ink of everything around it.
                  atTopTier ? "text-ultra" : "text-foreground"
                )}
              >
                <span className="min-w-0 flex-1 truncate text-center min-[480px]:hidden">
                  {compact}
                </span>
                <span className="hidden min-w-0 flex-1 truncate text-center min-[480px]:inline">
                  {current.label}
                </span>
                <ChevronDown className="size-3 shrink-0 opacity-50 transition-transform duration-base ease-in-out group-data-[state=open]:rotate-180" />
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
    </>
  );
}
