"use client";

import * as React from "react";
import { LazyMotion, domAnimation, m, useMotionValueEvent, useReducedMotion, useScroll, useTransform, useInView } from "framer-motion";
import { RotateCcw } from "@/components/ui/icons";
import { PublicAction } from "@/components/public/public-motion";
import { Construction } from "./construction";
import { ProductWindow } from "./product-window";

/**
 * The hero is one continuous move. At rest: the promise, the construction
 * behind it, and the top of the product window waiting below. As the reader
 * scrolls, the orbits expand outward (the set keeps growing) while the window
 * rises into the frame and starts its example. The section is sticky, never
 * scroll-jacked: the page keeps its native scroll the whole way.
 *
 * Phones and reduced motion get the static stack: copy, drawing, window.
 */

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function useWide() {
  const [wide, setWide] = React.useState(false);
  React.useEffect(() => {
    const q = window.matchMedia("(min-width: 861px)");
    const on = () => setWide(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, []);
  return wide;
}

export function Hero() {
  const ref = React.useRef<HTMLElement>(null);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const wide = useWide();
  const pinned = wide && !reduce;
  const [play, setPlay] = React.useState(false);
  const replayRef = React.useRef<(() => void) | null>(null);

  const { scrollYProgress: p } = useScroll({ target: ref, offset: ["start start", "end end"] });
  // Function transforms on purpose: framer hands plain opacity ranges to a
  // compositor scroll timeline measured against the whole document.
  const copyOpacity = useTransform(p, (v) => 1 - clamp01(v / 0.22));
  const copyY = useTransform(p, [0, 0.3], [0, -96]);
  const orbitScale = useTransform(p, [0, 0.75], [1, 2.3]);
  const orbitOpacity = useTransform(p, (v) => (v < 0.2 ? 1 - v / 2 : 0.9 - 0.55 * clamp01((v - 0.2) / 0.55)));
  const stageY = useTransform(p, [0, 0.5], ["72vh", "12vh"]);
  const stageScale = useTransform(p, [0, 0.5], [0.9, 1]);

  useMotionValueEvent(p, "change", (v) => {
    if (pinned && v > 0.38) setPlay(true);
  });
  const stageInView = useInView(stageRef, { once: true, amount: 0.4 });
  React.useEffect(() => {
    if (!pinned && stageInView) setPlay(true);
  }, [pinned, stageInView]);

  return (
    <LazyMotion features={domAnimation}>
      <section ref={ref} className="alv-hero" aria-labelledby="alv-hero-title">
        <div className="alv-hero-pin">
          <m.div className="alv-hero-construction" style={pinned ? { scale: orbitScale, opacity: orbitOpacity } : undefined}>
            <Construction />
          </m.div>
          <div className="alv-hero-veil" />
          <m.div className="alv-hero-copy" style={pinned ? { opacity: copyOpacity, y: copyY } : undefined}>
            <h1 id="alv-hero-title" className="alv-display alv-enter" style={{ ["--i" as string]: 0 }}>Go further.</h1>
            <p className="alv-lede alv-enter" style={{ ["--i" as string]: 1 }}>Alevr is the AI workspace for chat, agents and code. Research deeply, hand off the routine, and finish real work.</p>
            <div className="alv-actions alv-enter" style={{ ["--i" as string]: 2 }}>
              <PublicAction href="/sign-up">Create account</PublicAction>
              <PublicAction href="/download" secondary>Download for Mac</PublicAction>
            </div>
          </m.div>
          <m.div className="alv-hero-stage" style={pinned ? { y: stageY } : undefined}>
            <m.div ref={stageRef} style={pinned ? { scale: stageScale } : undefined}>
              <ProductWindow play={play} onReplayRef={replayRef} />
              <div className="alv-stage-foot">
                <span className="alv-caption">An example conversation, shown in the Alevr layout.</span>
                <button type="button" className="alv-ghost-btn" onClick={() => { setPlay(true); replayRef.current?.(); }}>
                  <RotateCcw className="size-3.5" aria-hidden />Replay
                </button>
              </div>
            </m.div>
          </m.div>
        </div>
      </section>
    </LazyMotion>
  );
}
