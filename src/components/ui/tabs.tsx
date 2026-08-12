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
    // rounded-menu (12) − 4px padding = concentric with the rounded-control (9)
    // triggers; recessed track. The comment used to read 14 and 10, which are
    // neither rung's value (tailwind.config.ts) — an arithmetic that happened to
    // reach the same conclusion from two wrong numbers. SegmentedControl shares
    // these exact two rungs.
    //
    // `bg-muted/70` is gone and `field-well` supplies the fill alone. The two
    // were fighting, and worse, they were splitting the track across the two
    // themes: utilities are emitted after the components layer, so on light
    // `.bg-muted/70` beat `.field-well`, while on dark `.dark .field-well`
    // (0,2,0) beat the utility (0,1,0). The light track and the dark track were
    // therefore coming from two different systems, and a retheme of `.field-well`
    // — the class whose whole job is knowing that a well LIFTS on black instead
    // of recessing below it — reached only half of them.
    className={cn("inline-flex h-9 items-center justify-center rounded-menu p-1 text-muted-foreground field-well", className)}
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
      // The INACTIVE tab had a colour-only hover, which is the same failure the
      // segmented control's inactive segment had: the label brightened with no
      // ground under it, so on the black theme the hit area was invisible until
      // the pointer was already inside it. `data-[state=inactive]:hover:bg-accent/60`
      // is the wash — deliberately below the active thumb's own contrast, so it
      // reads as "you can press here" and not as a second selected state.
      //
      // The ACTIVE fill is `bg-card` on paper and `bg-accent` on dark, because
      // raised is a lightness relationship and the ramps disagree about which
      // way it points. Against this track (--muted at /70) --card sits 2.6
      // points up on paper and a tenth of a point DOWN on black, so the active
      // tab was distinguished from the well behind it by its sheen alone.
      // --accent gives dark the same one-rung step light already had.
      // SegmentedControl's thumb carries the identical pair — same idiom.
      "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control px-3 py-1 text-sm font-medium transition-[color,background-color,box-shadow] duration-base ease-out-soft motion-reduce:transition-none hover:text-foreground data-[state=inactive]:hover:bg-accent/60 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:bg-card dark:data-[state=active]:bg-accent data-[state=active]:text-foreground data-[state=active]:[box-shadow:inset_0_1px_0_hsl(var(--sheen)),var(--shadow-pop)] [&_svg]:size-4 [&_svg]:shrink-0",
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
