"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { ChevronDown, ChevronUp } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import { menuGlyphInkClass, menuRowClass, menuShellClass } from "@/components/ui/menu-recipe";
import { cn } from "@/lib/utils";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

/**
 * The trigger is the third text-entry control and shares input.tsx's recipe
 * exactly: `.surface-inset`, the --input hairline, border-only focus, the
 * same 220ms hover ramp, the same touch height.
 */
const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      "surface-inset group flex h-9 w-full items-center justify-between whitespace-nowrap rounded-field border border-input px-3.5 py-2 text-ui transition-[color,border-color,box-shadow] duration-base ease-out-soft placeholder:text-muted-foreground hover:border-foreground/60 focus-visible:border-foreground/70 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 coarse:h-11 [&>span]:line-clamp-1",
      className
    )}
    {...props}
  >
    {children}
    <SelectPrimitive.Icon asChild>
      {/* ease-in-out, not ease-out-soft: this is an A-to-B move with both
          endpoints visible (the token table's own rule for a chevron rotate) —
          an ease-out makes it look like it arrives from somewhere off-screen. */}
      <ChevronDown className="size-4 shrink-0 opacity-60 transition-transform duration-base ease-in-out motion-reduce:transition-none group-data-[state=open]:rotate-180" />
    </SelectPrimitive.Icon>
  </SelectPrimitive.Trigger>
));
SelectTrigger.displayName = SelectPrimitive.Trigger.displayName;

/**
 * The floating tier — `menu-recipe.ts`, the same shell DropdownMenu opens: the
 * two appear side by side (a Select inside a settings panel, a kebab on the row
 * behind it) and have to be one object.
 *
 * The shell's own `p-1` is dropped here and moved onto the Viewport, because
 * Radix needs the scroll buttons OUTSIDE the padded box — padding on the
 * Content would put a 4px band of popover between the button and the shell
 * edge, and the list would slide through it.
 */
const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", sideOffset = 4, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        // pop-in/out fill `both`, which would permanently cancel translate-y utilities —
        // the trigger gap comes from sideOffset instead.
        menuShellClass,
        "relative min-w-[8rem] overflow-hidden p-0 max-h-[min(24rem,var(--radix-select-content-available-height,24rem))]",
        className
      )}
      position={position}
      sideOffset={sideOffset}
      {...props}
    >
      {/* The scroll affordances are opaque and muted. Transparent, they let the
          list slide visibly underneath them, so the chevron read as one more
          item rather than as the edge of the scroll region. */}
      <SelectPrimitive.ScrollUpButton className="flex cursor-default items-center justify-center bg-popover py-1 text-muted-foreground">
        <ChevronUp className="size-4" />
      </SelectPrimitive.ScrollUpButton>
      <SelectPrimitive.Viewport
        className={cn("p-1", position === "popper" && "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]")}
      >
        {children}
      </SelectPrimitive.Viewport>
      <SelectPrimitive.ScrollDownButton className="flex cursor-default items-center justify-center bg-popover py-1 text-muted-foreground">
        <ChevronDown className="size-4" />
      </SelectPrimitive.ScrollDownButton>
    </SelectPrimitive.Content>
  </SelectPrimitive.Portal>
));
SelectContent.displayName = SelectPrimitive.Content.displayName;

const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Item
    ref={ref}
    className={cn(
      menuRowClass,
      menuGlyphInkClass,
      "w-full pl-8 pr-2 focus:bg-accent focus:text-accent-foreground",
      className
    )}
    {...props}
  >
    {/* size-4 box for a size-4 glyph, so the tick sits optically centred in
        the gutter it shares with DropdownMenu's identical indicator. */}
    <span className="absolute left-2 flex size-4 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <StatusIcons.success className="size-4 text-primary" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem };
