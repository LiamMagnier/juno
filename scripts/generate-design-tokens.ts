/**
 * Project the web's design tokens onto every other client.
 *
 * `src/app/globals.css` is the source of truth for colour, and
 * `tailwind.config.ts` for the radius, type and spacing ladders. Both are
 * hand-authored, both are heavily commented, and neither is going to be
 * generated from something else —
 * the comments beside those values are the most useful documentation in the
 * repository and a generator would flatten them.
 *
 * What was NOT true is that anything kept the other clients honest.
 * `JunoDesignTokens.swift` opens by saying its values are "converted from the
 * web's own custom properties in src/app/globals.css so the two platforms
 * cannot drift" — but the conversion was done by hand, once, and nothing has
 * re-checked it since. That comment described an intention, not a mechanism.
 *
 * This is the mechanism. It parses the CSS, redoes the HSL -> sRGB conversion
 * exactly, and emits the Swift and TypeScript projections. `--check` re-derives
 * them and exits non-zero on any difference, so drift fails CI instead of
 * failing on a user's Mac.
 *
 *   npx tsx scripts/generate-design-tokens.ts           # write
 *   npx tsx scripts/generate-design-tokens.ts --check   # verify, exit 1 on drift
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

import defaultTheme from "tailwindcss/defaultTheme";

import tailwindConfig from "../tailwind.config";

const CSS_PATH = resolve(process.cwd(), "src/app/globals.css");
const SWIFT_OUT = resolve(
  process.cwd(),
  "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/Generated/JunoGeneratedTokens.swift"
);
const TS_OUT = resolve(process.cwd(), "src/lib/design/tokens.generated.ts");

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `54 18% 97%` or `48 12% 18% / 0.06`. */
const HSL = /^(-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+))?$/;
const DURATION = /^([\d.]+)ms$/;
const CUBIC = /^cubic-bezier\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)$/;

type Block = { selector: string; decls: Map<string, string> };

/**
 * `@layer` is transparent — it groups without changing when a rule applies, so
 * a `:root` inside it is the same `:root`. Every other at-rule is CONDITIONAL,
 * and a `:root` inside one is a different set of values that only sometimes
 * applies.
 *
 * This distinction is the whole reason this is a real parser and not a regex.
 * globals.css declares `--ease-out-strong`, `--ease-out-expo` and `--dur-slow`
 * a second time inside `@media (prefers-reduced-motion: reduce)`, flattening
 * them onto softer curves. A flat scan merges those over the base values and
 * silently drops all three from the output — which is exactly the kind of
 * quiet, plausible-looking wrongness a generator exists to prevent.
 */
const TRANSPARENT_AT_RULE = /^@layer\b/;

/** Walk brace depth, tracking the at-rule chain each block sits inside. */
function parseBlocks(css: string): Block[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const blocks: Block[] = [];
  const stack: string[] = [];
  let buffer = "";

  const flushDecls = () => {
    const prelude = stack[stack.length - 1];
    if (prelude === undefined || prelude.startsWith("@")) return;
    // Unconditional only: every enclosing at-rule must be transparent.
    const conditional = stack
      .slice(0, -1)
      .some((p) => p.startsWith("@") && !TRANSPARENT_AT_RULE.test(p));
    if (conditional) return;

    const decls = new Map<string, string>();
    for (const raw of buffer.split(";")) {
      const i = raw.indexOf(":");
      if (i === -1) continue;
      const name = raw.slice(0, i).trim();
      if (!name.startsWith("--")) continue;
      decls.set(name.slice(2), raw.slice(i + 1).trim());
    }
    if (decls.size) blocks.push({ selector: prelude, decls });
  };

  for (const ch of stripped) {
    if (ch === "{") {
      stack.push(buffer.trim().replace(/\s+/g, " "));
      buffer = "";
    } else if (ch === "}") {
      flushDecls();
      stack.pop();
      buffer = "";
    } else {
      buffer += ch;
    }
  }
  return blocks;
}

