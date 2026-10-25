"use client";

import * as React from "react";
import Link from "next/link";
import type { ClientAgent } from "@/lib/agents/types";
import { useReducedMotion } from "@/lib/motion-preference";
import { AgentPresence } from "./agent-presence";

/*
 * Orbit's stage (2026-10): your agents, literally in orbit.
 *
 * Two tilted rings around a soft core (you), the agents riding them slowly,
 * the ones in front a little larger and brighter than the ones going round
 * the back, so the 3D faces (agent-face.tsx) sit in a scene with depth rather
 * than a row. A working agent keeps its own motion (it bobs, reads, thinks);
 * the ring only carries it.
 *
 * Calm by construction: one revolution takes two minutes, the scene stops
 * while the pointer is over it (so a face can be clicked where it is), when
 * the tab is hidden, and entirely under reduced motion, where the agents
 * stand evenly spaced on the rings. Positions are written to the elements in
 * a rAF loop, never through React state.
 *
 * The roster below the stage is the accessible list; the stage is a picture
 * of it with shortcuts, so its links are skipped by the keyboard and hidden
 * from assistive tech.
 */

const REVOLUTION_MS = 120_000;
const INNER_MAX = 5;

type Placed = { agent: ClientAgent; ring: 0 | 1; phase: number };

function place(agents: readonly ClientAgent[]): Placed[] {
  const inner = agents.slice(0, INNER_MAX);
  const outer = agents.slice(INNER_MAX);
  return [
    ...inner.map((agent, i) => ({ agent, ring: 0 as const, phase: (i / inner.length) * Math.PI * 2 + 0.6 })),
    ...outer.map((agent, i) => ({ agent, ring: 1 as const, phase: (i / outer.length) * Math.PI * 2 + 1.4 })),
  ];
}

export function OrbitStage({ agents, hrefOf }: { agents: readonly ClientAgent[]; hrefOf: (agent: ClientAgent) => string }) {
  const reduced = useReducedMotion();
  const stageRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<(HTMLAnchorElement | null)[]>([]);
  const paused = React.useRef(false);
  const placed = React.useMemo(() => place(agents), [agents]);
  const twoRings = placed.some((p) => p.ring === 1);

  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let raf = 0;
    let offset = 0;
    let last = performance.now();
    const draw = () => {
      const w = stage.clientWidth;
      const h = stage.clientHeight;
      const cx = w / 2;
      const cy = h / 2;
      placed.forEach((p, i) => {
        const el = itemRefs.current[i];
        if (!el) return;
        const rx = (p.ring === 0 ? (twoRings ? 0.27 : 0.34) : 0.44) * w;
        const ry = (p.ring === 0 ? (twoRings ? 0.24 : 0.3) : 0.38) * h;
        // The outer ring turns the other way, a little slower.
        const a = p.phase + (p.ring === 0 ? offset : -offset * 0.7);
        const x = cx + rx * Math.cos(a);
        const y = cy + ry * Math.sin(a);
        const depth = (Math.sin(a) + 1) / 2; // 0 at the back, 1 in front
        const scale = 0.72 + depth * 0.32;
        el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${scale.toFixed(3)})`;
        el.style.zIndex = String(Math.round(depth * 100));
        el.style.opacity = String((0.62 + depth * 0.38).toFixed(3));
      });
    };
    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      if (!paused.current && !document.hidden) offset += (dt / REVOLUTION_MS) * Math.PI * 2;
      draw();
      raf = requestAnimationFrame(tick);
    };
    draw();
    if (!reduced) raf = requestAnimationFrame(tick);
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
    };
  }, [placed, reduced, twoRings]);

  return (
    <div
      ref={stageRef}
      aria-hidden="true"
      className="orbit-stage relative isolate h-[19rem] w-full select-none @[40rem]/page:h-[22rem]"
      onPointerEnter={() => {
        paused.current = true;
      }}
      onPointerLeave={() => {
        paused.current = false;
      }}
    >
      <svg className="pointer-events-none absolute inset-0 size-full" preserveAspectRatio="none" viewBox="0 0 100 100" aria-hidden>
        <ellipse className="orbit-ring" cx="50" cy="50" rx={twoRings ? 27 : 34} ry={twoRings ? 24 : 30} />
        {twoRings ? <ellipse className="orbit-ring orbit-ring--outer" cx="50" cy="50" rx="44" ry="38" /> : null}
      </svg>
      <span className="orbit-core" />
      {placed.map((p, i) => (
        <Link
          key={p.agent.id}
          ref={(el) => {
            itemRefs.current[i] = el;
          }}
          href={hrefOf(p.agent)}
          prefetch={false}
          tabIndex={-1}
          className="orbit-body group/orb absolute left-0 top-0 flex flex-col items-center will-change-transform"
          style={{ transition: reduced ? undefined : "opacity 300ms" }}
        >
          <span className="transition-transform duration-base ease-out-soft group-hover/orb:-translate-y-1 group-hover/orb:scale-[1.06] motion-reduce:transition-none">
            <AgentPresence
              avatar={p.agent.avatar}
              state={p.agent.status === "paused" ? "sleeping" : p.agent.state}
              size={84}
              spread={0.25}
              gaze
            />
          </span>
          <span className="orbit-name mt-1.5 rounded-full px-2.5 py-0.5 text-ui font-medium text-foreground">{p.agent.name}</span>
        </Link>
      ))}
    </div>
  );
}
