/**
 * AvatarConfig v2: everything a crew character is made of, as a small
 * serialisable object (D-032).
 *
 * It is stored on the crew member and read by every renderer (three.js on the
 * web, RealityKit on the Mac and iPhone), so it holds only decisions, never
 * geometry: a body shape, a colour, a pattern, a material, the eyes, brows,
 * cheeks and mouth, up to three accessories, and a seed. A missing config is
 * derived from the member's seed, so an untouched member looks the same on
 * every device and changes only when a person changes it.
 *
 * Pure and deterministic (no DOM, no Math.random).
 */

import { hashSeed, prng } from "./identity";
import { colorHex, colorLabel, hexToOklch, isColorValue, isHex, isPaletteId, PALETTE_IDS, patternPartner, type ColorValue, type PaletteId } from "./palette";

export const AVATAR_VERSION = 2 as const;

/* ——————————————————————————— Vocabulary ——————————————————————————— */

export const BODY_SHAPES = ["pebble", "mochi", "bean", "drop", "gumdrop", "marshmallow", "peanut", "star", "orb", "cub"] as const;
export type BodyShape = (typeof BODY_SHAPES)[number];
/** Kept for callers of the first engine. */
export type AvatarShape = BodyShape;

export const SHAPE_LABEL: Record<BodyShape, string> = {
  pebble: "Pebble",
  mochi: "Mochi",
  bean: "Bean",
  drop: "Drop",
  gumdrop: "Gumdrop",
  marshmallow: "Marshmallow",
  peanut: "Peanut",
  star: "Soft star",
  orb: "Orb",
  cub: "Cub",
};

export const MATERIAL_KINDS = ["plush", "velvet", "knit", "felt", "vinyl", "ceramic"] as const;
export type MaterialKind = (typeof MATERIAL_KINDS)[number];

export const MATERIAL_LABEL: Record<MaterialKind, string> = {
  plush: "Plush",
  velvet: "Velvet",
  knit: "Knit",
  felt: "Felt",
  vinyl: "Soft vinyl",
  ceramic: "Ceramic",
};

export interface AvatarMaterial {
  kind: MaterialKind;
  /** Plush: 0 short pile .. 1 long, fluffy fur. Velvet uses a fixed short pile. */
  furLength: number;
  /** Plush: 0 airy .. 1 dense. */
  furDensity: number;
}

export const EYE_STYLES = ["button", "oval", "sleepy", "wide", "bead", "googly", "stitched"] as const;
export type EyeStyle = (typeof EYE_STYLES)[number];

export const EYE_LABEL: Record<EyeStyle, string> = {
  button: "Glossy button",
  oval: "Soft oval",
  sleepy: "Sleepy lids",
  wide: "Wide awake",
  bead: "Little beads",
  googly: "Googly",
  stitched: "Stitched",
};

export interface AvatarEyes {
  style: EyeStyle;
  /** 0 small .. 1 large */
  size: number;
  /** 0 close together .. 1 wide apart */
  gap: number;
  /** 0 low .. 1 high on the face */
  y: number;
}

export const BROWS = ["none", "soft", "arched", "straight"] as const;
export type Brows = (typeof BROWS)[number];
export const BROW_LABEL: Record<Brows, string> = { none: "No brows", soft: "Soft", arched: "Arched", straight: "Straight" };

export const MOUTHS = ["none", "smile", "dot"] as const;
export type Mouth = (typeof MOUTHS)[number];
export const MOUTH_LABEL: Record<Mouth, string> = { none: "No mouth", smile: "Smile", dot: "Little o" };

export const PATTERN_KINDS = ["none", "dip", "belly", "spots", "stripes", "image"] as const;
export type PatternKind = (typeof PATTERN_KINDS)[number];
export const PATTERN_LABEL: Record<PatternKind, string> = {
  none: "Plain",
  dip: "Two-tone",
  belly: "Belly",
  spots: "Spots",
  stripes: "Stripes",
  image: "Own image",
};

