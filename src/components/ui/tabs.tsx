"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

/**
 * Inset track, raised thumb (docs/design/SOFT_UI.md §2.2). The list is
 * `.surface-inset` at `rounded-menu` (14) with p-1, so the 10px
 * `rounded-control` triggers sit concentric inside it; the active trigger is
 * `.surface-raised` — a key standing proud of its slot. SegmentedControl is
 * the same idiom with a gliding thumb.
 */
const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn("surface-inset inline-flex h-9 items-center justify-center rounded-menu p-1 text-muted-foreground", className)}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      // Scoped transition, not transition-all: the latter puts width, height,
      // padding and font-size on the compositor's critical path for a change that
      // only ever touches colour and the thumb's shadow.
      //
      // Every trigger carries a 1px border (transparent while inactive) so the
      // raised material's hairline arriving on the active one moves nothing.
      // The inactive hover is a faint wash below the thumb's own contrast: it
      // says "you can press here", not "a second selected state".
      "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control border border-transparent px-3 py-1 text-sm font-medium transition-[color,background-color,border-color,box-shadow] duration-base ease-out-soft motion-reduce:transition-none hover:text-foreground data-[state=inactive]:hover:bg-accent/60 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:surface-raised data-[state=active]:border-border/60 data-[state=active]:text-foreground [&_svg]:size-4 [&_svg]:shrink-0",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "data-[state=active]:animate-fade-in",
      className
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
