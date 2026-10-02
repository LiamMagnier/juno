"use client";

import * as React from "react";
import { LazyMotion, MotionConfig, domAnimation, m, useReducedMotion, useScroll, useSpring, useTransform } from "framer-motion";
import Link from "next/link";
import { ArrowRight } from "@/components/ui/icons";
import { cn } from "@/lib/utils";

const SPRING = { stiffness: 180, damping: 24, mass: 0.5 };

/** A stable hit target with a small response inside it. Pointer motion never
 * updates React state, and keyboard/touch/reduced-motion users get a fixed control. */
export function PublicAction({ href, children, secondary = false }: { href: string; children: React.ReactNode; secondary?: boolean }) {
  const reduce = useReducedMotion();
  const x = useSpring(0, SPRING);
  const y = useSpring(0, SPRING);
  const reset = () => { x.set(0); y.set(0); };
  const move = (event: React.PointerEvent<HTMLAnchorElement>) => {
    if (reduce || event.pointerType !== "mouse" || !window.matchMedia("(hover:hover) and (pointer:fine)").matches) return;
    const box = event.currentTarget.getBoundingClientRect();
    x.set((event.clientX - box.left - box.width / 2) * 0.045);
    y.set((event.clientY - box.top - box.height / 2) * 0.08);
  };
  return (
    <LazyMotion features={domAnimation}><MotionConfig reducedMotion="user">
      <Link href={href} className={cn("alevr-public-action", secondary && "alevr-public-action-secondary")} onPointerMove={move} onPointerLeave={reset} onBlur={reset}>
        <m.span style={{ x: reduce ? 0 : x, y: reduce ? 0 : y }}>{children}{!secondary && <ArrowRight aria-hidden className="size-4" />}</m.span>
      </Link>
    </MotionConfig></LazyMotion>
  );
}

/** The material moves a few pixels as its section passes, emphasizing depth.
 * Scroll values stay outside React; the frame reserves its geometry in HTML. */
export function PublicMedia({ children, className }: { children: React.ReactNode; className?: string }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] });
  const travel = useTransform(scrollYProgress, [0, 1], [18, -18]);
  const y = useSpring(travel, { stiffness: 80, damping: 28 });
  return <LazyMotion features={domAnimation}><MotionConfig reducedMotion="user"><div ref={ref} className={cn("alevr-public-media", className)}><m.div className="alevr-public-media-inner" style={{ y: reduce ? 0 : y }}>{children}</m.div></div></MotionConfig></LazyMotion>;
}
