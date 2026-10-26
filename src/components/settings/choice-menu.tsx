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
 * Settings' one dropdown trigger. ChoiceMenu, ModelTrigger and SelectTrigger
 * sit in the same column of rows and have to be one control, so this is
 * SelectTrigger's rest, hover and open state to the alpha: the faint
 * `foreground/[0.14]` hairline over a `0.025` tint (`white/[0.12]` over
 * `0.03` in dark), one step toward ink on hover and while open, the field
 * radius, the touch height.
 *
 * It used to draw the `--input` boundary instead (rgb 134,137,141 on the
 * light page), a mid-grey outline beside the soft Select fields in the same
 * card; a trigger named by its text and a chevron needs no 3:1 edge, which is
 * what Select and Input already rely on. Keyboard focus is Input's: one
 * continuous 2px line in `--ring` at 0.55 (`kbd-focus:`), no halo.
 */
export const choiceTriggerClass =
  "group flex h-9 w-full min-w-0 items-center justify-between gap-2 whitespace-nowrap rounded-field border border-foreground/[0.14] bg-foreground/[0.025] px-3.5 text-left text-ui text-foreground transition-[color,border-color,box-shadow,background-color] duration-base ease-out-soft hover:border-foreground/25 data-[state=open]:border-foreground/25 dark:border-white/[0.12] dark:bg-white/[0.03] dark:hover:border-white/25 dark:data-[state=open]:border-white/25 focus-visible:outline-none kbd-focus:border-[hsl(var(--ring)/0.55)] kbd-focus:shadow-[0_0_0_1px_hsl(var(--ring)/0.55)] disabled:cursor-not-allowed disabled:opacity-50 coarse:h-11";

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