function declsFor(blocks: Block[], selector: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const b of blocks) {
    if (b.selector !== selector) continue;
    for (const [k, v] of b.decls) merged.set(k, v);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

type Rgba = { r: number; g: number; b: number; a: number };

/** CSS Color Level 3 HSL -> sRGB. Same maths the browser runs. */
function hslToRgb(h: number, s: number, l: number, a: number): Rgba {
  const S = s / 100;
  const L = l / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const m = L - c / 2;
  const round = (v: number) => Math.round((v + m) * 1e4) / 1e4;
  return { r: round(r1), g: round(g1), b: round(b1), a };
}

function asColor(value: string): Rgba | null {
  const m = HSL.exec(value);
  if (!m) return null;
  return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4]));
}

const css = readFileSync(CSS_PATH, "utf8");
const blocks = parseBlocks(css);

const rootDecls = declsFor(blocks, ":root");
const darkDecls = declsFor(blocks, ".dark");

if (rootDecls.size === 0) throw new Error("No :root token block found in globals.css");
if (darkDecls.size === 0) throw new Error("No .dark token block found in globals.css");

/** Every token that resolves to a colour in BOTH themes (dark falls back to light). */
const colorNames = [...rootDecls.keys()]
  .filter((name) => asColor(rootDecls.get(name)!) !== null)
  .sort();

const colors = colorNames.map((name) => {
  const light = asColor(rootDecls.get(name)!)!;
  const darkRaw = darkDecls.get(name);
  return {
    name,
    light,
    dark: darkRaw ? (asColor(darkRaw) ?? light) : light,
    inherited: darkRaw === undefined,
  };
});

const ACCENTS = ["coral", "juniper", "teal", "violet", "amber", "sage"] as const;
const ACCENT_TOKENS = ["primary", "ring", "primary-foreground", "primary-ink"] as const;

const accents = ACCENTS.map((accent) => {
  const light = declsFor(blocks, `:root[data-accent="${accent}"]`);
  const dark = declsFor(blocks, `.dark[data-accent="${accent}"]`);
  if (light.size === 0) throw new Error(`Accent "${accent}" has no :root[data-accent] block`);
  if (dark.size === 0) throw new Error(`Accent "${accent}" has no .dark[data-accent] block`);
  const pick = (from: Map<string, string>, token: string) => {
    const raw = from.get(token);
    if (!raw) throw new Error(`Accent "${accent}" is missing --${token}`);
    const rgba = asColor(raw);
    if (!rgba) throw new Error(`Accent "${accent}" --${token} is not an HSL triple: ${raw}`);
    return rgba;
  };
  return {
    accent,
    light: Object.fromEntries(ACCENT_TOKENS.map((t) => [t, pick(light, t)])),
    dark: Object.fromEntries(ACCENT_TOKENS.map((t) => [t, pick(dark, t)])),
  };
});

// ---------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------

const durations = [...rootDecls.entries()]
  .filter(([name, v]) => name.startsWith("dur-") && DURATION.test(v))
  .map(([name, v]) => ({ name: name.slice(4), ms: Number(DURATION.exec(v)![1]) }))
  .sort((a, b) => a.ms - b.ms);

