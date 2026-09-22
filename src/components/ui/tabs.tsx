"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { motion, useReducedMotion } from "framer-motion";

import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Which tab is showing, for the thumb only.
 *
 * Radix keeps the selected value in a private context, so the root mirrors it
 * here: the caller's `value` when controlled, otherwise a copy that follows
 * `onValueChange`. The Radix root is left exactly as the caller configured it
 * — controlled stays controlled, uncontrolled stays uncontrolled — and this
 * copy only ever decides where a decorative thumb is drawn.
 */
const TabsThumbContext = React.createContext<{ value: string | undefined; id: string } | null>(null);

const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({ value, defaultValue, onValueChange, ...props }, ref) => {
  // `layoutId` is global to the page, so two tab strips on screen at once
  // must never share one — the thumb would fly between them.
  const id = `${React.useId()}-tabs-thumb`;
  const [uncontrolled, setUncontrolled] = React.useState(defaultValue);
  const current = value ?? uncontrolled;
  const thumb = React.useMemo(() => ({ value: current, id }), [current, id]);
  return (
    <TabsThumbContext.Provider value={thumb}>
      <TabsPrimitive.Root
        ref={ref}
        value={value}
        defaultValue={defaultValue}
        onValueChange={(next) => {
          setUncontrolled(next);
          onValueChange?.(next);
        }}
        {...props}
      />
    </TabsThumbContext.Provider>
  );
});
Tabs.displayName = TabsPrimitive.Root.displayName;

/**
 * Inset track, raised thumb (docs/design/FLAT_UI.md §2.2). The list is
 * `.surface-inset` at `rounded-menu` (14) with p-1, so the 10px
 * `rounded-control` thumb sits concentric inside it. SegmentedControl is the
 * same idiom; the two now move the same way too.
 *
 * `isolate` makes the list the stacking context the thumb is painted in: the
 * thumb sits at `-z-10` inside whichever trigger is active, which puts it
 * above the track's fill and below EVERY trigger's label — so while it travels
 * it passes under the neighbouring labels instead of over them.
 */
const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "surface-inset isolate inline-flex h-9 items-center justify-center rounded-menu p-1 text-muted-foreground",
      className
    )}
    {...props}
  />
));
TabsList.displayName = TabsPrimitive.List.displayName;

/**
 * ONE THUMB, carried between triggers by framer's `layoutId` on the shared
 * `spring.standard` — the settle the product switch, the segmented control
 * and the page tabs all use, so every selection mark in the product lands the
 * same way. It used to be a `.surface-raised` fill switched on per trigger,
 * which cross-faded one key out and another in 60px away: the selection
 * blinked rather than moved.
 *
 * A trigger rendered outside `<Tabs>` (a bare Radix root) keeps the old
 * per-trigger fill, so nothing loses its selected state. So does an `asChild`
 * trigger: Radix hands its children to a Slot, which takes exactly one child,
 * so there is no room for a thumb beside the caller's element.
 */
const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, children, value, ...props }, ref) => {
  const context = React.useContext(TabsThumbContext);
  const thumb = props.asChild ? null : context;
  const reduceMotion = useReducedMotion() ?? false;
  const thumbId = thumb !== null && thumb.value === value ? thumb.id : null;
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      value={value}
      className={cn(
        // Scoped transition, not transition-all: the latter puts width, height,
        // padding and font-size on the compositor's critical path for a change
        // that only ever touches colour.
        //
        // Every trigger carries a 1px border (transparent) so its box matches
        // the thumb's, which covers the border box. The inactive hover is a
        // faint wash below the thumb's own contrast: it says "you can press
        // here", not "a second selected state".
        "relative inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-control border border-transparent px-3 py-1 text-ui font-medium transition-[color,background-color,border-color,box-shadow] duration-fast ease-out-soft motion-reduce:transition-none hover:text-foreground data-[state=inactive]:hover:bg-accent/60 disabled:pointer-events-none disabled:opacity-50 data-[state=active]:text-foreground [&_svg]:size-4 [&_svg]:shrink-0",
        thumb === null && "data-[state=active]:surface-raised data-[state=active]:border-border/60",
        className
      )}
      {...props}
    >
      {thumb === null ? (
        children
      ) : (
        <>
          {thumbId !== null && (
            <motion.span
              layoutId={thumbId}
              aria-hidden="true"
              transition={reduceMotion ? { duration: 0 } : spring.standard}
              // The raised key. The radius rides `style` so framer keeps the
              // corners true while it scales the box between two triggers of
              // different widths.
              className="surface-raised pointer-events-none absolute -inset-px -z-10 border-border/60"
              style={{ borderRadius: 10 }}
            />
          )}
          {children}
        </>
      )}
    </TabsPrimitive.Trigger>
  );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      // Opacity only: the panel is the size of the page region it replaces,
      // and a panel that travels reads as a route change.
      "data-[state=active]:animate-fade-in",
      className
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
