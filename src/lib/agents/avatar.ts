/**
 * An agent's face, as data.
 *
 * Four independent choices — body shape, tone, eyes, mark — each a member of a
 * closed list, so the whole face is `{shape, tone, eyes, mark}` and nothing
 * else: the web draws it in SVG (`src/components/agents/agent-avatar.tsx`), the
 * Mac and the iPhone draw it in SwiftUI (`JunoAgentFace.swift`), and all three
 * read the same four words. `tests/agents-contract.test.ts` holds the Swift
 * lists to these.
 *
 * Why a closed vocabulary rather than an uploaded picture: the face is the
 * agent's status bar (docs/design/AGENTS.md §4) — its eyes change with what it
 * is doing — and a bitmap cannot blink. It is also why every part is drawn from
 * Juno's own marks rather than borrowed: the open ring with its ball, the
 * four-point spark.
 *
 * Pure: no React, no Prisma. The Swift face is a port of the geometry in the
 * component, not of this file.
 */

export const AGENT_SHAPES = ["orb", "pebble", "capsule", "petal", "bloom", "spark", "tile", "halo", "prism"] as const;
export type AgentShape = (typeof AGENT_SHAPES)[number];

/**
 * The same six hues the account accent offers, so an agent's tone is always a
 * colour the product already owns. Declared as `--agent-*` tokens in
 * globals.css for both themes and projected to Swift by `npm run design:tokens`.
 */
export const AGENT_TONES = ["coral", "juniper", "teal", "violet", "amber", "sage"] as const;
export type AgentTone = (typeof AGENT_TONES)[number];

/** The resting cut of the eyes. States reshape them from here (§4.2). */
export const AGENT_EYES = ["soft", "round", "tall", "wide"] as const;
export type AgentEyes = (typeof AGENT_EYES)[number];

/** One optional accessory. `none` is a real choice, and the default for most. */
export const AGENT_MARKS = ["none", "ring", "spark", "leaf", "antenna", "visor"] as const;
export type AgentMark = (typeof AGENT_MARKS)[number];

export interface AgentAvatar {
  shape: AgentShape;
  tone: AgentTone;
  eyes: AgentEyes;
  mark: AgentMark;
}

/** What each choice is called where a person picks it. */
export const AGENT_SHAPE_LABEL: Record<AgentShape, string> = {
  tile: "Tile",
  halo: "Halo",
  prism: "Prism",
  orb: "Orb",
  pebble: "Pebble",
  capsule: "Capsule",
  petal: "Petal",
  bloom: "Bloom",
  spark: "Spark",
};

export const AGENT_TONE_LABEL: Record<AgentTone, string> = {
  coral: "Coral",
  juniper: "Juniper",
  teal: "Teal",
  violet: "Violet",
  amber: "Amber",
  sage: "Sage",
};

export const AGENT_EYES_LABEL: Record<AgentEyes, string> = {
  soft: "Soft",
  round: "Round",
  tall: "Tall",
  wide: "Wide",
};

export const AGENT_MARK_LABEL: Record<AgentMark, string> = {
  none: "None",
  ring: "Ring",
  spark: "Spark",
  leaf: "Leaf",
  antenna: "Antenna",
  visor: "Visor",
};

function member<T extends string>(list: readonly T[], value: unknown): T | null {
  return typeof value === "string" && (list as readonly string[]).includes(value) ? (value as T) : null;
}

/**
 * FNV-1a over the seed. Stable across runtimes (no `crypto` import, so the
 * client can derive the same default the server stored), and good enough to
 * spread a handful of ids over 6×6×4 faces.
 */
function hash(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The face an agent starts with when nobody chose one.
 *
 * Derived from a seed (the agent's id, or its name before it has one) so two
 * agents hired in a row do not arrive identical, and so a client drawing a
 * row before the server's copy arrives draws the same face. The mark stays
 * `none` by default: an accessory is a choice a person makes, not a dice roll.
 */
export function defaultAgentAvatar(seed: string): AgentAvatar {
  const h = hash(seed || "agent");
  return {
    shape: AGENT_SHAPES[h % 6],
    tone: AGENT_TONES[Math.floor(h / 7) % AGENT_TONES.length],
    eyes: AGENT_EYES[Math.floor(h / 53) % AGENT_EYES.length],
    mark: "none",
  };
}

/**
 * Reads a stored or submitted face back into the vocabulary.
 *
 * Part by part rather than all-or-nothing: a face written by a newer build that
 * knows a seventh shape keeps its tone, eyes and mark here and loses only the
 * shape this build cannot draw, which falls back to the seeded default. A whole
 * face replaced because one field was unknown would be an agent that changed
 * colour for no reason the person could see.
 */
export function normalizeAgentAvatar(value: unknown, seed: string): AgentAvatar {
  const fallback = defaultAgentAvatar(seed);
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  return {
    shape: member(AGENT_SHAPES, record.shape) ?? fallback.shape,
    tone: member(AGENT_TONES, record.tone) ?? fallback.tone,
    eyes: member(AGENT_EYES, record.eyes) ?? fallback.eyes,
    mark: member(AGENT_MARKS, record.mark) ?? fallback.mark,
  };
}

/** The CSS custom property that carries a tone, for both themes. */
export function agentToneVar(tone: AgentTone): string {
  return `--agent-${tone}`;
}
