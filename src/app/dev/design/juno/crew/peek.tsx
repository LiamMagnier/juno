"use client";

/**
 * CrewPeek: the member over its own thread (D-032).
 *
 * The character looks over the thread's top edge: its body rises from behind
 * the hairline that bounds the conversation, so the messages scroll under the
 * edge it leans on. Its name and what it is doing sit under the edge in
 * words. It is the one character in the product allowed an idle (breathing
 * and an occasional blink, stopped when the tab is hidden or motion is
 * reduced) and it reacts to the thread's events:
 *
 *   state change     a pose change; waiting adds one hop that turns it to you
 *   you type         one blink
 *   you thank it     a happy double bounce and hearts in its colour (`cheer`)
 *   voice mode       it bobs with the level (`level`)
 *   the pointer      its eyes follow, and it blinks when you arrive over it
 *
 * Pressing the name opens the member's profile.
 */

import * as React from "react";
import { CrewFace, type CrewMember, type CrewState, type LiveHandle } from "./face";
import { SHORT_WORDS, needsYou } from "./words";
import "./crew-ui.css";

export interface CrewPeekProps {
  member: CrewMember;
  state: CrewState;
  /** The state in words; defaults to the short form ("Thinking…"). */
  words?: string;
  /** Character size in px (the frame; about a quarter of it sits below the edge). */
  size?: number;
  /** Play the arrival the first time it shows (a new member's first thread). */
  arrive?: boolean;
  /** Increment when the person thanks the member. */
  cheer?: number;
  /** Voice level 0..1 while in voice mode. */
  level?: number;
  /** Increment on the person's first keystroke in a burst of typing. */
  typing?: number;
  /** Opens the profile. */
  onOpen?: () => void;
  className?: string;
}

export function CrewPeek({ member, state, words, size = 120, arrive, cheer, level, typing, onOpen, className }: CrewPeekProps) {
  const said = words ?? SHORT_WORDS[state];
  const handle = React.useRef<LiveHandle | null>(null);
  const [shown, setShown] = React.useState(said);
  const [fade, setFade] = React.useState(false);

  // One blink when the person starts typing.
  React.useEffect(() => {
    if (typing) handle.current?.blink();
  }, [typing]);

  // The words change on `fast`, held a moment so a quick flicker of states never strobes.
  React.useEffect(() => {
    if (said === shown) return;
    setFade(true);
    const t = setTimeout(() => {
      setShown(said);
      setFade(false);
    }, 120);
    return () => clearTimeout(t);
  }, [said, shown]);

  const stageH = Math.round(size * 0.8);
  return (
    <div className={className ? `jcp ${className}` : "jcp"} data-state={state} style={{ "--jcp-size": `${size}px`, "--jcp-stage": `${stageH}px` } as React.CSSProperties}>
      <div className="jcp__stage" aria-hidden="true">
        <CrewFace
          member={member}
          state={state}
          size={size}
          facing="front"
          focused
          idle
          arrive={arrive}
          cheer={cheer}
          level={level}
          offsetY={0.03}
          onHandle={(h) => {
            handle.current = h;
          }}
        />
      </div>
      <div className="jcp__ledge" />
      <button type="button" className="jcp__tag" onClick={onOpen} aria-label={`${member.name}, ${shown}. Open profile`}>
        <span className="jcp__name">{member.name}</span>
        <span className="jcp__state" data-attn={needsYou(state) ? "" : undefined} data-fade={fade ? "" : undefined} aria-live="polite">
          {shown}
        </span>
      </button>
    </div>
  );
}