export type AvatarPattern =
  | { kind: "none" }
  | { kind: "dip" | "belly" | "spots" | "stripes"; color: ColorValue; /** 0 fine .. 1 bold */ scale: number }
  /** An uploaded image, already validated and downscaled to 512 px. `tint` 0..1 pulls it toward the body colour. */
  | { kind: "image"; assetUrl: string; tint: number };

/* ——————————————————————————— Accessories ——————————————————————————— */

export const ACCESSORY_SLOTS = ["head", "pin", "eyes", "ears", "neck"] as const;
export type AccessorySlot = (typeof ACCESSORY_SLOTS)[number];

export const ACCESSORIES = {
  cap: { label: "Soft cap", slot: "head", material: "felt" },
  beanie: { label: "Beanie", slot: "head", material: "knit" },
  bucket: { label: "Bucket hat", slot: "head", material: "canvas" },
  headband: { label: "Headband", slot: "head", material: "velvet" },
  sprout: { label: "Sprout", slot: "head", material: "vinyl" },
  antenna: { label: "Antenna", slot: "head", material: "vinyl" },
  flower: { label: "Flower pin", slot: "pin", material: "felt" },
  round: { label: "Round glasses", slot: "eyes", material: "metal" },
  square: { label: "Square frames", slot: "eyes", material: "acetate" },
  shades: { label: "Sunglasses", slot: "eyes", material: "acetate" },
  monocle: { label: "Monocle", slot: "eyes", material: "metal" },
  headphones: { label: "Headphones", slot: "ears", material: "vinyl" },
  earbuds: { label: "Earbuds", slot: "ears", material: "vinyl" },
  hoops: { label: "Earrings", slot: "ears", material: "metal" },
  bow: { label: "Bow", slot: "neck", material: "velvet" },
  scarf: { label: "Scarf", slot: "neck", material: "knit" },
  bandana: { label: "Bandana", slot: "neck", material: "canvas" },
} as const satisfies Record<string, { label: string; slot: AccessorySlot; material: string }>;

export type AccessoryId = keyof typeof ACCESSORIES;
export const ACCESSORY_IDS = Object.keys(ACCESSORIES) as AccessoryId[];
export const MAX_ACCESSORIES = 3;

export interface AccessorySpec {
  id: AccessoryId;
  /** The accessory's own colour. Absent: a colour chosen to sit with the body. */
  color?: ColorValue;
}

/* ——————————————————————————— The config ——————————————————————————— */

export interface AvatarConfig {
  v: typeof AVATAR_VERSION;
  shape: BodyShape;
  /** -1 rounder and lower .. 1 taller and slimmer. */
  stretch: number;
  color: ColorValue;
  pattern: AvatarPattern;
  material: AvatarMaterial;
  eyes: AvatarEyes;
  brows: Brows;
  cheeks: boolean;
  mouth: Mouth;
  accessories: AccessorySpec[];
  seed: string;
}

/* ——————————————————————————— Derivation ——————————————————————————— */

const r2 = (n: number) => Math.round(n * 100) / 100;
const clamp01 = (n: unknown, fb: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fb);
const clampS = (n: unknown, fb: number) => (typeof n === "number" && Number.isFinite(n) ? Math.min(1, Math.max(-1, n)) : fb);

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length) % xs.length];
}

/** Colours the seed chooses from: the whole palette except the two neutrals, which a person picks on purpose. */
const SEED_COLORS: PaletteId[] = PALETTE_IDS.filter((c) => c !== "cloud" && c !== "graphite");

/**
 * The character an untouched member wears: a plush body in its own colour,
 * a shape from the friendly half of the set, soft oval or button eyes, and
 * nothing on its head. Enough to tell members apart, calm enough that a
 * person's own choices are what make a character special.
 */
