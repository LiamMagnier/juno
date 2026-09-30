"use client";

import * as React from "react";
import { PRESENCE_LABEL, type CrewMember, type Presence } from "./fixtures";

/*
 * A crew member's face: identity and presence in one flat drawing.
 *
 * Canvas draws it FLAT: one tone, two eyes, no light, no gradient, no ground
 * shadow. The eyes carry the state (the shape stays readable in a still and
 * under reduced motion): open and level when available, glancing up while
 * thinking, lowered and narrowed while working, wide and level when it is
 * waiting for you, closed when paused, closed and grey when offline.
 *
 * Motion only happens on EVENTS, never as an idle loop:
 *  - arrival: one blink ~0.7s after mount and one more at ~3.4s, then still;
 *  - a change of state: one blink plus the state's own gesture (thinking
 *    glances once, working settles with a small dip, waiting lifts twice to
 *    ask for attention), then still;
 *  - hover on the row that holds it: one blink.
 * Reduced motion keeps the eye shapes and drops every gesture (canvas.css).
 */

const BODY: Record<CrewMember["shape"], React.ReactNode> = {
  round: <circle cx={16} cy={16} r={15} />,
  soft: <rect x={1.5} y={1.5} width={29} height={29} rx={10} />,
  pebble: <path d="M16 1.8c8.1 0 14.2 5.9 14.2 13.9 0 8.2-6.2 14.5-14.2 14.5S1.8 23.9 1.8 15.7C1.8 7.7 7.9 1.8 16 1.8Z" />,
};

export function Face({
  member,
  presence,
  size = 18,
  still = false,
  label = false,
  className,
}: {
  member: Pick<CrewMember, "name" | "shape" | "tone">;
  presence: Presence;
  size?: number;
  /** A picture of the face (tokens, marks): no gestures at all. */
  still?: boolean;
  /** Give the face an accessible name (name and state). Omit when the name is printed beside it. */
  label?: boolean;
  className?: string;
}) {
  const ref = React.useRef<SVGSVGElement | null>(null);
  const prev = React.useRef<Presence | null>(null);

  const play = React.useCallback((anim: string) => {
    const el = ref.current;
    if (!el) return;
    el.removeAttribute("data-anim");
    void el.getBoundingClientRect();
    el.setAttribute("data-anim", anim);
  }, []);

  // Arrival and state changes.
  React.useEffect(() => {
    if (still) return;
    const timers: number[] = [];
    const first = prev.current === null;
    const changed = !first && prev.current !== presence;
    prev.current = presence;
    const closed = presence === "paused" || presence === "offline";
    if (first) {
      if (!closed) timers.push(window.setTimeout(() => play("blink"), 700));
      if (presence === "waiting") timers.push(window.setTimeout(() => play("attend"), 1300));
      if (!closed) timers.push(window.setTimeout(() => play("blink"), 3400));
    } else if (changed) {
      const gesture = presence === "waiting" ? "attend" : presence === "working" ? "settle" : presence === "thinking" ? "glance" : "blink";
      play(gesture);
    }
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [presence, still, play]);

  // Hover on the row that holds the face: one blink.
  React.useEffect(() => {
    if (still) return;
    const host = ref.current?.closest("a,button,[data-face-host]");
    if (!host) return;
    const onEnter = () => {
      if (presence !== "paused" && presence !== "offline") play("blink");
    };
    host.addEventListener("pointerenter", onEnter);
    return () => host.removeEventListener("pointerenter", onEnter);
  }, [still, presence, play]);

  const a11y = label
    ? { role: "img" as const, "aria-label": `${member.name}, ${PRESENCE_LABEL[presence].toLowerCase()}` }
    : { "aria-hidden": true as const };

  return (
    <svg
      ref={ref}
      viewBox="0 0 32 32"
      width={size}
      height={size}
      focusable="false"
      data-presence={presence}
      data-tone={member.tone}
      data-still={still ? "" : undefined}
      className={className ? `cv-face ${className}` : "cv-face"}
      {...a11y}
    >
      <g className="cv-face__all">
        <g className="cv-face__body">{BODY[member.shape]}</g>
        <g className="cv-face__eyes">
          <g className="cv-face__lids">
            <rect x={10.3} y={12.9} width={3.4} height={5.4} rx={1.7} />
            <rect x={18.3} y={12.9} width={3.4} height={5.4} rx={1.7} />
          </g>
        </g>
      </g>
    </svg>
  );
}
