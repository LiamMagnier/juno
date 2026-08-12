"use client";

import * as React from "react";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

const Select = SelectPrimitive.Root;
const SelectGroup = SelectPrimitive.Group;
const SelectValue = SelectPrimitive.Value;

const SelectTrigger = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger>
>(({ className, children, ...props }, ref) => (
  <SelectPrimitive.Trigger
    ref={ref}
    className={cn(
      // Three divergences from the two other field controls, all fixed here.
      // `placeholder:text-muted-foreground/70` is the exact modifier input.tsx
      // and textarea.tsx removed with a note recording it as a 2.91:1 contrast
      // failure — a Select beside an Input in one form had a measurably dimmer
      // placeholder. `duration-fast` ran the identical property list at 120ms
      // where the other two run 220ms, so one hover resolved at two speeds
      // across a single row. And `focus-visible:outline-none` killed the
      // authoritative global :focus-visible ring (globals.css), leaving the
      // border swap alone to carry focus on the controls where focus matters
      // most; the border swap is kept, the outline suppression is not.
      // A fourth, shared with all three: `border-input/80` on hover composited
      // away from --input rather than past it, so approaching any field control
      // faded its own outline. `foreground/60` is the middle rung of the
      // rest → hover → focus ramp; see the arithmetic in input.tsx.
      "group flex h-9 w-full items-center justify-between whitespace-nowrap rounded-field border border-input px-3.5 py-2 text-sm field-well transition-[color,border-color,box-shadow] duration-base ease-out-soft placeholder:text-muted-foreground hover:border-foreground/60 focus-visible:border-foreground/70 disabled:cursor-not-allowed disabled:opacity-50 coarse:h-11 [&>span]:line-clamp-1",
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

const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(({ className, children, position = "popper", sideOffset = 4, ...props }, ref) => (
  <SelectPrimitive.Portal>
    <SelectPrimitive.Content
      ref={ref}
      className={cn(
        // pop-in/out fill `both`, which would permanently cancel translate-y utilities —
        // the trigger gap comes from sideOffset instead. 12px shell − p-1.5 (6px)
        // = the 6px items, exactly as DropdownMenu: the two open side by side
        // (model picker beside the download menu) and must be the same object.
        "relative z-popper max-h-[min(24rem,var(--radix-select-content-available-height,24rem))] min-w-[8rem] max-w-[calc(100vw-1rem)] origin-popper overflow-hidden rounded-menu overlay-glass data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
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
        // p-1.5, not p-1: 6 (item) + 6 = the 12 of the shell. At p-1 the identical
        // item sat 2px closer to the rim here than in a DropdownMenu.
        className={cn("p-1.5", position === "popper" && "h-[var(--radix-select-trigger-height)] w-full min-w-[var(--radix-select-trigger-width)]")}
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
      "menu-item group/menu-item relative flex w-full cursor-pointer select-none items-center gap-2 rounded-xs py-1.5 pl-8 pr-2 text-sm outline-none transition-colors duration-fast ease-out-soft focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
      className
    )}
    {...props}
  >
    {/* size-4 box for a size-4 glyph: the 3.5 box was a quarter-pixel narrower
        than the Check inside it, so the tick sat optically off-centre in the
        gutter it shares with DropdownMenu's identical indicator. */}
    <span className="absolute left-2 flex size-4 items-center justify-center">
      <SelectPrimitive.ItemIndicator>
        <Check className="size-4" />
      </SelectPrimitive.ItemIndicator>
    </span>
    <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
  </SelectPrimitive.Item>
));
SelectItem.displayName = SelectPrimitive.Item.displayName;

export { Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectItem };
