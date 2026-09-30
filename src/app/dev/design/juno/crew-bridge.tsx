"use client";

/**
 * The seam between the screens and the crew character system (juno/crew/,
 * owned by the crew designer). The screens import crew pieces from here only,
 * so when the character system adds or renames an export there is one place
 * to follow it.
 *
 *   memberTheme(member)     the member's colour as thread tokens: the person's
 *                           bubbles and the armed send disc in that thread (D-032)
 *   <MemberPeek>            the character peeking over its own thread, with its
 *                           name and what it is doing in words
 *   <Reaction>              the member answering a thank-you on a message
 *
 * Until the crew designer's CrewPeek / getCrewTheme / MessageReaction land,
 * these are built here from CrewFace, at the same sizes and with the same
 * contract (state is always also words; motion only on events; reduced motion
 * keeps every state and drops the movement).
 */

import * as React from "react";
import { motion } from "framer-motion";
import {
  AVATAR_COLORS,
  AVATAR_MATERIALS,
  avatarFromSeed,
  EDITOR_SHAPES,
  EYE_LABEL,
  EYE_STYLES,
  FAMILY,
  MATERIAL_LABEL,
  normalizeAvatar,
  SHAPE_LABEL,
  type AvatarColor,
  type AvatarConfig,
  type AvatarMaterial,
  type AvatarShape,
  type EyeStyle,
} from "./crew/avatar";
import { CREW_BY_ID } from "./crew/fixtures";
import { CrewFace, useAvatar, type CrewMember, type CrewState } from "./crew/face";
import type { CrewRow } from "./fixtures";
import { SPRING, useReduced } from "./motion";

/* ———————————————————————————— Identity ———————————————————————————— */

/** A roster row as the character system sees it: the stored look when the member has one. */
export function crewMember(m: Pick<CrewRow, "id" | "name" | "role" | "seed">): CrewMember {
  const fx = CREW_BY_ID[m.id];
  return fx ? { id: m.id, name: m.name, role: m.role, seed: fx.seed, avatar: fx.avatar } : { id: m.id, name: m.name, role: m.role, seed: m.seed };
}

/* ———————————————————————————— The look (the editor's vocabulary) ———————————————————————————— */

export type Look = AvatarConfig;

/** The look a member wears now: its stored avatar, else its seed's (optionally in a chosen colour). */
export function lookOf(member: CrewMember, color?: AvatarColor): Look {
  return member.avatar ? normalizeAvatar(member.avatar, member.seed) : avatarFromSeed(member.seed, color);
}

const pick = <T,>(xs: readonly T[], n: number) => xs[Math.abs(n) % xs.length];

/** What the editor offers, in the character system's own words. */
export const LOOK = {
  shapes: EDITOR_SHAPES as readonly AvatarShape[],
  colors: AVATAR_COLORS as readonly AvatarColor[],
  materials: AVATAR_MATERIALS as readonly AvatarMaterial[],
  eyes: EYE_STYLES as readonly EyeStyle[],
  shapeLabel: (v: AvatarShape) => SHAPE_LABEL[v] ?? v,
  colorLabel: (v: string) => FAMILY[v as AvatarColor]?.label ?? v,
  colorFlat: (v: string) => FAMILY[v as AvatarColor]?.flat ?? "#8a8c90",
  materialLabel: (v: AvatarMaterial) => MATERIAL_LABEL[v] ?? v,
  eyeLabel: (v: EyeStyle) => EYE_LABEL[v] ?? v,
  /** Changing material clears a texture chosen for the old one (the new material wears its own default). */
  withMaterial: (v: AvatarMaterial): Partial<Look> => ({ material: v, texture: { kind: "none" } }),
  /** "Surprise me": a whole new look from a seed, body and material included. */
  shuffle: (seed: string): Look => {
    const cfg = avatarFromSeed(seed);
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
    return { ...cfg, shape: pick(EDITOR_SHAPES, h), material: pick(AVATAR_MATERIALS, h >> 3), texture: { kind: "none" } };
  },
};

/* ———————————————————————————— Thread colour ———————————————————————————— */

/**
 * Each member's colour, tuned as a thread colour rather than a body colour.
 * Light: a calm mid-tone carrying white text at 5:1 or better (ochre is the
 * exception: a light, warm fill with dark text, the only family whose honest
 * colour is light). Dark: the same hue, deeper and quieter for the bubble so a
 * thread never glows, and lifted for the send disc, which carries a dark
 * glyph there, the way the ink disc turns light in dark.
 * Measured: tools/member.mjs (every text pair 5:1 or better).
 */
interface ThreadColour {
  bubble: [string, string];
  onBubble: [string, string];
  disc: [string, string];
  onDisc: [string, string];
  discHover: [string, string];
  discPress: [string, string];
  /** Selection, focus ring, the peek's state word. */
  soft: [string, string];
}

const THREAD: Record<string, ThreadColour> = {
  sage: {
    bubble: ["#54774d", "#3f5a3a"],
    onBubble: ["#ffffff", "#eef3ec"],
    disc: ["#54774d", "#a6c29e"],
    onDisc: ["#ffffff", "#15200f"],
    discHover: ["#496b42", "#b5cfad"],
    discPress: ["#416239", "#98b58f"],
    soft: ["rgb(84 119 77 / 0.14)", "rgb(166 194 158 / 0.2)"],
  },
  clay: {
    bubble: ["#9c563d", "#77402d"],
    onBubble: ["#ffffff", "#f7ede9"],
    disc: ["#9c563d", "#e0a58e"],
    onDisc: ["#ffffff", "#2a130a"],
    discHover: ["#8f4b32", "#e8b39f"],
    discPress: ["#86422a", "#d3957d"],
    soft: ["rgb(156 86 61 / 0.13)", "rgb(224 165 142 / 0.2)"],
  },
  ochre: {
    bubble: ["#edc06b", "#6d5421"],
    onBubble: ["#332405", "#f8f0de"],
    disc: ["#e4b65c", "#dcb56d"],
    onDisc: ["#2c1f04", "#241904"],
    discHover: ["#daac53", "#e6c17e"],
    discPress: ["#cfa149", "#cca45d"],
    soft: ["rgb(214 160 60 / 0.2)", "rgb(220 181 109 / 0.2)"],
  },
  rose: {
    bubble: ["#995364", "#743e4b"],
    onBubble: ["#ffffff", "#f8edf0"],
    disc: ["#995364", "#e3a7b5"],
    onDisc: ["#ffffff", "#2c1117"],
    discHover: ["#8c4859", "#ebb6c2"],
    discPress: ["#833f51", "#d696a5"],
    soft: ["rgb(153 83 100 / 0.13)", "rgb(227 167 181 / 0.2)"],
  },
  iris: {
    bubble: ["#5b65ab", "#454c85"],
    onBubble: ["#ffffff", "#eef0fb"],
    disc: ["#5b65ab", "#aab2e6"],
    onDisc: ["#ffffff", "#141735"],
    discHover: ["#50599e", "#b9c0ee"],
    discPress: ["#485094", "#99a2da"],
    soft: ["rgb(91 101 171 / 0.13)", "rgb(170 178 230 / 0.2)"],
  },
  lagoon: {
    bubble: ["#2c7a77", "#205d5b"],
    onBubble: ["#ffffff", "#eaf5f4"],
    disc: ["#2c7a77", "#8ccbc6"],
    onDisc: ["#ffffff", "#07201e"],
    discHover: ["#1d6e6b", "#9dd6d1"],
    discPress: ["#0f6563", "#7bbdb8"],
    soft: ["rgb(44 122 119 / 0.13)", "rgb(140 203 198 / 0.2)"],
  },
  porcelain: {
    bubble: ["#6f6b64", "#57534d"],
    onBubble: ["#ffffff", "#f4f2ef"],
    disc: ["#6f6b64", "#c9c5bd"],
    onDisc: ["#ffffff", "#1f1d1a"],
    discHover: ["#646059", "#d6d2cb"],
    discPress: ["#5c5751", "#bab6ae"],
    soft: ["rgb(111 107 100 / 0.13)", "rgb(201 197 189 / 0.2)"],
  },
  graphite: {
    bubble: ["#26282c", "#3a3c41"],
    onBubble: ["#ffffff", "#f0f1f2"],
    disc: ["#26282c", "#e3e4e6"],
    onDisc: ["#ffffff", "#18191b"],
    discHover: ["#34363a", "#ffffff"],
    discPress: ["#4a4c51", "#cfd0d3"],
    soft: ["rgb(38 40 44 / 0.1)", "rgb(227 228 230 / 0.16)"],
  },
};

