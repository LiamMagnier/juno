"use client";

import * as React from "react";
import { Brain, ChevronDown, Globe } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { composerChipClass } from "@/components/ui/composer-shell";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_W_WIDE } from "@/components/ui/menu-recipe";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { COMPARE_EFFORT_OPTIONS, compareEffortLabel, type CompareSettings } from "@/lib/compare/run-spec";
import { cn } from "@/lib/utils";
import type { ReasoningEffort } from "@/types/chat";

/**
 * The comparison's controlled conditions: one web-search switch and one
 * thinking effort, sent identically to every model. They apply to the next
 * Send. A comparison already on the board keeps the conditions it ran with
 * (its spec is frozen), so changing them never makes one pane unlike the
 * others.
 */

const DEFAULT_VALUE = "default";

export function CompareRunSettings({
  settings,
  onChange,
  disabled,
  webSearchAllowed,
}: {
  settings: CompareSettings;
  onChange: (next: CompareSettings) => void;
  disabled?: boolean;
  /** The plan includes web search. */
  webSearchAllowed: boolean;
}) {
  const searchOn = settings.webSearch && webSearchAllowed;
  const effortLabel = compareEffortLabel(settings.reasoningEffort);

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={searchOn}
              onClick={() => onChange({ ...settings, webSearch: !settings.webSearch })}
              disabled={disabled || !webSearchAllowed}
              className={cn(composerChipClass, "gap-1.5 px-2", searchOn && "bg-accent text-foreground")}
            >
              <Globe aria-hidden="true" className="size-4" />
              <span>Search</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>
          {!webSearchAllowed
            ? "Web search isn’t included in your plan"
            : searchOn
              ? "Every model may search the web"
              : "Let every model search the web"}
        </TooltipContent>
      </Tooltip>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={`Thinking effort for every model: ${effortLabel}`}
            className={cn(composerChipClass, "gap-1.5 px-2", settings.reasoningEffort && "text-foreground")}
          >
            <Brain aria-hidden="true" className="size-4" />
            <span className="truncate">{settings.reasoningEffort ? effortLabel : "Effort"}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 transition-transform duration-base ease-in-out motion-reduce:transition-none group-data-[state=open]:rotate-180" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className={MENU_W_WIDE}>
          <DropdownMenuLabel>Thinking effort, for every model</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={settings.reasoningEffort ?? DEFAULT_VALUE}
            onValueChange={(value) =>
              onChange({ ...settings, reasoningEffort: value === DEFAULT_VALUE ? null : (value as ReasoningEffort) })
            }
          >
            {COMPARE_EFFORT_OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option.value ?? DEFAULT_VALUE} value={option.value ?? DEFAULT_VALUE}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <p className="px-2 pb-1.5 pt-1 text-caption leading-relaxed text-muted-foreground">
            A model that can’t take this effort runs at its own default, and its pane says which.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  );
}
