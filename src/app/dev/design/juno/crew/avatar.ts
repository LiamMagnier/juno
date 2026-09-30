/**
 * AvatarConfig: everything a crew member's three-dimensional face is made of,
 * as a small serialisable object.
 *
 * It is stored on the crew member and read by every renderer (three.js on the
 * web, RealityKit on the Mac and iPhone), so it holds only decisions, never
 * geometry: a shape grammar, a handful of proportions in 0..1, a material, a
 * colour family, a texture reference and the eyes. A missing config is derived
 * from the member's seed, so an untouched member looks the same everywhere and
 * changes only when a person changes it.
 *
 * Pure and deterministic (no DOM, no Math.random).
 */

import { hashSeed, prng } from "./identity";

export const AVATAR_VERSION = 1 as const;

/** Form grammars. `pebble` is the default grammar (see RATIONALE.md, "Form"). */
export const AVATAR_SHAPES = ["pebble", "bean", "dome", "orb", "cushion"] as const;
export type AvatarShape = (typeof AVATAR_SHAPES)[number];
/** The grammars a person can pick in the editor (the lab keeps all five). */
export const EDITOR_SHAPES: AvatarShape[] = ["pebble", "bean", "dome", "orb"];

export const AVATAR_MATERIALS = ["ceramic", "glass", "felt", "stone", "metal", "wood"] as const;
export type AvatarMaterial = (typeof AVATAR_MATERIALS)[number];

export const AVATAR_COLORS = ["porcelain", "graphite", "clay", "ochre", "rose", "iris", "lagoon", "sage"] as const;
export type AvatarColor = (typeof AVATAR_COLORS)[number];

export const PROCEDURAL_TEXTURES = ["speckle", "terrazzo", "marble", "knit", "linen", "grain"] as const;
export type ProceduralTexture = (typeof PROCEDURAL_TEXTURES)[number];

export const EYE_STYLES = ["capsule", "round", "lit"] as const;
export type EyeStyle = (typeof EYE_STYLES)[number];

export interface AvatarProportions {
  /** 0 narrow .. 1 broad */
  width: number;
  /** 0 short .. 1 tall */
  height: number;
  /** 0 flat .. 1 deep (front to back) */
  depth: number;
  /** 0 a little square .. 1 fully round (cross-section and profile) */
  round: number;
  /** 0 straight .. 1 narrower at the top */
  taper: number;
  /** -1 leans left .. 1 leans right (a bend, not a rotation) */
  lean: number;
}

export type AvatarTexture =
  | { kind: "none" }
  | { kind: "procedural"; id: ProceduralTexture; seed?: number }
  /** An uploaded image, already validated and downscaled to 512 px. `tint` 0..1 pulls it toward the colour family. */
  | { kind: "image"; assetUrl: string; tint?: number };

export interface AvatarEyes {
  style: EyeStyle;
  /** 0 close .. 1 wide apart */
  gap: number;
  /** 0 low .. 1 high on the face */
  y: number;
  /** 0 small .. 1 large */
  size: number;
}

export interface AvatarConfig {
  v: typeof AVATAR_VERSION;
  shape: AvatarShape;
  proportions: AvatarProportions;
  material: AvatarMaterial;
  color: AvatarColor;
  texture: AvatarTexture;
  eyes: AvatarEyes;
}

/* ——————————————————————————— Colour families ———————————————————————————
 * Albedo (sRGB) as a glaze would read under neutral studio light: calm,
 * mineral, a little grey, so every family sits on both the light ground
 * (#fcfcfd) and the charcoal ground (#18191b) without glowing or sinking.
 * `eye` is the inlay colour (dark on light bodies, light on graphite), `lit`
 * the colour of lit eyes, `metal` the anodised version, `wood` the stain.
 */
export interface FamilySpec {
  label: string;
  base: string;
  eye: string;
  lit: string;
  metal: string;
  wood: string;
  /** Felt sheen: a lighter, softer version of the base. */
  sheen: string;
  /** The flat colour used by the silhouette fallback and swatches. */
  flat: string;
}