const easings = [...rootDecls.entries()]
  .filter(([name, v]) => name.startsWith("ease-") && CUBIC.test(v))
  .map(([name, v]) => {
    const m = CUBIC.exec(v)!;
    return {
      name: name.slice(5),
      points: [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])] as const,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

if (!durations.length) throw new Error("No --dur-* tokens found");
if (!easings.length) throw new Error("No --ease-* tokens found");

// ---------------------------------------------------------------------------
// Radius (from the Tailwind config, which is where the ladder is declared)
// ---------------------------------------------------------------------------

const rawRadius = (tailwindConfig.theme?.extend?.borderRadius ?? {}) as Record<string, string>;
const radii = Object.entries(rawRadius)
  .map(([name, value]) => ({ name, value }))
  .filter(({ value }) => /^\d+px$/.test(value))
  .map(({ name, value }) => ({ name, px: Number(value.replace("px", "")) }))
  .sort((a, b) => a.px - b.px);

if (!radii.length) throw new Error("No px radii found in tailwind.config.ts");

// ---------------------------------------------------------------------------
// Type (from the Tailwind config's `fontSize` ladder)
// ---------------------------------------------------------------------------

/**
 * The ladder is written in rem (16px) with one of two shapes:
 *
 *   "1.375rem"                                   a fixed rung
 *   "clamp(1.625rem, 1rem + 1.5625cqi, 2rem)"    a fluid rung, keyed to the
 *                                                content column (`cqi`), or to
 *                                                the window (`vw`) for `hero`
 *
 * Both are projected to points (the web's px, 1:1) and the fluid term is kept
 * as `intercept + slope × width` so a native column can land on exactly the
 * size the web's column would at the same width. Anything else is a hard
 * error: a rung the parser cannot read would otherwise vanish from the Swift
 * ladder with every check still green.
 */
const REM = /^([\d.]+)rem$/;
const CLAMP = /^clamp\(\s*([\d.]+)rem\s*,\s*([\d.]+)rem\s*\+\s*([\d.]+)(cqi|vw)\s*,\s*([\d.]+)rem\s*\)$/;
const EM = /^(-?[\d.]+)em$/;

type TypeRung = {
  name: string;
  minSize: number;
  maxSize: number;
  intercept: number;
  slope: number;
  lineHeight: number;
  tracking: number;
  weight: number | null;
};

type FontSizeMeta = { lineHeight?: string; letterSpacing?: string; fontWeight?: string };

const rawFontSize = (tailwindConfig.theme?.extend?.fontSize ?? {}) as Record<
  string,
  string | [string, FontSizeMeta]
>;

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

const typeRungs: TypeRung[] = Object.entries(rawFontSize).map(([name, value]) => {
  const [size, meta]: [string, FontSizeMeta] = Array.isArray(value) ? value : [value, {}];
  let minSize: number;
  let maxSize: number;
  let intercept: number;
  let slope: number;
  const fixed = REM.exec(size);
  const fluid = CLAMP.exec(size);
  if (fixed) {
    minSize = maxSize = intercept = Number(fixed[1]) * 16;
    slope = 0;
  } else if (fluid) {
    minSize = Number(fluid[1]) * 16;
    intercept = Number(fluid[2]) * 16;
    // `1cqi` is 1% of the container's inline size, so the per-point slope is
    // the coefficient over 100 — the same for `vw` against the window.
    slope = Number(fluid[3]) / 100;
    maxSize = Number(fluid[5]) * 16;
  } else {
    throw new Error(`fontSize "${name}" is neither a rem size nor a rem clamp: ${size}`);
  }
  // Unitless, as CSS means it: a multiple of the size. A fixed rung may also
  // state its line in rem (`nav`: 14px on a 20px line, because every use sits
  // centred in a fixed-height row); at its one size that is one multiple, so it
  // is projected as that. A fluid rung's rem line would be a different multiple
  // at every width, which the native ladder cannot say, so it stays an error.
  const remLine = meta.lineHeight === undefined ? null : REM.exec(meta.lineHeight);
  let lineHeight = meta.lineHeight === undefined ? NaN : Number(meta.lineHeight);
  if (remLine) lineHeight = fixed ? Math.round(((Number(remLine[1]) * 16) / minSize) * 1e6) / 1e6 : NaN;
  if (!Number.isFinite(lineHeight)) {
    throw new Error(`fontSize "${name}" has no unitless lineHeight (or rem, on a fixed size): ${meta.lineHeight}`);
  }
  let tracking = 0;
  if (meta.letterSpacing !== undefined) {
    const em = EM.exec(meta.letterSpacing);
    if (!em) throw new Error(`fontSize "${name}" letterSpacing is not in em: ${meta.letterSpacing}`);
    tracking = Number(em[1]);
  }
  const weight = meta.fontWeight === undefined ? null : Number(meta.fontWeight);
  return {
    name,
    minSize: round4(minSize),
    maxSize: round4(maxSize),
    intercept: round4(intercept),
    // Six places rather than four: the slope is multiplied by a column width
    // in the hundreds, so a fourth-place rounding lands a fluid rung a few
    // hundredths of a point off the web's size at the anchor widths.
    slope: Math.round(slope * 1e6) / 1e6,
    lineHeight,
    tracking,
    weight,
  };
});

if (!typeRungs.length) throw new Error("No fontSize ladder found in tailwind.config.ts");

// ---------------------------------------------------------------------------
// Spacing (Tailwind's default scale, plus the config's own `4.5` step)
// ---------------------------------------------------------------------------

/**
 * The steps a native surface is allowed to use. Tailwind's scale runs to 96
 * and has a `px` and a `0`; the native ladder is the web's 4pt grid from 2 to
 * 48 plus the 18 the config adds, which is every gap the app shell and the
 * chat surfaces actually spend. Listed by utility suffix, so `gap-3` on the
 * web reads as `step3` in Swift. A step the theme stops defining is a hard
 * error rather than a silently shorter ladder.
 */
const SPACE_STEPS = ["0.5", "1", "1.5", "2", "2.5", "3", "3.5", "4", "4.5", "5", "6", "7", "8", "10", "12"];

const rawSpacing: Record<string, string> = {
  ...(defaultTheme.spacing as Record<string, string>),
  ...((tailwindConfig.theme?.extend?.spacing ?? {}) as Record<string, string>),
};

const spaceSteps = SPACE_STEPS.map((key) => {
  const raw = rawSpacing[key];
  const rem = raw === undefined ? null : REM.exec(raw);
  if (!rem) throw new Error(`spacing "${key}" is missing or not in rem: ${raw}`);
  return { key, px: round4(Number(rem[1]) * 16) };
});

// ---------------------------------------------------------------------------
// Emit
// ---------------------------------------------------------------------------

/**
 * Over the projected values only, the numbers the clients actually receive. It
 * used to hash the whole of globals.css, so a comment, a reflowed line or a
 * rule that declares no token failed `--check` with nothing for a client to
 * pick up. Now the digest moves exactly when a generated value does.
 */
const digest = createHash("sha256")
  .update(JSON.stringify({ colors, accents, durations, easings, radii, typeRungs, spaceSteps }))
  .digest("hex")
  .slice(0, 16);

const camel = (s: string) =>
  s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase()).replace(/^([A-Z])/, (c) => c.toLowerCase());

