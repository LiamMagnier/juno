"use client";

/**
 * MessageReaction: a member answering a message. Its own small character,
 * pinned to the corner of the message it reacts to, does one happy bounce
 * with a heart in its colour rising behind it, then sits still. The words are
 * in the label (and in the transcript for screen readers).
 *
 *   kind="thanks"   you thanked it: a heart
 *   kind="done"     it finished what you asked: a check, no heart
 *   kind="seen"     it has read your message and is on it: a quiet nod
 */

import * as React from "react";
import { CrewFace, useAvatar, type CrewMember } from "./face";
import { getCrewTheme } from "./theme";
import "./crew-ui.css";

export interface MessageReactionProps {
  member: CrewMember;
  kind?: "thanks" | "done" | "seen";
  /** Play the reaction (once, when it first appears). */
  play?: boolean;
  label?: string;
  size?: number;
  className?: string;
}

export function MessageReaction({ member, kind = "thanks", play = true, label, size = 30, className }: MessageReactionProps) {
  const cfg = useAvatar(member);
  const theme = getCrewTheme(cfg);
  const [cheer, setCheer] = React.useState(0);
  React.useEffect(() => {
    if (!play || kind === "seen") return;
    const t = setTimeout(() => setCheer(1), 260);
    return () => clearTimeout(t);
  }, [play, kind]);
  const said =
    label ?? (kind === "thanks" ? `${member.name} reacted: glad it helped` : kind === "done" ? `${member.name} reacted: done` : `${member.name} has seen this`);
  return (
    <span
      className={className ? `jcr ${className}` : "jcr"}
      role="img"
      aria-label={said}
      data-kind={kind}
      data-play={play ? "" : undefined}
      style={theme.style as React.CSSProperties}
    >
      <CrewFace member={member} state="available" size={size} facing="front" forceLive gaze={false} cheer={cheer} />
      {kind === "thanks" ? (
        <svg className="jcr__mark" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M6 10.6 1.8 6.6a2.55 2.55 0 0 1 3.7-3.5l.5.5.5-.5a2.55 2.55 0 0 1 3.7 3.5Z" />
        </svg>
      ) : kind === "done" ? (
        <svg className="jcr__mark jcr__mark--check" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 6.4 5.1 8.4 9 3.8" />
        </svg>
      ) : null}
    </span>
  );
}
