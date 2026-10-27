"use client";

/**
 * An agent's face: its identity and its status bar in one drawing
 * (docs/design/AGENTS.md §4).
 *
 * One flat mass in the agent's tone, two ink cuts for eyes, nothing bolted
 * on: no outline, gradient, gloss, glow or shadow. The volume is in the
 * motion: the eyes ride a sphere, so they foreshorten as the head turns and
 * slide behind the limb when it goes round. The state language is drawn with
 * Juno's own marks: while it works, the open ring with its ball terminal
 * orbits the body in the presence colour; when it is done the ring closes and
 * lets go; blocked, the ring stalls with its ball at the bottom; it thinks as
 * three flat dots; it asks for you with a ball in a notch at its shoulder.
 *
 *  - face-geometry.ts  the bodies, eyes and orbit, and `drawFace(pose)`
 *  - face-rig.ts       the states as poses over time, and the one clock
 *  - agent-face.css    paint (tokens only) and the reduced-motion cross-fade
 *
 * The server renders the state's still pose, which is also what reduced
 * motion shows, so every state reads from a still frame. On the client the rig
 * takes the element over and writes attribute diffs; React keeps the first
 * frame as its props and never repaints over the rig.
 */

import * as React from "react";
import type { AgentAvatar } from "@/lib/agents/avatar";
import { AGENT_STATE_LABEL, type AgentState } from "@/lib/agents/domain";
import { reducedMotionAt } from "@/lib/motion-preference";
import { cn } from "@/lib/utils";
import { NO_EXTRAS, drawFace, sizeClass, type FaceFrame, type FaceSpec } from "./face-geometry";
import { attachFaceRig, faceCtx, faceIdentity, frontPose, stillPose, type FaceConfig, type FaceRigHandle } from "./face-rig";

export type AgentFaceSize = "xs" | "sm" | "md" | "lg" | "xl";

const PX: Record<AgentFaceSize, number> = { xs: 20, sm: 28, md: 48, lg: 96, xl: 160 };

export interface AgentFaceProps {
  avatar: AgentAvatar;
  state?: AgentState;
  size?: AgentFaceSize | number;
  /** The agent's name, for the accessible label. Omit when the name is printed beside the face. */
  name?: string;
  /**
   * The state the label names, when it is not the one drawn. The hire arrival
   * draws `done` then `idle` as a greeting (AGENTS.md §5.1); a screen reader is
   * told the agent's real state, not the choreography.
   */
  labelState?: AgentState;
  /**
   * Rest life (face-rig.ts): it blinks, it glances around now and then, and
   * blinks when you hover the control it belongs to; between those it is still. Off for faces that are
   * pictures of a choice (pickers, swatches), where twenty blinking faces would
   * be noise. State motion plays either way.
   */
  live?: boolean;
  /** With `live`: the face looks toward the pointer while it is near. */
  look?: boolean;
  /**
   * The state's still frame and nothing else, as under reduced motion: no
   * clock, no pointer. For a second copy of a face that is alive elsewhere on
   * the page (the Orbit roster under the stage), so only one copy moves. A
   * face that has been live keeps its element and its rig when it turns
   * still: the rig holds it (it eases into the still frame from where it is,
   * a blink under way finishing first), and lets it go again, never a swap of
   * element and never a cut.
   */
  still?: boolean;
  /**
   * With `still`: draw the face turned nearly to the viewer (frontPose), so
   * the two eyes are near the same size and the cuts compare, yet still on a
   * sphere and leaning the agent's way, never two upright bars (⏸). For
   * pickers that compare eye cuts.
   */
  pose?: "front";
  /**
   * A preview a person drives (the studio, the hire flow's state buttons):
   * each change plays at once, without the smoothing meant for agent loops.
   */
  direct?: boolean;
  className?: string;
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/** Attribute bags from drawFace use SVG's names; React wants a few in camelCase. */
const REACT_NAME: Record<string, string> = { "stroke-width": "strokeWidth", "clip-path": "clipPath" };
function props(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key in attrs) out[REACT_NAME[key] ?? key] = attrs[key];
  return out;
}

/**
 * The still pose for a state, turned nearly to the viewer when asked
 * (frontPose: the cuts compare, and still lean). Drawn with the agent's
 * identity, as the live rig is, so the server's frame, a still copy and the
 * live face rest the same way round.
 */
function stillFor(config: FaceConfig, state: AgentState, pose?: "front") {
  const P = stillPose(state, faceCtx(config.spec, config.mark, 0, false, config.identity));
  return pose === "front" ? frontPose(P) : P;
}

