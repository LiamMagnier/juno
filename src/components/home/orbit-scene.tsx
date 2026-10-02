"use client";

import * as React from "react";
import { LazyMotion, domAnimation, m, useReducedMotion, useScroll, useTransform, type MotionValue } from "framer-motion";
import { User } from "@/components/ui/icons";

/**
 * Orbit: you at the centre, your agents on their own orbits around you. As
 * the section passes, each agent travels the last stretch of its orbit and
 * settles where it reports. Position follows the reader's scroll and stops;
 * nothing circles on its own. Each agent says its state in words.
 */

/** Characters are cut from the owner's sheet by scripts/brand/extract-orbit-agents.mjs. */
type Agent = { name: string; sprite: string; line: string; attention?: boolean; orbit: number; angle: number };

const AGENTS: Agent[] = [
  { name: "Mira", sprite: "quill", line: "Comparing competitor pricing", orbit: 1, angle: 200 },
  { name: "Otto", sprite: "macaron", line: "Finished the weekly summary", orbit: 2, angle: 335 },
  { name: "Scout", sprite: "bell", line: "Needs your answer before sending", attention: true, orbit: 0, angle: 62 },
  { name: "Pip", sprite: "sprout", line: "Drafting next week's plan", orbit: 2, angle: 148 },
];

/** Orbit radii as fractions of the map box (rx of width, ry of height). */
const ORBITS = [
  { rx: 0.2, ry: 0.27 },
  { rx: 0.33, ry: 0.4 },
  { rx: 0.46, ry: 0.5 },
];
const TRAVEL = 46;

function point(orbit: number, deg: number) {
  const o = ORBITS[orbit];
  const t = (deg * Math.PI) / 180;
  return { x: 50 + o.rx * 100 * Math.cos(t), y: 50 + o.ry * 100 * Math.sin(t) };
}

function Placed({ agent, progress, still }: { agent: Agent; progress: MotionValue<number>; still: boolean }) {
  const deg = useTransform(progress, (v) => agent.angle - TRAVEL * (1 - Math.min(1, Math.max(0, v))));
  const x = useTransform(deg, (d) => `${point(agent.orbit, d).x}%`);
  const y = useTransform(deg, (d) => `${point(agent.orbit, d).y}%`);
  const rest = point(agent.orbit, agent.angle);
  return (
    <m.div className="absolute inset-0" style={still ? { x: `${rest.x}%`, y: `${rest.y}%` } : { x, y }}>
      <div className="alv-agent" style={{ left: 0, top: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- static transparent sprite */}
        <img className="alv-agent-sprite" src={`/brand/agents/${agent.sprite}.webp`} alt="" width={132} height={132} loading="lazy" decoding="async" />
        <span className="alv-agent-name">{agent.name}</span>
        <span className="alv-agent-state" data-attention={agent.attention || undefined}>{agent.line}</span>
      </div>
    </m.div>
  );
}

export function OrbitScene() {
  const ref = React.useRef<HTMLDivElement>(null);
  // The server cannot know the reader's motion setting; branch only after mount
  // so the first client render matches the HTML.
  const prefersReduced = useReducedMotion();
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  const reduce = mounted && !!prefersReduced;
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "center center"] });
  const draw = useTransform(scrollYProgress, (v) => Math.min(1, Math.max(0, v * 1.25)));
  return (
    <LazyMotion features={domAnimation}>
      <div ref={ref} className="alv-orbit-map" aria-hidden>
        <svg viewBox="0 0 1600 900" preserveAspectRatio="none">
          {ORBITS.map((o, i) => (
            <m.ellipse key={i} cx={800} cy={450} rx={o.rx * 1600} ry={o.ry * 900} className={i === 2 ? "alv-orbit alv-orbit-faint" : "alv-orbit"} style={reduce ? undefined : { pathLength: draw }} />
          ))}
        </svg>
        <div className="alv-orbit-you">
          <span className="alv-you-disc" role="img" aria-label="You"><User aria-hidden className="size-7" /></span>
        </div>
        {AGENTS.map((a) => <Placed key={a.name} agent={a} progress={draw} still={reduce} />)}
      </div>
    </LazyMotion>
  );
}