/**
 * Swift keywords a token name can realistically collide with. `--ease-in`
 * produces `in`, which is a hard parse error rather than a warning, so this is
 * escaped at emit time rather than by renaming the CSS token — the CSS name is
 * the one users of the design system read.
 */
const SWIFT_KEYWORDS = new Set([
  "in", "is", "as", "any", "some", "self", "super", "default", "case", "class", "struct",
  "enum", "protocol", "extension", "func", "let", "var", "if", "else", "for", "while",
  "repeat", "switch", "break", "continue", "fallthrough", "return", "throw", "throws",
  "try", "catch", "defer", "guard", "where", "init", "deinit", "subscript", "operator",
  "import", "typealias", "associatedtype", "inout", "internal", "private", "fileprivate",
  "public", "open", "static", "final", "lazy", "weak", "unowned", "true", "false", "nil",
]);

/** Swift identifier for a token name, backticked when it collides with a keyword. */
const swiftName = (s: string) => {
  const name = camel(s);
  return SWIFT_KEYWORDS.has(name) ? `\`${name}\`` : name;
};

const f = (n: number) => (Number.isInteger(n) ? n.toFixed(1) : String(n));

const BANNER = (tool: string) => `// Generated by scripts/generate-design-tokens.ts — DO NOT EDIT.
//
// Source: src/app/globals.css (colour, motion) + tailwind.config.ts (radius,
// type, spacing). Regenerate with \`npm run design:tokens\`; \`npm run design:tokens:check\`
// fails CI when this file no longer matches its sources.
//
// tokens-digest: ${digest}
${tool}`;

// ---- Swift ---------------------------------------------------------------

function swiftColor(c: Rgba): string {
  return `JunoColorToken(unchecked: ${f(c.r)}, ${f(c.g)}, ${f(c.b)}${c.a === 1 ? "" : `, ${f(c.a)}`})`;
}

const swiftColorCases = colors
  .map(({ name, light, dark, inherited }) => {
    const note = inherited ? "  // no .dark override; light value applies to both" : "";
    return `    /// \`--${name}\`${note}
    public static let ${swiftName(name)} = JunoGeneratedPair(
        light: ${swiftColor(light)},
        dark: ${swiftColor(dark)}
    )`;
  })
  .join("\n\n");

