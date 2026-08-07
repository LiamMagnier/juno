"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    // rounded-menu (14) − 4px padding = concentric with the rounded-control (10)
    // triggers; recessed track. Geometry is unchanged — the arbitrary values are
    // just named now, so SegmentedControl can share the same two rungs.
    className={cn("inline-flex h-9 items-center justify-center rounded-menu bg-muted/70 p-1 text-muted-foreground field-well", className)}
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
      // only ever touches colour and the thumb's shadow (same reasoning as card.tsx).
      "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control px-3 py-1 text-sm font-medium transition-[color,background-color,box-shadow] duration-base ease-out-soft hover:text-foreground disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:[box-shadow:inset_0_1px_0_hsl(var(--sheen)),var(--shadow-pop)] [&_svg]:size-4",
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
