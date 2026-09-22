"use client";

import * as React from "react";
import { ChevronDown } from "@/components/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_W_WIDE } from "@/components/ui/menu-recipe";
import { cn } from "@/lib/utils";

export interface ChoiceOption<T extends string> {
  value: T;
  label: string;
  /** One line under the label, in the menu only. The trigger shows the label. */
  description?: string;
  disabled?: boolean;
}

/**
 * The trigger's look is SelectTrigger's recipe, restated because the two sit
 * in the same column of rows and have to read as one control: the inset
 * field, the input hairline, the field radius, the touch height.
 */
export const choiceTriggerClass =
  "surface-inset group flex h-9 w-full min-w-0 items-center justify-between gap-2 whitespace-nowrap rounded-field border border-input px-3.5 text-left text-ui transition-[color,border-color] duration-base ease-out-soft hover:border-foreground/60 focus-visible:border-foreground/70 disabled:cursor-not-allowed disabled:opacity-50 coarse:h-11";

/**
 * One choice from a short list whose options need a sentence each to tell
 * apart: a personality, an approval policy, a voice, where background work
 * may run.
 *
 * A Select cannot say it: everything inside a Select item is also the value
 * the trigger shows, so a described option either printed its sentence in
 * the closed trigger or had no sentence at all. The old answer was a grid of
 * bordered radio tiles, five to thirteen cards per group, which is where most
 * of the settings pane's weight came from. This is ChatGPT's answer to the
 * same problem: the trigger shows the choice, the menu explains all of them.
 *
 * The accessible name is the setting and then the current choice ("Personality
 * Concise"), so the button says both what it sets and what it is set to.
 */
export function ChoiceMenu<T extends string>({
  value,
  options,
  onChange,
  label,
  className,
  disabled,
}: {
  value: T;
  options: readonly ChoiceOption<T>[];
  onChange: (value: T) => void;
  /** The setting's name, read before the current choice. Not shown. */
  label: string;
  className?: string;
  disabled?: boolean;
}) {
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button type="button" className={cn(choiceTriggerClass, className)}>
          <span className="sr-only">{label} </span>
          <span className="min-w-0 truncate">{current?.label}</span>
          {/* The same A-to-B rotate the Select chevron makes. */}
          <ChevronDown
            className="size-4 shrink-0 opacity-60 transition-transform duration-base ease-in-out motion-reduce:transition-none group-data-[state=open]:rotate-180"
            aria-hidden="true"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={MENU_W_WIDE}>
        <DropdownMenuRadioGroup value={value} onValueChange={(next) => onChange(next as T)}>
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
              className={cn(option.description && "items-start py-2 [&>span:first-child]:mt-0.5")}
            >
              <span className="flex min-w-0 flex-col">
                <span className="text-ui font-medium text-foreground">{option.label}</span>
                {option.description && (
                  <span className="text-caption text-muted-foreground">{option.description}</span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