export function avatarFromSeed(seed: string, color?: ColorValue): AvatarConfig {
  const r = prng(hashSeed(`avatar2:${seed}`));
  const shape = pick(r, ["pebble", "mochi", "bean", "orb", "gumdrop", "peanut"] as const);
  return {
    v: AVATAR_VERSION,
    shape,
    stretch: r2(r() * 0.6 - 0.3),
    color: color ?? SEED_COLORS[hashSeed(`color:${seed}`) % SEED_COLORS.length],
    pattern: { kind: "none" },
    material: { kind: "plush", furLength: r2(0.35 + r() * 0.3), furDensity: r2(0.55 + r() * 0.3) },
    eyes: { style: pick(r, ["oval", "button", "oval"] as const), size: r2(0.4 + r() * 0.25), gap: r2(0.35 + r() * 0.3), y: r2(0.4 + r() * 0.2) },
    brows: "none",
    cheeks: r() < 0.4,
    mouth: "none",
    accessories: [],
    seed,
  };
}

/** Pairings that belong to someone else's characters (D-032 guardrail); "Surprise me" never lands on them. */
export function resemblesSomeoneElse(cfg: AvatarConfig): boolean {
  const hex = colorHex(cfg.color);
  const { h, c, l } = hexToOklch(hex);
  const ids = new Set(cfg.accessories.map((a) => a.id));
  const yellow = c > 0.08 && h > 70 && h < 105 && l > 0.7;
  const green = c > 0.08 && h > 110 && h < 150;
  const pink = c > 0.07 && (h > 330 || h < 10) && l > 0.55;
  const blue = c > 0.1 && h > 235 && h < 270;
  if (yellow && (cfg.shape === "drop" || cfg.shape === "star") && ids.has("round")) return true;
  if (yellow && ids.has("round") && ids.has("bow")) return true;
  if (green && cfg.eyes.style === "googly") return true;
  if (pink && ids.has("shades")) return true;
  if (pink && ids.has("headphones") && (cfg.shape === "orb" || cfg.shape === "mochi")) return true;
  if (blue && (cfg.shape === "mochi" || cfg.shape === "orb") && ids.has("cap")) return true;
  return false;
}

/**
 * "Surprise me": a complete, considered character from a seed. It draws from
 * everything (every shape, material, eye, pattern and accessory) but keeps
 * the rules a designer would: at most one accessory per region, patterns on
 * soft materials, glasses only on eyes that fit behind them, and never a
 * pairing that belongs to someone else.
 */
export function surpriseAvatar(seed: string, keepColor?: ColorValue): AvatarConfig {
  for (let attempt = 0; attempt < 12; attempt++) {
    const r = prng(hashSeed(`surprise:${seed}:${attempt}`));
    const shape = pick(r, BODY_SHAPES);
    const color: ColorValue = keepColor ?? pick(r, PALETTE_IDS);
    const kind = r() < 0.55 ? "plush" : pick(r, MATERIAL_KINDS);
    const material: AvatarMaterial = { kind, furLength: r2(0.25 + r() * 0.6), furDensity: r2(0.5 + r() * 0.45) };
    const patterned = (kind === "plush" || kind === "felt" || kind === "vinyl") && r() < 0.35;
    const pattern: AvatarPattern = patterned
      ? { kind: pick(r, ["dip", "belly", "spots", "stripes"] as const), color: defaultPatternColor(color), scale: r2(0.3 + r() * 0.5) }
      : { kind: "none" };
    const style = pick(r, EYE_STYLES);
    const accessories: AccessorySpec[] = [];
    const want = Math.floor(r() * 3.2);
    const slots = new Set<AccessorySlot>();
    for (let i = 0; i < want; i++) {
      const id = pick(r, ACCESSORY_IDS);
      const slot = ACCESSORIES[id].slot;
      if (slots.has(slot)) continue;
      if (slot === "eyes" && (style === "googly" || style === "wide")) continue;
      slots.add(slot);
      accessories.push({ id });
    }
    const cfg: AvatarConfig = {
      v: AVATAR_VERSION,
      shape,
      stretch: r2(r() * 1.2 - 0.6),
      color,
      pattern,
      material,
      eyes: { style, size: r2(0.25 + r() * 0.55), gap: r2(0.2 + r() * 0.6), y: r2(0.3 + r() * 0.4) },
      brows: r() < 0.3 ? pick(r, ["soft", "arched", "straight"] as const) : "none",
      cheeks: r() < 0.45,
      mouth: r() < 0.3 ? pick(r, ["smile", "dot"] as const) : "none",
      accessories,
      seed,
    };
    if (!resemblesSomeoneElse(cfg)) return cfg;
  }
  return avatarFromSeed(seed, keepColor);
}

