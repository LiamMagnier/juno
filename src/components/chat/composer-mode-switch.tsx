"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";

import { useWorkNeedsYouCount } from "@/components/work/inbox/use-needs-you-count";
import { spring } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Chat or Work, in the composer — because it is not a place, it is a way of
 * asking.
 *
 * This used to be the middle segment of the sidebar's product switcher, next
 * to Chat and Code. That put it with the things you NAVIGATE to, and Work is
 * not one: you do not go to Work, you hand Juno an errand with a finish line
 * instead of opening a conversation. That decision belongs where you write the
 * ask. The sidebar switcher is Chat / Code now (see `SIDEBAR_PRODUCTS`).
 *
 * NO GLYPHS, and that is the point rather than a saving. Every other control on
 * this row carries a mark because each names an object — a file to attach, a
 * model to answer with. This one qualifies the SENTENCE you are about to send,
 * and a mark beside it would make it look like a destination again, which is
 * exactly the reading being corrected.
 *
 * REAL LINKS, not a router push on a button. Work and Chat are separate routes
 * with separate composers, so this is navigation and has to behave like it:
 * middle-click, cmd-click, hover preview and "open in new tab" all work, and
 * assistive tech is told these are links rather than buttons that do something
 * unspecified. The same argument `AppPageHeader`'s back link is built on.
 */
const MODES = [
  { id: "chat", label: "Chat", href: "/chat" },
  { id: "work", label: "Work", href: "/work" },
] as const;

export function ComposerModeSwitch({ className }: { className?: string }) {
  const pathname = usePathname();
  const reduceMotion = useReducedMotion() ?? false;
  /*
   * WHICH SEGMENT IS LIT, BEFORE THE ROUTE SAYS SO.
   *
   * `active` used to be derived from `pathname` alone, so pressing Work left
   * the control looking untouched until the new route committed — the one
   * control in the product where you press a thing and it does not respond.
   * The composer then unmounts with the old page, so there is no way to animate
   * ACROSS the navigation either: whatever the thumb does, it has to do it in
   * the frame after the press, while this component is still alive.
   *
   * So the press is recorded here and the pathname overrules it as soon as it
   * agrees — a claim about what was pressed, not about where the reader is. If
   * the navigation is slow the pill has still moved; if it never lands (a
   * cancelled transition, a Back before it commits) the effect below puts the
   * pill back where the URL says it belongs. Nothing is faked for longer than
   * the router takes.
   */
  const [pressed, setPressed] = React.useState<(typeof MODES)[number]["id"] | null>(null);
  /*
   * The count came WITH the segment. It used to sit on the sidebar switcher's
   * Work tile, and leaving it there when Work moved would have deleted the one
   * signal that a run is parked waiting for a person — silently, which is the
   * way a signal is usually lost. It is a hook, so this reads it directly
   * rather than being handed it down a prop chain that no longer exists.
   */
  const needsYou = useWorkNeedsYouCount() ?? 0;
  // `/work/skills`, `/work/schedules` and a run at `/work/<id>` are all Work.
  const routed = pathname?.startsWith("/work") ? "work" : "chat";
  const active = pressed ?? routed;

  // The optimistic claim is retired the moment the URL can answer for itself —
  // including when it answers with the segment the reader did NOT press.
  React.useEffect(() => {
    setPressed(null);
  }, [routed]);

  // MANDATORY scoping, the same rule ProductSwitch's thumb is held to: this
  // control can be mounted more than once (the chat composer and a work
  // composer both draw it, and a phone lays one out per breakpoint), and a
  // global-string layoutId would make one instance's thumb fly across the
  // screen to the other.
  const thumbId = `${React.useId()}-mode-thumb`;

  return (
    <nav
      aria-label="Composer mode"
      className={cn(
        // `h-8` and `rounded-control`, like every other control on this row: a
        // pill one pixel taller than its neighbours is the kind of thing you
        // cannot name but can see. `p-0.5` holds the segments off the track's
        // edge so the selected fill sits concentric inside it.
        "inline-flex h-8 shrink-0 items-center gap-0.5 rounded-control bg-secondary/60 p-0.5 coarse:h-10",
        className,
      )}
    >
      {MODES.map((mode) => {
        const selected = mode.id === active;
        return (
          <Link
            key={mode.id}
            href={mode.href}
            /*
             * EAGER, not the default.
             *
             * `/work` reads `useSearchParams`, which makes it a dynamic route,
             * and Next's automatic prefetch stops at the first loading boundary
             * for those — so the router arrived holding a placeholder and had to
             * go and fetch the page. That is where the loading animation on
             * Chat -> Work came from, and deleting the boundary (which is what
             * app/(app)/work/loading.tsx was) only helps if the payload is
             * actually warm by the time the reader presses. This control is
             * permanently on screen beside the composer, so both routes are a
             * few kB fetched once and the switch is then a repaint, not a
             * round trip.
             */
            prefetch
            onClick={(event) => {
              // A modified click is not a navigation THIS document makes:
              // cmd/ctrl opens a tab, shift a window, a middle click either.
              // Lighting the segment for one of those would say the reader had
              // moved when they had deliberately stayed.
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
              if (event.button !== 0) return;
              setPressed(mode.id);
            }}
            aria-current={selected ? "page" : undefined}
            className={cn(
              // `rounded-md` is 8px, and that is the CONCENTRIC value, not a guess: the
              // track is `rounded-control` (10px) with `p-0.5` (2px), and the
              // ladder's rule is outer = inner + padding. 10 - 2 = 8.
              "relative inline-flex h-7 items-center rounded-md px-2.5 text-ui transition-colors duration-fast ease-out-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring coarse:h-9 motion-reduce:transition-none",
              selected
                ? // The tonal "this one is chosen" recipe the sidebar's active
                  // row, the product switch's thumb and the thinking slider all
                  // use — fill and ink, never weight. Swapping weight on select
                  // re-measures the word and shifts its neighbour.
                  "font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {selected && (
              /*
               * ONE FILL THAT TRAVELS, not two that cross-fade.
               *
               * The fill used to be a background on each segment, so selecting
               * the other one faded this square out while that square faded in:
               * for 140ms there are two half-lit chips and no object anywhere,
               * which reads as a repaint rather than as a choice being made. A
               * shared `layoutId` makes it the SAME box moving a known distance
               * — which is what the control means, and what the sidebar's
               * product switch has always done. `spring.standard` is that
               * switch's transition, and the Mac app's, so a thumb travelling
               * means the same thing in all three.
               */
              <motion.span
                layoutId={thumbId}
                aria-hidden="true"
                transition={reduceMotion ? { duration: 0 } : spring.standard}
                // Tonal fill, no border and no shadow — FLAT_UI §4, the same
                // recipe the sidebar's active row and the product switch's thumb
                // are drawn with.
                className="absolute inset-0 rounded-md bg-card"
                // framer has to keep the corners true while it scales the box.
                style={{ borderRadius: 8 }}
              />
            )}
            <span className="relative">{mode.label}</span>
            {mode.id === "work" && needsYou > 0 && (
              /* A dot, not a number. How MANY runs are waiting is a question
                 the Work page answers; this only has to say that any are, and
                 a count here would be a second fact competing with the word it
                 sits beside. `--primary` is the product's one saturated ink and
                 this is exactly what FLAT_UI.md reserves it for: state. */
              <span
                aria-hidden
                className="relative ml-1.5 size-1.5 shrink-0 rounded-full bg-primary"
              />
            )}
            {mode.id === "work" && needsYou > 0 && (
              <span className="sr-only">{` — ${needsYou} waiting for you`}</span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}