export const FAMILY: Record<AvatarColor, FamilySpec> = {
  porcelain: { label: "Porcelain", base: "#d9d8d4", eye: "#1f2023", lit: "#fff1dc", metal: "#b9bbbe", wood: "#d6c3a4", sheen: "#ffffff", flat: "#dcdbd7" },
  graphite: { label: "Graphite", base: "#333438", eye: "#e6e2da", lit: "#ffe6c2", metal: "#3f4045", wood: "#3f3129", sheen: "#7d7e83", flat: "#45464a" },
  clay: { label: "Clay", base: "#a16852", eye: "#26170f", lit: "#ffeedd", metal: "#9d5f49", wood: "#a0603f", sheen: "#e2ad97", flat: "#b87458" },
  ochre: { label: "Ochre", base: "#ad8c4d", eye: "#261c0d", lit: "#fff3d6", metal: "#a9803a", wood: "#b08850", sheen: "#ecd08f", flat: "#c49a4f" },
  rose: { label: "Rose", base: "#b58789", eye: "#2a171a", lit: "#ffeeec", metal: "#b07b7f", wood: "#ad7a70", sheen: "#efc3c4", flat: "#c99193" },
  iris: { label: "Iris", base: "#7a81b0", eye: "#171930", lit: "#eff0ff", metal: "#6c76b1", wood: "#857b93", sheen: "#c6ccf1", flat: "#858dc6" },
  lagoon: { label: "Lagoon", base: "#528582", eye: "#0c1f1d", lit: "#e8fffb", metal: "#437d7a", wood: "#667a6b", sheen: "#a3d1cd", flat: "#58938f" },
  sage: { label: "Sage", base: "#80957a", eye: "#161f17", lit: "#f2ffe8", metal: "#738a6c", wood: "#948f6c", sheen: "#cadcc0", flat: "#8ea287" },
};

export const SHAPE_LABEL: Record<AvatarShape, string> = {
  pebble: "Pebble",
  bean: "Bean",
  dome: "Dome",
  orb: "Orb",
  cushion: "Cushion",
};

export const MATERIAL_LABEL: Record<AvatarMaterial, string> = {
  ceramic: "Ceramic",
  glass: "Frosted glass",
  felt: "Felt",
  stone: "Stone",
  metal: "Anodised metal",
  wood: "Wood",
};

export const TEXTURE_LABEL: Record<ProceduralTexture, string> = {
  speckle: "Speckle",
  terrazzo: "Terrazzo",
  marble: "Marble",
  knit: "Knit",
  linen: "Linen",
  grain: "Wood grain",
};

export const EYE_LABEL: Record<EyeStyle, string> = {
  capsule: "Capsule",
  round: "Round",
  lit: "Lit",
};

/** The texture each material wears when the person has not chosen one. */
export const MATERIAL_DEFAULT_TEXTURE: Record<AvatarMaterial, ProceduralTexture | null> = {
  ceramic: null,
  glass: null,
  felt: null,
  stone: "speckle",
  metal: null,
  wood: "grain",
};

/* ——————————————————————————— Derivation ——————————————————————————— */

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);
const clampSigned = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(-1, n)) : 0);
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * The avatar an untouched member wears. Every member shares the pebble
 * grammar and the matte ceramic glaze; the seed gives it its own colour,
 * proportions and eyes, each inside a narrow band so the crew reads as one
 * family of individuals.
 */
export function avatarFromSeed(seed: string, color?: AvatarColor): AvatarConfig {
  const r = prng(hashSeed(`avatar:${seed}`));
  const derivedColor = AVATAR_COLORS[hashSeed(`color:${seed}`) % AVATAR_COLORS.length];
  const proportions: AvatarProportions = {
    width: r2(r()),
    height: r2(r()),
    depth: r2(0.3 + r() * 0.5),
    round: r2(0.35 + r() * 0.6),
    taper: r2(r()),
    lean: r2(r() * 1.6 - 0.8),
  };
  const eyes: AvatarEyes = {
    style: "capsule",
    gap: r2(0.2 + r() * 0.6),
    y: r2(0.25 + r() * 0.55),
    size: r2(0.3 + r() * 0.5),
  };
  // A graphite glaze wears lit eyes more often than not: dark inlay would vanish.
  const c = color ?? derivedColor;
  if (c === "graphite" && r() < 0.6) eyes.style = "lit";
  return {
    v: AVATAR_VERSION,
    shape: "pebble",
    proportions,
    material: "ceramic",
    color: c,
    texture: { kind: "none" },
    eyes,
  };
}

function oneOf<T extends string>(xs: readonly T[], v: unknown, fallback: T): T {
  return typeof v === "string" && (xs as readonly string[]).includes(v) ? (v as T) : fallback;
}

