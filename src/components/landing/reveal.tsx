"use client";

import * as React from "react";
import { LazyMotion, MotionConfig, domAnimation, m, useInView, type Variants } from "framer-motion";

import { staggerDelay, type StaggerRung } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * Scroll reveals for the landing page: the sections below the hero arrive as
 * the reader scrolls to them, once, instead of being painted all at once
 * while they were still off screen.
 *
 * WHY A CLIENT ISLAND on a page that is otherwise server markup. The CSS
 * entrances (`animate-rise-in` + `staggerDelay`) run on LOAD, so everything
 * below the fold finished its entrance before anyone could see it: the lineup's
 * fade-in was dealt to an empty viewport. Only an observer knows when a block
 * is actually read, and framer's `useInView` is that observer. The children
 * stay server-rendered; this file only wraps them.
 *
 * VISIBLE UNTIL PROVEN OFF SCREEN. The server renders every block at rest
 * (`initial={false}`), so the page reads in full from the HTML alone: with no
 * JavaScript, on a slow or failed chunk, and on a `/#pricing` deep link whose
 * section is on screen before anything has hydrated. Only after mount, and
 * only for a block that is still wholly BELOW the viewport, is the hidden
 * state set: instantly, and out of sight. A block already on screen, or
 * already scrolled past, is never hidden, so nothing the reader can see
 * blinks out in order to fade back in.
 *
 * WHY `m` + `LazyMotion`. The landing loads none of the app's chunks, so this
 * island pays for framer on its own. `m` with the `domAnimation` feature set is
 * the smallest build that animates variants.
 *
 * REDUCED MOTION. `MotionConfig reducedMotion="user"` drops the travel and keeps
 * the fade on its timing (docs/design/ICONS_AND_MOTION.md §2.2.10), without the
 * server/client style mismatch a `useReducedMotion()` branch would cause on
 * hydration.
 *
 * PRINT. A block hidden below the fold and never scrolled to would print as
 * blank space, so print forces the rest state.
 */

/**
 * How far a block travels as it arrives: the system's long-travel entrance,
 * `variants.stage` (12px on `transition.slow`, ease-out-expo), turned from the
 * horizontal to the vertical. The in-app `rise` is 6px, which on the landing
 * reads as a flicker inside the reader's own scroll; a reveal crosses that
 * scroll and needs the longer rung.
 */
const RISE = 28;

const PRINT = "print:!transform-none print:!opacity-100";

const SELF: Variants = {
  // Only ever set below the fold, where there is nothing to watch: instant.
  hidden: { opacity: 0, y: RISE, transition: { duration: 0 } },
  visible: (delay: number = 0) => ({ opacity: 1, y: 0, transition: { duration: 0.65, ease: [0.16, 1, 0.3, 1], delay } }),
};

/** The parent only orchestrates: its children carry the motion. */
const ORCHESTRATOR: Variants = { hidden: {}, visible: {} };

type RevealState = "hidden" | "visible";

/**
 * `staggerDelay` in seconds: the same rungs and the same cap as every CSS list
 * in the product (the download page's rows included), so the two front-door
 * pages deal their lists at one tempo.
 */
function staggerSeconds(index: number, rung: StaggerRung, offsetMs: number) {
  return Number.parseFloat(String(staggerDelay(index, rung, offsetMs).animationDelay)) / 1000;
}

/**
 * The reveal state for one block: `visible` on the server and on first
 * render, `hidden` only once mounted wholly below the fold, and `visible`
 * again (animated) the first time `amount` of it is on screen.
 */
function useReveal(amount: number) {
  const ref = React.useRef<HTMLElement | null>(null);
  const [armed, setArmed] = React.useState(false);
  const inView = useInView(ref, { once: true, amount });

  React.useEffect(() => {
    const el = ref.current;
    if (el && el.getBoundingClientRect().top >= window.innerHeight) setArmed(true);
  }, []);

  const state: RevealState = armed && !inView ? "hidden" : "visible";
  return { ref, state };
}

type Tag = "div" | "ul" | "dl" | "li";

interface BlockProps {
  as?: Tag;
  className?: string;
  children: React.ReactNode;
  "aria-label"?: string;
}

/** One element, whichever tag the markup needs, with the shared motion props. */
function MotionBlock({
  as = "div",
  className,
  children,
  blockRef,
  ...motionProps
}: BlockProps & {
  blockRef?: React.Ref<HTMLElement>;
  variants: Variants;
  custom?: number;
  initial?: false;
  animate?: RevealState;
}) {
  const props = { ...motionProps, className: cn(PRINT, className) };
  switch (as) {
    case "ul":
      return (
        <m.ul ref={blockRef as React.Ref<HTMLUListElement>} {...props}>
          {children}
        </m.ul>
      );
    case "dl":
      return (
        <m.dl ref={blockRef as React.Ref<HTMLDListElement>} {...props}>
          {children}
        </m.dl>
      );
    case "li":
      return (
        <m.li ref={blockRef as React.Ref<HTMLLIElement>} {...props}>
          {children}
        </m.li>
      );
    default:
      return (
        <m.div ref={blockRef as React.Ref<HTMLDivElement>} {...props}>
          {children}
        </m.div>
      );
  }
}

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <LazyMotion features={domAnimation}>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}

/**
 * A block that rises into place the first time ~30% of it is on screen.
 * `delay` (seconds) staggers it after a sibling that arrives in the same frame.
 */
export function Reveal({ amount = 0.3, delay = 0, ...props }: BlockProps & { amount?: number; delay?: number }) {
  const { ref, state } = useReveal(amount);
  return (
    <Providers>
      <MotionBlock {...props} blockRef={ref} variants={SELF} custom={delay} initial={false} animate={state} />
    </Providers>
  );
}

/**
 * A list that deals its rows when it scrolls into view. Pair with
 * `RevealItem`, which reads the moment from here and its delay from its index.
 * `amount` defaults lower than `Reveal`'s: a list stacked into one column on a
 * phone is taller than the viewport, and 30% of it would leave the first rows
 * blank on screen while the reader waits for the threshold.
 */
export function RevealList({ amount = 0.15, ...props }: BlockProps & { amount?: number }) {
  const { ref, state } = useReveal(amount);
  return (
    <Providers>
      <MotionBlock {...props} blockRef={ref} variants={ORCHESTRATOR} initial={false} animate={state} />
    </Providers>
  );
}

/**
 * One row of a `RevealList`. The stagger rungs are `STAGGER` from lib/motion
 * (tight for dense rows, base for cards, loose for a few large objects), with
 * `staggerDelay`'s cap, so a long list arrives rather than queues.
 * `offset` (ms) holds the whole list back behind something that lands first.
 */
export function RevealItem({
  index,
  rung = "base",
  offset = 0,
  ...props
}: BlockProps & { index: number; rung?: StaggerRung; offset?: number }) {
  return <MotionBlock {...props} variants={SELF} custom={staggerSeconds(index, rung, offset)} />;
}