/** The second colour a pattern wears when a person turns one on. */
export function defaultPatternColor(color: ColorValue): ColorValue {
  return patternPartner(colorHex(color)) as ColorValue;
}

/* ——————————————————————————— Validation ——————————————————————————— */

/** Only data: URLs of the three accepted image types, or https URLs, are kept. */
export function isAcceptableAssetUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 4_000_000) return false;
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) return true;
  return /^https:\/\/[^\s"'<>]+$/.test(url);
}

function oneOf<T extends string>(xs: readonly T[], v: unknown, fallback: T): T {
  return typeof v === "string" && (xs as readonly string[]).includes(v) ? (v as T) : fallback;
}

/* The first engine's vocabulary, mapped onto the characters (configs stored before D-032 keep rendering). */
const V1_SHAPE: Record<string, BodyShape> = { pebble: "pebble", bean: "bean", dome: "gumdrop", orb: "orb", cushion: "marshmallow" };
const V1_COLOR: Record<string, PaletteId> = {
  porcelain: "cloud",
  graphite: "graphite",
  clay: "coral",
  ochre: "marigold",
  rose: "blossom",
  iris: "iris",
  lagoon: "lagoon",
  sage: "moss",
};
const V1_MATERIAL: Record<string, MaterialKind> = { ceramic: "ceramic", glass: "vinyl", felt: "felt", stone: "ceramic", metal: "vinyl", wood: "felt" };
const V1_EYES: Record<string, EyeStyle> = { capsule: "oval", round: "button", lit: "wide" };

/** A colour from any vocabulary (a palette id, a hex, or a first-engine family), else undefined. */
export function colorFrom(v: unknown): ColorValue | undefined {
  if (isPaletteId(v)) return v;
  if (isHex(v)) return v.toLowerCase() as ColorValue;
  if (typeof v === "string" && V1_COLOR[v]) return V1_COLOR[v];
  return undefined;
}

function normalizeColor(v: unknown, fb: ColorValue): ColorValue {
  if (isPaletteId(v)) return v;
  if (isHex(v)) return v.toLowerCase() as ColorValue;
  if (typeof v === "string" && V1_COLOR[v]) return V1_COLOR[v];
  return fb;
}

/**
 * Validate anything that claims to be an AvatarConfig (stored JSON, a
 * setup-change payload, a paste, a first-engine config) into one that renders.
 * Unknown values fall back to the seed's choice, numbers are clamped, an image
 * that fails validation becomes plain, accessories are de-duplicated by slot
 * and capped at three.
 */
