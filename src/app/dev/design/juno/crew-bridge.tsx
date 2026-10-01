"use client";

/**
 * The seam between the screens and the crew character system (juno/crew/,
 * owned by the crew designer). The screens import crew pieces from here only,
 * so when the character system adds or renames an export there is one place
 * to follow it.
 *
 *   crewMember(row)         a roster row as the character system sees it (its stored look)
 *   useMemberTheme(member)  the member's thread colours (getCrewTheme): the person's
 *                           bubbles, the armed send disc, the ring and accent text (D-032)
 *   threadColour(color)     the same for a colour being chosen (the editor's sample)
 *   <MemberPeek>            CrewPeek: the character over its own thread's top edge,
 *                           its name and what it is doing in words
 *   <Reaction>              MessageReaction, placed on a message's leading top corner
 */

import * as React from "react";
import { CREW_BY_ID, CrewPeek, getCrewTheme, MessageReaction, themeForColor, useAvatar, type CrewMember, type CrewState } from "./crew";
import type { CrewRow } from "./fixtures";

/* ———————————————————————————— Identity ———————————————————————————— */

/** A roster row as the character system sees it: the stored look when the member has one. */
export function crewMember(m: Pick<CrewRow, "id" | "name" | "role" | "seed">): CrewMember {
  const fx = CREW_BY_ID[m.id];
  return fx ? { id: m.id, name: m.name, role: m.role, seed: fx.seed, avatar: fx.avatar } : { id: m.id, name: m.name, role: m.role, seed: m.seed };
}

/* ———————————————————————————— Thread colour ———————————————————————————— */

/** The thread tokens (--m-*) for any body colour: a palette id or a custom hex. */
export function threadColour(color: string): React.CSSProperties {
  return themeForColor(color).style as React.CSSProperties;
}

/** A member's thread colour, from its look. */
export function useMemberTheme(member: CrewMember): { family: string; style: React.CSSProperties } {
  const cfg = useAvatar(member);
  return { family: String(cfg.color), style: getCrewTheme(cfg).style as React.CSSProperties };
}

/* ———————————————————————————— The peek ———————————————————————————— */

/**
 * The member over its own thread (D-032), as the crew designer drew it: the
 * character leans on the conversation's top edge, its name and state under
 * the edge in words; it idles only while on screen, blinks when the person
 * starts typing (`typing`), and is glad when thanked (`cheer`).
 */
export function MemberPeek({
  member,
  state,
  words,
  size = 104,
  arrive,
  typing,
  cheer,
}: {
  member: CrewMember;
  state: CrewState;
  words?: string;
  size?: number;
  arrive?: boolean;
  /** Increment on the person's first keystroke in a burst of typing. */
  typing?: number;
  /** Increment when a thank-you lands. */
  cheer?: number;
}) {
  return <CrewPeek member={member} state={state} words={words} size={size} arrive={arrive} typing={typing} cheer={cheer} />;
}

/* ———————————————————————————— Reactions ———————————————————————————— */

/** The member answering a thank-you, on the message's leading top corner, outside the text. */
export function Reaction({ member, label, play = true }: { member: CrewMember; label?: string; play?: boolean }) {
  return (
    <span className="jn-react">
      <MessageReaction member={member} kind="thanks" play={play} label={label} size={30} />
    </span>
  );
}