const swiftAccentCases = accents
  .map(
    ({ accent, light, dark }) => `        case .${accent}:
            JunoGeneratedAccentPalette(
                primary: JunoGeneratedPair(light: ${swiftColor(light.primary)}, dark: ${swiftColor(dark.primary)}),
                ring: JunoGeneratedPair(light: ${swiftColor(light.ring)}, dark: ${swiftColor(dark.ring)}),
                onPrimary: JunoGeneratedPair(light: ${swiftColor(light["primary-foreground"])}, dark: ${swiftColor(dark["primary-foreground"])}),
                ink: JunoGeneratedPair(light: ${swiftColor(light["primary-ink"])}, dark: ${swiftColor(dark["primary-ink"])})
            )`
  )
  .join("\n");

const swift = `${BANNER("//")}

import CoreGraphics
import Foundation

/// A token that resolves differently per colour scheme. Both halves are always
/// present: a single value that "works in both" is how the two themes drift.
public struct JunoGeneratedPair: Hashable, Sendable {
    public let light: JunoColorToken
    public let dark: JunoColorToken

    public init(light: JunoColorToken, dark: JunoColorToken) {
        self.light = light
        self.dark = dark
    }

    public func resolve(dark isDark: Bool) -> JunoColorToken { isDark ? dark : light }
}

/// The four values an accent overrides. Mirrors the \`[data-accent]\` blocks.
public struct JunoGeneratedAccentPalette: Hashable, Sendable {
    public let primary: JunoGeneratedPair
    public let ring: JunoGeneratedPair
    public let onPrimary: JunoGeneratedPair
    public let ink: JunoGeneratedPair
}

/// Every colour custom property declared on \`:root\`, with its \`.dark\` override.
public enum JunoGeneratedColors {
${swiftColorCases}
}

public extension JunoAccent {
    /// The generated palette for this accent, projected from globals.css.
    var generatedPalette: JunoGeneratedAccentPalette {
        switch self {
${swiftAccentCases}
        }
    }
}

/// \`--dur-*\`, in seconds (SwiftUI's unit), sorted fastest first.
public enum JunoGeneratedDuration {
${durations.map((d) => `    /// \`--dur-${d.name}: ${d.ms}ms\`\n    public static let ${swiftName(d.name)}: TimeInterval = ${d.ms / 1000}`).join("\n")}
}

/// \`--ease-*\` as raw cubic-bezier control points, so a client can build the
/// platform curve of its choice (CAMediaTimingFunction, a SwiftUI timing curve,
/// or a hand-rolled solver) from the same four numbers the browser uses.
public enum JunoGeneratedEasing {
${easings
  .map(
    (e) =>
      `    /// \`--ease-${e.name}\`\n    public static let ${swiftName(e.name)}: (x1: CGFloat, y1: CGFloat, x2: CGFloat, y2: CGFloat) = (${e.points.map((p) => f(p)).join(", ")})`
  )
  .join("\n")}
}

/// The radius ladder, in points.
public enum JunoGeneratedRadius {
${radii.map((r) => `    public static let ${swiftName(r.name)}: CGFloat = ${f(r.px)}`).join("\n")}
}

/// One rung of the web's type ladder (\`tailwind.config.ts\` → \`fontSize\`), in
/// points: the web's px, 1:1.
///
/// A fixed rung has \`minSize == maxSize\` and a zero \`fluidSlope\`. A fluid rung
/// is \`clamp(minSize, fluidIntercept + fluidSlope × width, maxSize)\`, where
/// \`width\` is the content column in points — the web's \`cqi\` container (or the
/// window, \`vw\`, for the one marketing rung).
public struct JunoGeneratedTypeRung: Hashable, Sendable {
    public let minSize: CGFloat
    public let maxSize: CGFloat
    public let fluidIntercept: CGFloat
    public let fluidSlope: CGFloat
    /// Unitless, as in CSS: a multiple of the font size.
    public let lineHeight: CGFloat
    /// In em, as in CSS; multiply by the size for points.
    public let tracking: CGFloat
    /// The CSS numeric weight, or nil where the rung leaves weight to the caller (400).
    public let weight: Int?
}

