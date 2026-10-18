"use client";

/**
 * PROPOSAL (dev only): an Orbit agent as a flat 2D icon, for 48 px and under
 * (sidebar, lists, the agents tree, chips). The drawing is derived from the
 * 3D character (tools/crew/blender/orbit_flat.py): same silhouette, flat
 * colour with one soft tonal shade, crisp eyes, the eyes drawn per state.
 * Motion is CSS (orbit-motion.css); hover and press come from usePointerPose.
 *
 * SwiftUI twin (plan): the same generated paths as a Swift resource, drawn in
 * one Canvas (Path(svgPath:) parsed once and cached), the layers in the same
 * groups; state loops on a TimelineView paused under Reduce Motion and when
 * offscreen, hover via onContinuousHover, springs from JunoGeneratedSprings.
 */
import * as React from "react";
import { useFaceMotionSlot } from "@/components/agents/face-motion-slot";
import { ORBIT_ICONS } from "./orbit-icons.generated";

export type OrbitState = "ready" | "thinking" | "working" | "waiting" | "paused" | "finished" | "blocked";
export const ORBIT_STATES: { id: OrbitState; label: string }[] = [
  { id: "ready", label: "Ready" },
  { id: "thinking", label: "Thinking" },
  { id: "working", label: "Working" },
  { id: "waiting", label: "Needs your answer" },
  { id: "paused", label: "Paused" },
  { id: "finished", label: "Finished" },
  { id: "blocked", label: "Blocked" },
];
const LOOPING: ReadonlySet<OrbitState> = new Set(["ready", "thinking", "working", "paused"]);

/** Hover: the character looks toward the pointer and leans a little; press squishes. */
export function usePointerPose<T extends Element>(ref: React.RefObject<T | null>) {
  const [hover, setHover] = React.useState(false);
  const [press, setPress] = React.useState(false);
  const [g, setG] = React.useState<[number, number]>([0, 0]);
  React.useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const near = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = e.clientX - cx;
      const dy = e.clientY - cy;
      const reach = Math.max(160, r.width * 3);
      const d = Math.hypot(dx, dy);
      if (d > reach) return setG([0, 0]);
      const k = Math.min(1, d / Math.max(18, r.width * 0.5));
      setG([(dx / (d || 1)) * k, (dy / (d || 1)) * k]);
    };
    const enter = () => setHover(true);
    const leave = () => {
      setHover(false);
      setPress(false);
    };
    const down = () => setPress(true);
    const up = () => setPress(false);
    window.addEventListener("pointermove", near, { passive: true });
    el.addEventListener("pointerenter", enter);
    el.addEventListener("pointerleave", leave);
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", near);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
    };
  }, [ref]);
  return { hover, press, g };
}

export function OrbitIcon({ id, state = "ready", size, label, className }: { id: string; state?: OrbitState; size: number; label?: string; className?: string }) {
  const data = ORBIT_ICONS[size <= 28 ? "small" : "full"][id] ?? ORBIT_ICONS.full[id];
  const ref = React.useRef<SVGSVGElement | null>(null);
  const { hover, press, g } = usePointerPose(ref);
  const moving = useFaceMotionSlot(LOOPING.has(state), ref);
  if (!data) return null;
  const eyes = data.eyes[state] ?? data.eyes.ready ?? [];
  const before = data.base.slice(0, data.eyeAt);
  const after = data.base.slice(data.eyeAt);
  const path = ([f, d, r]: [string, string, string], i: number) => <path key={i} fill={f} fillRule="evenodd" d={d} data-role={r} />;
  return (
    <svg
      ref={ref}
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={["oi", className].filter(Boolean).join(" ")}
      data-state={state}
      data-hover={hover || undefined}
      data-press={press || undefined}
      data-still={LOOPING.has(state) && !moving ? "" : undefined}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ "--gx": g[0].toFixed(2), "--gy": g[1].toFixed(2), "--lean": (g[0] * 5).toFixed(2) } as React.CSSProperties}
    >
      <g className="oi-pose">
        <g className="oi-react" key={state}>
          <g className="oi-move">
            {before.map(path)}
            <g className="oi-lids">
              <g className="oi-gaze">
                {eyes.map(([f, d], i) => (
                  <path key={i} fill={f} fillRule="evenodd" d={d} />
                ))}
              </g>
            </g>
            {after.map((l, i) => path(l, i + before.length))}
          </g>
        </g>
      </g>
      {size >= 24 ? (
        <g className="oi-dots" aria-hidden="true">
          <circle cx={48} cy={10} r={2.1} fill="#1f3fd9" />
          <circle cx={48} cy={10} r={1.6} fill="#1f3fd9" opacity={0.8} />
          <circle cx={48} cy={10} r={1.2} fill="#1f3fd9" opacity={0.6} />
        </g>
      ) : null}
    </svg>
  );
}
