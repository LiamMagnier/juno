"use client";

import * as React from "react";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import { ChevronRight, Circle } from "@/components/ui/icons";
import { StatusIcons } from "@/lib/app-icons";
import {
  menuGlyphInkClass,
  menuLabelClass,
  menuRowClass,
  menuSeparatorClass,
  menuShellClass,
} from "@/components/ui/menu-recipe";
import { cn } from "@/lib/utils";

const DropdownMenu = DropdownMenuPrimitive.Root;
const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
const DropdownMenuGroup = DropdownMenuPrimitive.Group;
const DropdownMenuPortal = DropdownMenuPrimitive.Portal;
const DropdownMenuSub = DropdownMenuPrimitive.Sub;
const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;

/**
 * The floating tier. Shell and row both come from `menu-recipe.ts`, which is
 * also what Select, the command palette and the composer's `+` are cut from —
 * those four open beside each other and have to read as one object. What the
 * recipe's own header explains is why they did not.
 *
 * Only the height cap is stated here, because it is the one part that cannot
 * be shared: it resolves against Radix's dropdown-specific available-height
 * variable. Radix flips and shifts a popper to fit but never SHRINKS one, so a
 * menu taller than the space under its trigger simply loses its last rows.
 * 24rem before scrolling, matching Select.
 */
const menuShell = cn(
  menuShellClass,
  "min-w-[11rem] overflow-y-auto overscroll-contain",
  "max-h-[min(24rem,var(--radix-dropdown-menu-content-available-height,24rem))]",
);

const menuItem = menuRowClass;

/**
 * The tick / dot in a checkable row. Always mounted (`forceMount`) and
 * cross-faded on `data-state`, instead of Radix's default of mounting it only
 * while checked — which drew the mark in a single frame when a row was toggled
 * with the menu held open. A toggle now fades and scales the mark in on the
 * fast rung and back out on the accelerate. Opening a menu is not a change, so
 * rows that are already checked simply start checked: a transition only runs
 * between two states, never on mount. The resting scale reads
 * `--motion-scale-from`, so the reduced tier keeps the fade and drops the scale.
 */
const menuIndicator =
  "flex items-center justify-center transition-[opacity,transform] duration-fast ease-out-soft " +
  "data-[state=unchecked]:opacity-0 data-[state=unchecked]:ease-in " +
  "data-[state=unchecked]:[transform:scale(var(--motion-scale-from,0.6))]";

