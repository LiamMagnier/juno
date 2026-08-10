/**
 * Project the web's design tokens onto every other client.
 *
 * `src/app/globals.css` is the source of truth for colour, and
 * `tailwind.config.ts` for the radius ladder. Both are hand-authored, both are
 * heavily commented, and neither is going to be generated from something else —
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
// Emit
// ---------------------------------------------------------------------------

const digest = createHash("sha256")
  .update(readFileSync(CSS_PATH))
  .update(JSON.stringify(rawRadius))
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
// Source: src/app/globals.css (colour, motion) + tailwind.config.ts (radius).
// Regenerate with \`npm run design:tokens\`; \`npm run design:tokens:check\`
// fails CI when this file no longer matches its sources.
//
// tokens-digest: ${digest}
${tool}`;

// ---- Swift ---------------------------------------------------------------

function swiftColor(c: Rgba): string {
  return `JunoColorToken(unchecked: ${f(c.r)}, ${f(c.g)}, ${f(c.b)}${c.a === 1 ? "" : `, ${f(c.a)}`})`;
}

const swiftColorCases = colorNames
  .map((name) => {
    const light = asColor(rootDecls.get(name)!)!;
    const darkRaw = darkDecls.get(name);
    const dark = darkRaw ? (asColor(darkRaw) ?? light) : light;
    const inherited = darkRaw === undefined ? "  // no .dark override; light value applies to both" : "";
    return `    /// \`--${name}\`${inherited}
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
    if (actual !== expected) {
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
      `${durations.length} durations, ${easings.length} easings, ${radii.length} radii (digest ${digest})`
  );
} else {
  for (const [path, contents] of outputs) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    console.log(`[design-tokens] wrote ${path}`);
  }
  console.log(
    `[design-tokens] ${colorNames.length} colours, ${accents.length} accents, ` +
      `${durations.length} durations, ${easings.length} easings, ${radii.length} radii (digest ${digest})`
  );
}