/** Only data: URLs of the three accepted image types, or https URLs, are kept. */
export function isAcceptableAssetUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 4_000_000) return false;
  if (/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) return true;
  return /^https:\/\/[^\s"'<>]+$/.test(url);
}

/**
 * Validate anything that claims to be an AvatarConfig (stored JSON, a
 * setup-change payload, a paste) into one that renders. Unknown values fall
 * back to the seed's choice, numbers are clamped, and a texture that fails
 * validation becomes none.
 */
export function normalizeAvatar(input: unknown, seed = "juno"): AvatarConfig {
  const base = avatarFromSeed(seed);
  if (!input || typeof input !== "object") return base;
  const o = input as Record<string, unknown>;
  const p = (o.proportions ?? {}) as Record<string, unknown>;
  const e = (o.eyes ?? {}) as Record<string, unknown>;
  const t = (o.texture ?? {}) as Record<string, unknown>;
  const num = (v: unknown, fb: number) => (typeof v === "number" && Number.isFinite(v) ? v : fb);
  let texture: AvatarTexture = { kind: "none" };
  if (t.kind === "procedural" && (PROCEDURAL_TEXTURES as readonly string[]).includes(String(t.id))) {
    texture = { kind: "procedural", id: t.id as ProceduralTexture, seed: Math.round(num(t.seed, 1)) };
  } else if (t.kind === "image" && isAcceptableAssetUrl(t.assetUrl)) {
    texture = { kind: "image", assetUrl: t.assetUrl, tint: clamp01(num(t.tint, 0.3)) };
  }
  return {
    v: AVATAR_VERSION,
    shape: oneOf(AVATAR_SHAPES, o.shape, base.shape),
    proportions: {
      width: clamp01(num(p.width, base.proportions.width)),
      height: clamp01(num(p.height, base.proportions.height)),
      depth: clamp01(num(p.depth, base.proportions.depth)),
      round: clamp01(num(p.round, base.proportions.round)),
      taper: clamp01(num(p.taper, base.proportions.taper)),
      lean: clampSigned(num(p.lean, base.proportions.lean)),
    },
    material: oneOf(AVATAR_MATERIALS, o.material, base.material),
    color: oneOf(AVATAR_COLORS, o.color, base.color),
    texture,
    eyes: {
      style: oneOf(EYE_STYLES, e.style, base.eyes.style),
      gap: clamp01(num(e.gap, base.eyes.gap)),
      y: clamp01(num(e.y, base.eyes.y)),
      size: clamp01(num(e.size, base.eyes.size)),
    },
  };
}

/** The texture a config actually renders with (its own, or its material's default). */
export function effectiveTexture(cfg: AvatarConfig): AvatarTexture {
  if (cfg.texture.kind !== "none") return cfg.texture;
  const d = MATERIAL_DEFAULT_TEXTURE[cfg.material];
  return d ? { kind: "procedural", id: d, seed: 1 } : cfg.texture;
}

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

/** A compact, stable string for caches (sprites, geometry, materials). */
export function avatarKey(cfg: AvatarConfig): string {
  const p = cfg.proportions;
  const e = cfg.eyes;
  const t = cfg.texture;
  const tex = t.kind === "none" ? "-" : t.kind === "procedural" ? `p.${t.id}.${t.seed ?? 1}` : `i.${urlKey(t.assetUrl)}.${r2(t.tint ?? 0.3)}`;
  return [
    cfg.v,
    cfg.shape,
    [p.width, p.height, p.depth, p.round, p.taper, p.lean].map(r2).join(","),
    cfg.material,
    cfg.color,
    tex,
    [e.style, r2(e.gap), r2(e.y), r2(e.size)].join(","),
  ].join("|");
}

/** The geometry-only part of the key. */
export function formKey(cfg: Pick<AvatarConfig, "shape" | "proportions">): string {
  const p = cfg.proportions;
  return `${cfg.shape}|${[p.width, p.height, p.depth, p.round, p.taper, p.lean].map(r2).join(",")}`;
}

/** A one-line description, for the setup-change card and accessibility. */
export function describeAvatar(cfg: AvatarConfig): string {
  const tex = cfg.texture.kind === "procedural" ? `, ${TEXTURE_LABEL[cfg.texture.id].toLowerCase()}` : cfg.texture.kind === "image" ? ", own image" : "";
  return `${FAMILY[cfg.color].label} ${MATERIAL_LABEL[cfg.material].toLowerCase()} ${SHAPE_LABEL[cfg.shape].toLowerCase()}${tex}`;
}