const ld = ([l, d]: [string, string]) => `light-dark(${l}, ${d})`;

/** The thread tokens for one colour family (unknown families fall back to graphite). */
export function threadColour(family: string): React.CSSProperties {
  const t = THREAD[family] ?? THREAD.graphite;
  return {
    "--m-bubble": ld(t.bubble),
    "--m-on-bubble": ld(t.onBubble),
    "--m-disc": ld(t.disc),
    "--m-on-disc": ld(t.onDisc),
    "--m-disc-hover": ld(t.discHover),
    "--m-disc-press": ld(t.discPress),
    "--m-soft": ld(t.soft),
  } as React.CSSProperties;
}

export const THREAD_FAMILIES = Object.keys(THREAD);

/** A member's thread colour, from its look. */
export function useMemberTheme(member: CrewMember): { family: string; style: React.CSSProperties } {
  const cfg = useAvatar(member);
  return { family: cfg.color, style: threadColour(cfg.color) };
}

/* ———————————————————————————— The peek ———————————————————————————— */

const PEEK_WORDS: Record<CrewState, string> = {
  available: "Here",
  thinking: "Thinking…",
  working: "Working",
  waiting: "Needs your answer",
  paused: "Paused",
  offline: "Offline",
};

/**
 * The member over its own thread (D-032): the character sits on the top edge
 * of the conversation, big enough for its look and its state to read, with a
 * name tag under it that says the state in words. The character is the one
 * face in the product allowed a subtle idle (focused, on screen, motion
 * allowed); a state change moves it once. Pressing the tag opens the profile.
 */
export function MemberPeek({
  member,
  state,
  words,
  size = 76,
  arrive,
}: {
  member: CrewMember;
  state: CrewState;
  /** The state in words; defaults to the short form ("Thinking…"). */
  words?: string;
  size?: number;
  arrive?: boolean;
}) {
  const reduced = useReduced();
  const said = words ?? PEEK_WORDS[state];
  return (
    <div className="jn-peek" data-state={state}>
      <motion.span
        className="jn-peek__char"
        initial={arrive && !reduced ? { y: 18, opacity: 0, scale: 0.94 } : false}
        animate={{ y: 0, opacity: 1, scale: 1 }}
        transition={reduced ? { duration: 0.16 } : SPRING.character}
      >
        <CrewFace member={member} state={state} size={size} facing="front" focused />
      </motion.span>
      <button type="button" className="jn-peek__tag" aria-label={`${member.name}, ${said}. Open profile`}>
        <span className="jn-peek__name">{member.name}</span>
        <motion.span key={said} className="jn-peek__state" initial={reduced ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.12 }}>
          {said}
        </motion.span>
      </button>
    </div>
  );
}

/* ———————————————————————————— Reactions ———————————————————————————— */

/**
 * A member answering a thank-you: its own face, happy, pinned to the corner of
 * the message it reacts to. It arrives once with a small bounce (the one
 * celebratory move a character makes, INTERACTION_SPEC §2.9 as amended by
 * D-032) and then sits still. The words are in the label.
 */
export function Reaction({ member, label, play = true }: { member: CrewMember; label?: string; play?: boolean }) {
  const reduced = useReduced();
  const bounce = play && !reduced;
  return (
    <motion.span
      className="jn-react"
      role="img"
      aria-label={label ?? `${member.name} reacted, glad it helped`}
      initial={bounce ? { scale: 0.4, opacity: 0, y: 6 } : false}
      animate={bounce ? { scale: [0.4, 1.12, 1], opacity: 1, y: [6, -3, 0] } : { scale: 1, opacity: 1, y: 0 }}
      transition={bounce ? { duration: 0.52, times: [0, 0.55, 1], ease: [0.16, 1, 0.3, 1], delay: 0.35 } : { duration: 0.16 }}
    >
      <CrewFace member={member} state="available" size={22} facing="front" live={false} />
      <svg className="jn-react__heart" viewBox="0 0 12 12" aria-hidden="true">
        <path d="M6 10.4 1.9 6.5a2.5 2.5 0 0 1 3.6-3.5l.5.5.5-.5a2.5 2.5 0 0 1 3.6 3.5Z" />
      </svg>
    </motion.span>
  );
}
