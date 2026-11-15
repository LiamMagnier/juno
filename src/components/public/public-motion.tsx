"use client";

import * as React from "react";
import { LazyMotion, MotionConfig, domAnimation, m, useScroll, useSpring, useTransform } from "framer-motion";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "@/lib/motion-preference";


/** The public pages' call to action: a plain link in the button's shape. It
 * used to lean toward the pointer (a magnetic hover) and trail an arrow, two
 * portfolio-site gestures; a product's main button stays put and says what it
 * does, as every button in the app does. */
export function PublicAction({ href, children, secondary = false }: { href: string; children: React.ReactNode; secondary?: boolean }) {
  return (
    <Link href={href} className={cn("alevr-public-action", secondary && "alevr-public-action-secondary")}>
      {children}
    </Link>
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