export function normalizeAvatar(input: unknown, seed = "juno"): AvatarConfig {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const s = typeof o.seed === "string" && o.seed ? o.seed : seed;
  const base = avatarFromSeed(s);
  if (!input || typeof input !== "object") return base;
  const v1 = o.v === 1;
  const color = normalizeColor(o.color, base.color);

  let shape: BodyShape = base.shape;
  if (typeof o.shape === "string") shape = v1 ? (V1_SHAPE[o.shape] ?? base.shape) : oneOf(BODY_SHAPES, o.shape === "loaf" ? "marshmallow" : o.shape, base.shape);

  const m = (o.material ?? {}) as Record<string, unknown>;
  let material: AvatarMaterial;
  if (typeof o.material === "string") material = { kind: V1_MATERIAL[o.material] ?? "plush", furLength: 0.5, furDensity: 0.7 };
  else
    material = {
      kind: oneOf(MATERIAL_KINDS, m.kind, base.material.kind),
      furLength: r2(clamp01(m.furLength ?? m.length, base.material.furLength)),
      furDensity: r2(clamp01(m.furDensity ?? m.density, base.material.furDensity)),
    };

  const e = (o.eyes ?? {}) as Record<string, unknown>;
  const eyeStyle = v1 && typeof e.style === "string" ? (V1_EYES[e.style] ?? "oval") : oneOf(EYE_STYLES, e.style, base.eyes.style);
  const eyes: AvatarEyes = {
    style: eyeStyle,
    size: r2(clamp01(e.size, base.eyes.size)),
    gap: r2(clamp01(e.gap, base.eyes.gap)),
    y: r2(clamp01(e.y, base.eyes.y)),
  };

  let pattern: AvatarPattern = { kind: "none" };
  const p = (o.pattern ?? {}) as Record<string, unknown>;
  const t = (o.texture ?? {}) as Record<string, unknown>;
  if (p.kind === "image" && isAcceptableAssetUrl(p.assetUrl)) pattern = { kind: "image", assetUrl: p.assetUrl, tint: r2(clamp01(p.tint, 0.3)) };
  else if (p.kind === "dip" || p.kind === "belly" || p.kind === "spots" || p.kind === "stripes")
    pattern = { kind: p.kind, color: normalizeColor(p.color, defaultPatternColor(color)), scale: r2(clamp01(p.scale, 0.5)) };
  else if (v1 && t.kind === "image" && isAcceptableAssetUrl(t.assetUrl)) pattern = { kind: "image", assetUrl: t.assetUrl, tint: r2(clamp01(t.tint, 0.3)) };

  const accessories: AccessorySpec[] = [];
  const seen = new Set<AccessorySlot>();
  if (Array.isArray(o.accessories)) {
    for (const a of o.accessories) {
      const id = (a && typeof a === "object" ? (a as Record<string, unknown>).id : a) as unknown;
      if (typeof id !== "string" || !(id in ACCESSORIES)) continue;
      const slot = ACCESSORIES[id as AccessoryId].slot;
      if (seen.has(slot)) continue;
      seen.add(slot);
      const c = a && typeof a === "object" ? (a as Record<string, unknown>).color : undefined;
      accessories.push(isColorValue(c) ? { id: id as AccessoryId, color: normalizeColor(c, "graphite") } : { id: id as AccessoryId });
      if (accessories.length >= MAX_ACCESSORIES) break;
    }
  }

  return {
    v: AVATAR_VERSION,
    shape,
    stretch: r2(clampS(o.stretch, v1 ? 0 : base.stretch)),
    color,
    pattern,
    material,
    eyes,
    brows: oneOf(BROWS, o.brows, "none"),
    cheeks: typeof o.cheeks === "boolean" ? o.cheeks : false,
    mouth: oneOf(MOUTHS, o.mouth, "none"),
    accessories,
    seed: s,
  };
}

/** Put an accessory on, replacing whatever held its slot, keeping at most three (the oldest goes). */
export function wearAccessory(list: AccessorySpec[], id: AccessoryId): AccessorySpec[] {
  const slot = ACCESSORIES[id].slot;
  const rest = list.filter((a) => ACCESSORIES[a.id].slot !== slot);
  const next = [...rest, { id }];
  return next.slice(Math.max(0, next.length - MAX_ACCESSORIES));
}
export function removeAccessory(list: AccessorySpec[], id: AccessoryId): AccessorySpec[] {
  return list.filter((a) => a.id !== id);
}

/* ——————————————————————————— Keys ——————————————————————————— */

