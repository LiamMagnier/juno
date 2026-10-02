"use client";

import * as React from "react";
import { CrewFace, type CrewMember, type CrewState, type LiveHandle } from "../crew";
import "../crew/crew-ui.css";
import { useClock, useLevel, useSampled, useTick } from "./clock";

/*
 * The agent, in a voice conversation in its own thread (Orbit). The character
 * is the voice presence; the composer's channel is the control. Built on the
 * crew designers' CrewFace and their peek's classes (jcp, crew-ui.css), read
 * only: the voice layer adds three behaviours from real signals and nothing
 * that idles on its own.
 *
 *   listening   attention: it turns to face you and leans down toward the
 *               conversation (220 ms, eased, from the clock), then holds still;
 *               when one of your phrases ends it blinks once (heard you)
 *   thinking    the rig's thinking pose and look-around (the crew state)
 *   answering   it talks: the rig's bob driven by its own output level
 *
 * The words under the ledge stay one constant phrase for the whole call, so
 * the state never flips a visible label (the owner's voice rule); the state
 * itself is in the composer's live region, by the agent's name.
 * Reduced motion: the rig drops movement; no turn, no blink, no bob.
 */

export type PeekPhase = "listening" | "thinking" | "answering" | "other";

const LEAN = { yaw: -0.06, pitch: 0.1 };
const D_TURN = 220;

export function VoicePeek({ member, phase, since = 0, size = 116, words = "In a voice conversation" }: { member: CrewMember; phase: PeekPhase; since?: number; size?: number; words?: string }) {
  const clock = useClock();
  const level = useLevel();
  const handle = React.useRef<LiveHandle | null>(null);
  const held = React.useRef(false);
  const loud = React.useRef(0);
  const state: CrewState = phase === "thinking" ? "thinking" : "available";
  // Talking: its own output level, read about 30 times a second (the rig smooths it over 120 ms).
  const talk = useSampled((t) => (phase === "answering" ? level(t, "member") : 0), 33, [phase, level]);

  useTick(
    (t) => {
      const h = handle.current;
      if (!h || clock.reduced) return;
      if (phase === "listening") {
        const k = 1 - Math.pow(1 - Math.min(1, Math.max(0, (t - since) / D_TURN)), 3);
        h.drag(LEAN.yaw * k, LEAN.pitch * k);
        held.current = true;
        // A blink when one of your phrases ends: loud for a while, then quiet.
        const you = level(t, "you");
        if (you > 0.28) loud.current = Math.min(loud.current + 1, 99);
        else if (you < 0.05) {
          if (loud.current > 12) h.blink();
          loud.current = 0;
        }
      } else if (held.current) {
        h.release(0, 0);
        held.current = false;
      }
    },
    [phase, since, level, clock.reduced],
  );

  const stageH = Math.round(size * 0.82);
  return (
    <div className="jcp jv-peek" data-state={state} data-voice={phase} style={{ "--jcp-size": `${size}px`, "--jcp-stage": `${stageH}px` } as React.CSSProperties}>
      <div className="jcp__stage" aria-hidden="true">
        <CrewFace
          member={member}
          state={state}
          size={size}
          facing="front"
          focused
          idle
          level={phase === "answering" ? talk : undefined}
          offsetY={-0.1}
          onHandle={(h) => {
            handle.current = h;
          }}
        />
      </div>
      <div className="jcp__ledge" />
      <button type="button" className="jcp__tag" aria-label={`${member.name}, ${words}. Open profile`}>
        <span className="jcp__name">{member.name}</span>
        <span className="jcp__state">{words}</span>
      </button>
    </div>
  );
}
