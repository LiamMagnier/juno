"use client";

/**
 * PROPOSAL (dev only): an Orbit agent as its 3D portrait (Blender, Cycles).
 *
 * Characters with a rendered motion set (tools/crew/blender/orbit_motion.py)
 * play their state as a short image sequence at 12 fps, looping states loop,
 * the one-shot states (needs your answer, finished, blocked) hold their last
 * frame; on hover the eyes come from a 3x3 gaze grid toward the pointer. The
 * others borrow the CSS state behaviour on their still portrait. Hover lean and
 * scale, press squish and the change-of-state reaction are CSS springs on top.
 * Zero work at rest beyond one image; frames are preloaded per state.
 */
import * as React from "react";
import { useFaceMotionSlot } from "@/components/agents/face-motion-slot";
import { usePointerPose, type OrbitState } from "./orbit-icon";

const FRAMES: Record<OrbitState, { n: number; loop: boolean }> = {
  ready: { n: 20, loop: true },
  thinking: { n: 24, loop: true },
  working: { n: 16, loop: true },
  waiting: { n: 16, loop: false },
  paused: { n: 24, loop: true },
  finished: { n: 16, loop: false },
  blocked: { n: 12, loop: false },
};
const FPS = 12;
const STATE_FILE: Record<OrbitState, string> = { ready: "ready", thinking: "thinking", working: "working", waiting: "waiting", paused: "paused", finished: "finished", blocked: "blocked" };

function prefersReduced() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

export function OrbitPortrait({ id, state, size, base, sequenced, reducedMotion }: { id: string; state: OrbitState; size: number; base: string; sequenced: boolean; reducedMotion?: boolean }) {
  const ref = React.useRef<HTMLDivElement | null>(null);
  const { hover, press, g } = usePointerPose(ref);
  const moving = useFaceMotionSlot(true, ref);
  const [frame, setFrame] = React.useState(0);
  const reduced = reducedMotion || prefersReduced();
  const spec = FRAMES[state];

  React.useEffect(() => {
    if (!sequenced) return;
    for (let i = 0; i < spec.n; i++) {
      const im = new Image();
      im.src = `${base}/motion/${id}_${STATE_FILE[state]}_${String(i).padStart(2, "0")}.png`;
    }
    setFrame(0);
    if (reduced || !moving) return;
    let i = 0;
    let last = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      if (t - last >= 1000 / FPS) {
        last = t;
        i = spec.loop ? (i + 1) % spec.n : Math.min(spec.n - 1, i + 1);
        setFrame(i);
        if (!spec.loop && i === spec.n - 1) return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [base, id, state, sequenced, reduced, moving, spec.n, spec.loop]);

  const gx = Math.round(g[0] * 1.4);
  const gy = Math.round(g[1] * 1.4);
  const useGaze = sequenced && hover && state === "ready";
  const src = !sequenced
    ? `${base}/${id}.png`
    : useGaze
      ? `${base}/motion/${id}_gaze_${Math.max(0, Math.min(2, gx + 1))}${Math.max(0, Math.min(2, gy + 1))}.png`
      : `${base}/motion/${id}_${STATE_FILE[state]}_${String(reduced ? (spec.loop ? 0 : spec.n - 1) : frame).padStart(2, "0")}.png`;
  return (
    <div
      ref={ref}
      className="op"
      data-state={state}
      data-seq={sequenced || undefined}
      data-hover={hover || undefined}
      data-press={press || undefined}
      data-still={!moving || undefined}
      style={{ width: size, height: size, "--lean": (g[0] * 4).toFixed(2) } as React.CSSProperties}
    >
      <div className="oi-pose">
        <div className="oi-react" key={state}>
          <div className="oi-move">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={src} alt="" draggable={false} />
          </div>
        </div>
      </div>
    </div>
  );
}