const urlKeys = new Map<string, string>();
/** A short stable key for an image URL (hashing a 60 KB data URL once). */
function urlKey(url: string): string {
  let k = urlKeys.get(url);
  if (!k) {
    k = `${url.length.toString(36)}.${hashSeed(url).toString(36)}`;
    if (urlKeys.size > 64) urlKeys.clear();
    urlKeys.set(url, k);
  }
  return k;
}

function patternKey(p: AvatarPattern): string {
  if (p.kind === "none") return "-";
  if (p.kind === "image") return `i.${urlKey(p.assetUrl)}.${r2(p.tint)}`;
  return `${p.kind}.${colorHex(p.color)}.${r2(p.scale)}`;
}

/** A compact, stable string for caches (sprites, materials). */
export function avatarKey(cfg: AvatarConfig): string {
  const m = cfg.material;
  const e = cfg.eyes;
  return [
    "v2",
    cfg.shape,
    r2(cfg.stretch),
    colorHex(cfg.color),
    patternKey(cfg.pattern),
    m.kind === "plush" ? `plush.${r2(m.furLength)}.${r2(m.furDensity)}` : m.kind,
    `${e.style}.${r2(e.size)}.${r2(e.gap)}.${r2(e.y)}`,
    cfg.brows,
    cfg.cheeks ? "c" : "-",
    cfg.mouth,
    cfg.accessories.map((a) => (a.color ? `${a.id}:${colorHex(a.color)}` : a.id)).join("+") || "-",
  ].join("|");
}

/** The geometry-only part of the key. */
export function formKey(cfg: Pick<AvatarConfig, "shape" | "stretch">): string {
  return `${cfg.shape}|${r2(cfg.stretch)}`;
}

/* ——————————————————————————— Geometry hints ——————————————————————————— */

/** Fur length in body units (plush 0.035..0.135, velvet a fixed short pile, others none). */
export function furLengthOf(cfg: Pick<AvatarConfig, "material">): number {
  if (cfg.material.kind === "plush") return 0.035 + cfg.material.furLength * 0.1;
  if (cfg.material.kind === "velvet") return 0.014;
  return 0;
}

/** How far above the body's top the headwear reaches (for flat previews and framing guesses). */
export function headroomOf(cfg: Pick<AvatarConfig, "accessories">): number {
  let h = 0;
  for (const a of cfg.accessories) {
    if (a.id === "antenna") h = Math.max(h, 0.42);
    else if (a.id === "sprout") h = Math.max(h, 0.3);
    else if (a.id === "beanie") h = Math.max(h, 0.3);
    else if (a.id === "bucket" || a.id === "cap") h = Math.max(h, 0.14);
    else if (a.id === "headphones") h = Math.max(h, 0.1);
  }
  return h;
}

/* ——————————————————————————— Words ——————————————————————————— */

/** A one-line description, for the setup-change card and accessibility ("Coral plush mochi, wearing a flower pin"). */
export function describeAvatar(cfg: AvatarConfig): string {
  const mat = cfg.material.kind === "plush" ? (cfg.material.furLength > 0.65 ? "fluffy" : "plush") : MATERIAL_LABEL[cfg.material.kind].toLowerCase();
  const col = colorLabel(cfg.color);
  const pat = cfg.pattern.kind === "none" ? "" : cfg.pattern.kind === "image" ? " in its own image" : ` with ${PATTERN_LABEL[cfg.pattern.kind].toLowerCase()}`;
  const acc = cfg.accessories.map((a) => ACCESSORIES[a.id].label.toLowerCase());
  const wearing = acc.length ? `, wearing ${acc.length > 1 ? `${acc.slice(0, -1).join(", ")} and ${acc[acc.length - 1]}` : acc[0]}` : "";
  const colWord = col === "Custom colour" ? "Custom-coloured" : col;
  return `${colWord} ${mat} ${SHAPE_LABEL[cfg.shape].toLowerCase()}${pat}${wearing}`;
}