/// The type ladder, in the config's order.
public enum JunoGeneratedType {
${typeRungs
  .map(
    (t) =>
      `    /// \`text-${t.name}\`\n    public static let ${swiftName(t.name)} = JunoGeneratedTypeRung(minSize: ${f(t.minSize)}, maxSize: ${f(t.maxSize)}, fluidIntercept: ${f(t.intercept)}, fluidSlope: ${f(t.slope)}, lineHeight: ${f(t.lineHeight)}, tracking: ${f(t.tracking)}, weight: ${t.weight === null ? "nil" : t.weight})`
  )
  .join("\n")}
}

/// The spacing steps native surfaces may use, in points, named for the
/// Tailwind utility suffix they come from: \`step3\` is \`p-3\` / \`gap-3\`.
public enum JunoGeneratedSpace {
${spaceSteps.map((s) => `    /// \`${s.key}\`\n    public static let step${s.key.replace(".", "_")}: CGFloat = ${f(s.px)}`).join("\n")}

    /// Every step, smallest first.
    public static let all: [CGFloat] = [${spaceSteps.map((s) => f(s.px)).join(", ")}]
}
`;

// ---- TypeScript ----------------------------------------------------------

const ts = `${BANNER("//")}

/** \`--dur-*\` in milliseconds. */
export const DURATION = {
${durations.map((d) => `  ${camel(d.name)}: ${d.ms},`).join("\n")}
} as const;

/** \`--ease-*\` as cubic-bezier control points. */
export const EASING = {
${easings.map((e) => `  ${camel(e.name)}: [${e.points.join(", ")}] as const,`).join("\n")}
} as const;

/** The radius ladder, in pixels. */
export const RADIUS = {
${radii.map((r) => `  ${JSON.stringify(camel(r.name))}: ${r.px},`).join("\n")}
} as const;

export type DurationToken = keyof typeof DURATION;
export type EasingToken = keyof typeof EASING;
export type RadiusToken = keyof typeof RADIUS;
`;

// ---------------------------------------------------------------------------
// Write or check
// ---------------------------------------------------------------------------

const outputs: Array<[string, string]> = [
  [SWIFT_OUT, swift],
  [TS_OUT, ts],
];

/**
 * `--check` compares everything but the digest line.
 *
 * The digest hashes globals.css wholesale, so an edit this projection never
 * reads — a comment, a component rule, a token under another prefix — moves
 * it. Checking it byte for byte made every such edit a native change: the
 * Swift file had to be regenerated by someone allowed to touch `native/`, or
 * CI failed on a file whose projected values had not changed at all. Every
 * colour, duration, easing and radius is still compared exactly; the digest is
 * refreshed the next time the files are written.
 */
const withoutDigest = (text: string) => text.replace(/^\/\/ tokens-digest: [0-9a-f]+$/m, "");

if (process.argv.includes("--check")) {
  let drifted = false;
  for (const [path, expected] of outputs) {
    let actual: string | null = null;
    try {
      actual = readFileSync(path, "utf8");
    } catch {
      console.error(`[design-tokens] MISSING ${path}`);
      drifted = true;
      continue;
    }
    if (withoutDigest(actual) !== withoutDigest(expected)) {
      console.error(`[design-tokens] DRIFT   ${path}`);
      drifted = true;
    }
  }
  if (drifted) {
    console.error("\n[design-tokens] A client no longer matches globals.css. Run: npm run design:tokens");
    process.exit(1);
  }
  console.log(
    `[design-tokens] up to date — ${colorNames.length} colours, ${accents.length} accents, ` +
      `${durations.length} durations, ${easings.length} easings, ${radii.length} radii, ` +
      `${typeRungs.length} type rungs, ${spaceSteps.length} spacing steps (digest ${digest})`
  );
} else {
  for (const [path, contents] of outputs) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    console.log(`[design-tokens] wrote ${path}`);
  }
  console.log(
    `[design-tokens] ${colorNames.length} colours, ${accents.length} accents, ` +
      `${durations.length} durations, ${easings.length} easings, ${radii.length} radii, ` +
      `${typeRungs.length} type rungs, ${spaceSteps.length} spacing steps (digest ${digest})`
  );
}