const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(({ className, sideOffset = 4, collisionPadding = 8, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(menuShell, className)}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuContent.displayName = DropdownMenuPrimitive.Content.displayName;

const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> & { inset?: boolean }
>(({ className, inset, children, ...props }, ref) => (
  <DropdownMenuPrimitive.SubTrigger
    ref={ref}
    className={cn(
      menuItem,
      menuGlyphInkClass,
      "focus:bg-accent focus:text-accent-foreground data-[state=open]:bg-accent",
      inset && "pl-8",
      className
    )}
    {...props}
  >
    {children}
    {/* No `!` on the size any more: the row's default is guarded on the
        absence of a `size-*`, so stating one here is simply obeyed. */}
    <ChevronRight className="menu-item__chevron ml-auto size-3.5 text-muted-foreground/60" />
  </DropdownMenuPrimitive.SubTrigger>
));
DropdownMenuSubTrigger.displayName = DropdownMenuPrimitive.SubTrigger.displayName;

/** Identical shell to DropdownMenuContent — a submenu is the same object. */
const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(({ className, collisionPadding = 8, ...props }, ref) => (
  <DropdownMenuPrimitive.Portal>
    <DropdownMenuPrimitive.SubContent
      ref={ref}
      collisionPadding={collisionPadding}
      className={cn(menuShell, className)}
      {...props}
    />
  </DropdownMenuPrimitive.Portal>
));
DropdownMenuSubContent.displayName = DropdownMenuPrimitive.SubContent.displayName;

const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & {
    inset?: boolean;
    /**
     * `destructive` for a row that deletes, disconnects or revokes. Reddens
     * the label AND tints the focus fill, so the one row in a menu that cannot
     * be undone does not highlight exactly like Rename — keyboard users hit
     * that hardest, since focus is the only signal they get.
     */
    variant?: "default" | "destructive";
  }
>(({ className, inset, variant = "default", ...props }, ref) => (
  <DropdownMenuPrimitive.Item
    ref={ref}
    className={cn(
      menuItem,
      // The destructive row does NOT take the muted glyph ink: its icon should
      // carry the same red as its label, which it does by inheriting.
      variant === "destructive"
        ? "text-destructive focus:bg-destructive/10 focus:text-destructive"
        : cn(menuGlyphInkClass, "focus:bg-accent focus:text-accent-foreground"),
      inset && "pl-8",
      className
    )}
    {...props}
  />
));
DropdownMenuItem.displayName = DropdownMenuPrimitive.Item.displayName;

const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(({ className, children, checked, ...props }, ref) => (
  <DropdownMenuPrimitive.CheckboxItem
    ref={ref}
    className={cn(menuItem, menuGlyphInkClass, "pl-8 pr-2 focus:bg-accent focus:text-accent-foreground", className)}
    checked={checked}
    {...props}
  >
    <span className="absolute left-2 flex size-4 items-center justify-center">
      <DropdownMenuPrimitive.ItemIndicator forceMount className={menuIndicator}>
        {/* `text-primary`, like the tick in the composer's `+` menu and the
            one in Select. A checked row is the one row in a menu carrying the
            accent, and it was the only one of the three left in plain ink. */}
        <StatusIcons.success className="size-4 text-primary" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.CheckboxItem>
));
DropdownMenuCheckboxItem.displayName = DropdownMenuPrimitive.CheckboxItem.displayName;

const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem>
>(({ className, children, ...props }, ref) => (
  <DropdownMenuPrimitive.RadioItem
    ref={ref}
    className={cn(menuItem, menuGlyphInkClass, "pl-8 pr-2 focus:bg-accent focus:text-accent-foreground", className)}
    {...props}
  >
    <span className="absolute left-2 flex size-4 items-center justify-center">
      {/* The dot is the `fill` cut because it IS the on state — the one place
          a filled glyph belongs (ICONS_AND_MOTION.md §1.2). */}
      <DropdownMenuPrimitive.ItemIndicator forceMount className={menuIndicator}>
        {/* `text-current` opts out of the row's muted glyph ink (the recipe's
            guard skips any glyph that states a `text-*`): the chosen dot is in
            the label's own ink, as it was. */}
        <Circle weight="fill" className="size-2 text-current" />
      </DropdownMenuPrimitive.ItemIndicator>
    </span>
    {children}
  </DropdownMenuPrimitive.RadioItem>
));
DropdownMenuRadioItem.displayName = DropdownMenuPrimitive.RadioItem.displayName;

const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label> & { inset?: boolean }
>(({ className, inset, ...props }, ref) => (
  <DropdownMenuPrimitive.Label
    ref={ref}
    className={cn(menuLabelClass, inset && "pl-8", className)}
    {...props}
  />
));
DropdownMenuLabel.displayName = DropdownMenuPrimitive.Label.displayName;

const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(({ className, ...props }, ref) => (
  <DropdownMenuPrimitive.Separator
    ref={ref}
    // Foreground-relative rather than the border token: a separator inside a
    // raised panel resolves against whatever that panel is made of, in either
    // theme. The weight and the -mx that cancels the shell's padding are the
    // recipe's, so Select's separator is this separator.
    className={cn(menuSeparatorClass, className)}
    {...props}
  />
));
DropdownMenuSeparator.displayName = DropdownMenuPrimitive.Separator.displayName;

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
  DropdownMenuPortal,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuRadioGroup,
};
