"use client";

import type * as React from "react";
import { LazyMotion, MotionConfig, domAnimation, m, type Variants } from "framer-motion";

import { STAGGER, transition, type StaggerRung } from "@/lib/motion";
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
 * is actually read, and framer's `whileInView` is that observer with the token
 * curves attached. The children stay server-rendered; this file only wraps them.
 *
 * WHY `m` + `LazyMotion`. The landing loads none of the app's chunks, so this
 * island pays for framer on its own. `m` with the `domAnimation` feature set is
 * the smallest build that still carries `whileInView`.
 *
 * REDUCED MOTION. `MotionConfig reducedMotion="user"` drops the travel and keeps
 * the fade on its timing (docs/design/ICONS_AND_MOTION.md §2.2.10), without the
 * server/client style mismatch a `useReducedMotion()` branch would cause on
 * hydration.
 *
 * NO SCRIPT, PRINT. The hidden state is an inline style from the server, so a
 * visitor without JavaScript, or a printout of a section never scrolled to,
 * would get blank space. `FALLBACK` forces the rest state in both cases.
 */

/**
 * How far a block travels as it arrives: 14px, against the in-app `rise` of
 * 6px. A reveal on the landing crosses the reader's own scroll rather than a
 * static panel, and at 6px it reads as a flicker in the scroll; past 16px it
 * reads as sliding. Paired with `transition.slow` (360ms on ease-out-expo),
 * the long-travel rung.
 */
const LANDING_RISE = 14;

/** How many items still stagger before the delay stops growing (~8). */
const STAGGER_CAP = 7;

const FALLBACK =
  "print:!transform-none print:!opacity-100 [@media(scripting:none)]:!transform-none [@media(scripting:none)]:!opacity-100";

const SELF: Variants = {
  hidden: { opacity: 0, y: LANDING_RISE },
  visible: (delay: number = 0) => ({ opacity: 1, y: 0, transition: { ...transition.slow, delay } }),
};

/** The parent only orchestrates: its children carry the motion. */
const ORCHESTRATOR: Variants = { hidden: {}, visible: {} };

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
  ...motionProps
}: BlockProps & {
  variants: Variants;
  custom?: number;
  initial?: string;
  whileInView?: string;
  viewport?: { once: boolean; amount: number };
}) {
  const props = { ...motionProps, className: cn(FALLBACK, className) };
  switch (as) {
    case "ul":
      return <m.ul {...props}>{children}</m.ul>;
    case "dl":
      return <m.dl {...props}>{children}</m.dl>;
    case "li":
      return <m.li {...props}>{children}</m.li>;
    default:
      return <m.div {...props}>{children}</m.div>;
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
  return (
    <Providers>
      <MotionBlock
        {...props}
        variants={SELF}
        custom={delay}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount }}
      />
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
  return (
    <Providers>
      <MotionBlock
        {...props}
        variants={ORCHESTRATOR}
        initial="hidden"
        whileInView="visible"
        viewport={{ once: true, amount }}
      />
    </Providers>
  );
}

/**
 * One row of a `RevealList`. The stagger rungs are `STAGGER` from lib/motion
 * (tight for dense rows, base for cards, loose for a few large objects),
 * capped at the eighth row so a long list arrives rather than queues.
 * `offset` (ms) holds the whole list back behind something that lands first.
 */
export function RevealItem({
  index,
  rung = "base",
  offset = 0,
  ...props
}: BlockProps & { index: number; rung?: StaggerRung; offset?: number }) {
  const delay = (offset + Math.min(index, STAGGER_CAP) * STAGGER[rung]) / 1000;
  return <MotionBlock {...props} variants={SELF} custom={delay} />;
}