export function AgentFace({ avatar, state = "idle", size = "md", name, labelState, live = false, look = false, still = false, pose, direct = false, className }: AgentFaceProps) {
  const px = typeof size === "number" ? size : PX[size];
  const label = name ? `${name}, ${AGENT_STATE_LABEL[labelState ?? state].toLowerCase()}` : undefined;
  const uid = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const ids = React.useMemo(() => ({ mask: `agent-face-${uid}-k`, clip: `agent-face-${uid}-c`, body: `agent-face-${uid}-b` }), [uid]);
  const sizeKey = sizeClass(px).key;
  const config = React.useMemo<FaceConfig>(() => {
    const spec: FaceSpec = { shape: avatar.shape, eyes: avatar.eyes, size: sizeClass(px), px };
    const identity = faceIdentity({ shape: avatar.shape, tone: avatar.tone, eyes: avatar.eyes, mark: avatar.mark });
    return { spec, mark: avatar.mark, identity, live, look: live && look, direct, still };
    // sizeKey stands for sizeClass(px), which is a fresh object each call.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatar.shape, avatar.tone, avatar.eyes, avatar.mark, px, sizeKey, live, look, direct, still]);

  // A face the rig moves: once it has been live (at mount, or later), its
  // element carries a rig for the rest of its life, and turning still only
  // holds it (FaceConfig.still). Its first frame, drawn once from the state it
  // had then, is the server's picture and the props React compares against,
  // so React never writes over the rig; `state` is the state that frame draws
  // (the paint keys off the state as drawn, data-drawn, which the rig moves on
  // when its pose does).
  const [rigFrom, setRigFrom] = React.useState<{ frame: FaceFrame; state: AgentState } | null>(() =>
    still ? null : { frame: drawFace(config.spec, stillFor(config, state), NO_EXTRAS, ids), state },
  );
  if (!still && !rigFrom) setRigFrom({ frame: drawFace(config.spec, stillFor(config, state), NO_EXTRAS, ids), state });
  const rigged = rigFrom !== null;
  // A face never live is drawn by React from its props, every render.
  const stillFrame = React.useMemo(
    () => (rigged ? null : drawFace(config.spec, stillFor(config, state, pose), NO_EXTRAS, ids)),
    [rigged, config, state, ids, pose],
  );
  const ref = React.useRef<SVGSVGElement | null>(null);
  const rig = React.useRef<FaceRigHandle | null>(null);
  const attached = React.useRef<FaceConfig | null>(null);
  const stateRef = React.useRef(state);
  stateRef.current = state;

  useIsomorphicLayoutEffect(() => {
    const el = ref.current;
    if (!el || !rigged) return;
    const handle = attachFaceRig(el, config, stateRef.current, ids);
    rig.current = handle;
    attached.current = config;
    return () => {
      handle.release();
      rig.current = null;
    };
    // Attached once per element (the svg is keyed on `rigged`); state and config (still among it) reach it below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rigged]);

  // A face never live swaps frames with the reduced-motion cross-fade; with
  // motion allowed its paint transitions carry the swap, so a roster copy
  // never dips. (A rigged face held still crosses over on the rig.)
  const shownState = React.useRef(state);
  useIsomorphicLayoutEffect(() => {
    if (shownState.current === state) return;
    shownState.current = state;
    rig.current?.setState(state);
    const el = ref.current;
    if (!rigged && el && reducedMotionAt(el)) {
      el.removeAttribute("data-swap");
      void el.getBoundingClientRect();
      el.setAttribute("data-swap", "");
    }
  }, [state, rigged]);

  useIsomorphicLayoutEffect(() => {
    if (attached.current === config) return;
    attached.current = config;
    rig.current?.configure(config);
  }, [config]);

  const f: FaceFrame = rigFrom ? rigFrom.frame : (stillFrame as FaceFrame);
  return (
    <svg
      key={rigged ? "live" : "still"}
      ref={ref}
      viewBox="-32 -32 64 64"
      width={px}
      height={px}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-state={state}
      data-drawn={rigFrom ? rigFrom.state : state}
      className={cn("agent-face shrink-0", className)}
      style={{ "--face-tone": `var(--agent-${avatar.tone})` } as React.CSSProperties}
    >
      <defs>
        <clipPath id={ids.clip} clipPathUnits="userSpaceOnUse">
          <use href={`#${ids.body}`} />
        </clipPath>
        {/* The cut-paper knockouts: where the orbit's front half and its ball
            pass in front, and the needs-you notch. Real holes, so the page or
            the card shows through. */}
        <mask id={ids.mask} maskUnits="userSpaceOnUse" x={-2} y={-2} width={4} height={4}>
          <rect x={-2} y={-2} width={4} height={4} fill="#fff" />
          <path data-part="kRing" fill="none" stroke="#000" strokeLinecap="round" {...props(f.kRing)} />
          <circle data-part="kBall" fill="#000" {...props(f.kBall)} />
          <g data-part="kBodyT" {...props(f.kBodyT)}>
            <rect data-part="kBadge" fill="#000" {...props(f.kBadge)} />
          </g>
        </mask>
      </defs>
      <g data-part="g" {...props(f.g)}>
        <path data-part="rBack" className="agent-face__ring" {...props(f.rBack)} />
        <circle data-part="bBack" className="agent-face__ball" {...props(f.bBack)} />
        <g data-part="masked" {...props(f.masked)}>
          <circle data-part="d0" className="agent-face__body" {...props(f.d0)} />
          <circle data-part="d1" className="agent-face__body" {...props(f.d1)} />
          <g data-part="bodyT" {...props(f.bodyT)}>
            <path data-part="body" className="agent-face__body" {...props(f.body)} />
            <g data-part="eyes" {...props(f.eyes)}>
              <path data-part="e0" className="agent-face__eye" {...props(f.e0)} />
              <path data-part="e1" className="agent-face__eye" {...props(f.e1)} />
            </g>
          </g>
        </g>
        <path data-part="rFront" className="agent-face__ring" {...props(f.rFront)} />
        <circle data-part="bFront" className="agent-face__ball" {...props(f.bFront)} />
        <g data-part="badgeT" className="agent-face__badge" {...props(f.badgeT)}>
          <circle data-part="badgeBall" {...props(f.badgeBall)} />
          <rect data-part="badgeBar" {...props(f.badgeBar)} />
        </g>
      </g>
    </svg>
  );
}
