import { z } from "zod";

// Characteristics: fine adjustments to tone layered on the personality preset
// (ChatGPT's "Characteristics"). Single source of truth for the settings UI,
// the settings and sync validators, and the system-prompt builder.
//
// Each one is a three-way setting, Less / Default / More, stored as its own
// TEXT column on Settings so a patch from any client writes one field without
// reading the others. "default" means "leave it to the personality" and puts
// nothing in the prompt, which is what every existing account reads as.
//
// Like a personality, a characteristic only shapes tone and layout. It never
// grants, implies or revokes a capability, never licenses flattery or
// inaccuracy, and does not reach into an artifact or a document the user asked
// for: those follow what was asked.

export const CHARACTERISTIC_LEVELS = ["less", "default", "more"] as const;

export type CharacteristicLevel = (typeof CHARACTERISTIC_LEVELS)[number];

export const DEFAULT_CHARACTERISTIC_LEVEL: CharacteristicLevel = "default";

/** The Settings columns, in the order the settings page lists them. */
export const CHARACTERISTIC_KEYS = ["toneWarmth", "toneEnthusiasm", "toneFormatting", "toneEmoji", "toneConciseness"] as const;

export type CharacteristicKey = (typeof CHARACTERISTIC_KEYS)[number];

export type CharacteristicSettings = Record<CharacteristicKey, CharacteristicLevel>;

export interface Characteristic {
  key: CharacteristicKey;
  label: string;
  description: string;
  /** The prompt line for each non-default level. */
  prompt: Record<Exclude<CharacteristicLevel, "default">, string>;
  /**
   * About how a reply looks on screen. A spoken reply has no layout and reads
   * emoji out as words, and voice mode already rules both out, so a voice turn
   * leaves these lines out rather than contradict it.
   */
  visual?: boolean;
}

export const CHARACTERISTICS: readonly Characteristic[] = [
  {
    key: "toneWarmth",
    label: "Warm",
    description: "How much warmth and personal care comes through.",
    prompt: {
      more: "Be warmer than usual: notice how the person seems to feel and speak to them with care, without flattery or filler.",
      less: "Be cooler and more matter-of-fact than usual: skip pleasantries, sympathy and reassurance unless they ask for them.",
    },
  },
  {
    key: "toneEnthusiasm",
    label: "Enthusiastic",
    description: "How much energy and excitement replies carry.",
    prompt: {
      more: "Bring more energy and enthusiasm than usual where it fits, without overstating how good anything is.",
      less: "Be calmer and more understated than usual: no exclamation marks and no hype.",
    },
  },
  {
    key: "toneFormatting",
    label: "Headers & lists",
    description: "How often answers are organised with headings and lists.",
    visual: true,
    prompt: {
      more: "Organise answers with headings and bulleted or numbered lists more often than usual, including fairly short ones.",
      less: "Write in flowing paragraphs: use a heading or a list only when the content really is a sequence of steps or a comparison.",
    },
  },
  {
    key: "toneEmoji",
    label: "Emoji",
    description: "How often emoji appear in replies.",
    visual: true,
    prompt: {
      more: "Use emoji more often than usual where they add tone or help scanning, a few per reply at most.",
      less: "Do not use emoji.",
    },
  },
  {
    key: "toneConciseness",
    label: "Concise",
    description: "How short and to the point replies are.",
    prompt: {
      more: "Be more concise than usual: lead with the answer and cut anything that does not change it.",
      less: "Be more thorough than usual: give fuller explanations, context and examples.",
    },
  },
];

export function isCharacteristicLevel(value: unknown): value is CharacteristicLevel {
  return typeof value === "string" && (CHARACTERISTIC_LEVELS as readonly string[]).includes(value);
}

/**
 * Every characteristic of a settings row (or a partial one), read leniently:
 * the columns are TEXT, so a value this build does not recognise, or one
 * missing from a row a client sent, reads as "default" and injects nothing.
 */
export function normalizeCharacteristics(
  values: Partial<Record<CharacteristicKey, unknown>> | null | undefined
): CharacteristicSettings {
  const out = {} as CharacteristicSettings;
  for (const key of CHARACTERISTIC_KEYS) {
    const value = values?.[key];
    out[key] = isCharacteristicLevel(value) ? value : DEFAULT_CHARACTERISTIC_LEVEL;
  }
  return out;
}

/**
 * The write validators, shared by PATCH /api/settings and the v1 sync
 * `settings.update` patch. Enumerated rather than free text: an unknown value
 * would be stored, then read back as "default", and the control would show a
 * choice nobody can see in the prompt.
 */
const levelField = z.enum(CHARACTERISTIC_LEVELS).optional();
export const CHARACTERISTIC_PATCH_FIELDS = {
  toneWarmth: levelField,
  toneEnthusiasm: levelField,
  toneFormatting: levelField,
  toneEmoji: levelField,
  toneConciseness: levelField,
} as const satisfies Record<CharacteristicKey, typeof levelField>;

/** The characteristic fields a validated patch actually sets, for a Prisma update. */
export function characteristicsPatch(
  patch: Partial<Record<CharacteristicKey, CharacteristicLevel | undefined>>
): Partial<CharacteristicSettings> {
  const out: Partial<CharacteristicSettings> = {};
  for (const key of CHARACTERISTIC_KEYS) {
    const value = patch[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * The "# Tone adjustments" section, or null when every characteristic that
 * applies is at its default — the common case, which leaves the prompt
 * byte-for-byte what it was before characteristics existed.
 *
 * Scoped on purpose: it is about the conversational reply only, it ranks below
 * the user's own custom instructions (which follow it in the prompt) and above
 * the personality preset (which precedes it), and it restates that tone never
 * changes accuracy or capability.
 */
export function characteristicsSystemPrompt(
  values: Partial<Record<CharacteristicKey, unknown>> | null | undefined,
  options: { voiceMode?: boolean } = {}
): string | null {
  const levels = normalizeCharacteristics(values);
  const lines: string[] = [];
  for (const characteristic of CHARACTERISTICS) {
    const level = levels[characteristic.key];
    if (level === "default") continue;
    if (options.voiceMode && characteristic.visual) continue;
    lines.push(`- ${characteristic.prompt[level]}`);
  }
  if (lines.length === 0) return null;
  return [
    "# Tone adjustments",
    "The user tuned these in their settings. They shape the tone and layout of your replies only: never accuracy, never what you can do, and never the content of an artifact or document they ask you to write. They take precedence over a response-style preset; the user's custom instructions take precedence over them.",
    ...lines,
  ].join("\n");
}
