import path from "node:path";
import process from "node:process";
import { enclosingTypeName, gate, lineAt, swiftSources } from "./check-native-design-lib.mjs";

/*
 * RULE 1 OF THE REWORK BRIEF: the chrome is glass; everything you read or act on
 * is opaque.
 *
 * Exactly one Liquid Glass layer per screen — sidebar, toolbar, tab bar, composer
 * — over an OPAQUE content layer. Glass on a transcript row, a diff hunk, a code
 * block, a message bubble, a card or an empty state is a defect, and it is the
 * single most reliable way to make a product look experimental: text sampled
 * through a blur of whatever happens to be behind it has no fixed contrast, so
 * the same paragraph is legible over one background and not over another.
 *
 * At the time this gate was written the tree was clean at 9 of 9 glass sites.
 * That is the reason the gate exists NOW rather than later: it is cheap to hold a
 * property that is already true, and expensive to recover one after four lanes
 * have each added "just one" translucent card.
 *
 * TWO CHECKS.
 *
 *   1. A material or glass call in a file — or inside a type — whose NAME says it
 *      is content. Names are the only evidence available without parsing SwiftUI,
 *      and in this tree they are good evidence: a 1,800-line screen file holds a
 *      dozen row structs and each says what it is.
 *   2. A `.glassEffect` with no `GlassEffectContainer` anywhere in the file. Apple
 *      is explicit that loose glass calls sample independently: they do not blend,
 *      they cannot morph between each other via `glassEffectID`, and they cost
 *      more to render than the same elements grouped. A cluster of loose calls is
 *      how glass ends up looking like several different materials on one bar.
 */

// The primitives that OWN glass. `JunoMaterials` is the fallback ladder
// (`glassEffect` on 26+, `.regularMaterial` below it) and the two chrome files
// are the container helpers themselves — exempting them is not a loophole,
// because every one of their callers is still scanned.
const EXEMPT = new Set([
  "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoMaterials.swift",
  "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoDesktopChrome.swift",
  "native/iOS/JunoMobile/App/JunoMobileChrome.swift",
]);

/*
 * `.thinMaterial` and `.ultraThickMaterial` are on this list even though the
 * brief names only three. Leaving them off would make the rule trivially
 * bypassable by swapping one member of the same enum for another, and every
 * member has the identical problem: sampled contrast on something meant to be
 * read.
 */
const TRANSLUCENCY = [
  [/\.glassEffect\b/g, "Liquid Glass"],
  // The house wrappers. `.junoGlass(…)` IS `.glassEffect` with an OS fallback,
  // so leaving it off would let the rule be sidestepped by using the tidier
  // spelling — which is the spelling the rework will push everyone towards.
  // `\(` rather than `\b` so `.junoGlassID(…)` — which only tags a participant
  // and applies no material — is not caught by it.
  [/\.junoGlass\s*\(/g, "Liquid Glass (via .junoGlass)"],
  [/\.junoFloatingGlass\s*\(/g, "Liquid Glass (via .junoFloatingGlass)"],
  [/\.junoAccentGlass\s*\(/g, "Liquid Glass (via .junoAccentGlass)"],
  [/\.ultraThinMaterial\b/g, "`.ultraThinMaterial`"],
  [/\.thinMaterial\b/g, "`.thinMaterial`"],
  [/\.regularMaterial\b/g, "`.regularMaterial`"],
  [/\.thickMaterial\b/g, "`.thickMaterial`"],
  [/\.ultraThickMaterial\b/g, "`.ultraThickMaterial`"],
];

/** The words that mark an identifier as a thing the user reads, not chrome. */
const CONTENT_MARKERS = new Set([
  "Transcript", "Row", "Card", "Bubble", "Diff", "Review", "EmptyState", "Message",
]);

/*
 * CamelCase tokens, plus adjacent pairs.
 *
 * Token-wise rather than substring, because `Discard` contains `Card` and
 * `DiscardChangesButton` is chrome. The pairs are what let `EmptyState` be one
 * marker instead of matching every `State` in the tree.
 */
function marksContent(identifier) {
  if (!identifier) return null;
  const tokens = identifier.match(/[A-Z][a-z0-9]*|[A-Z]+(?![a-z])/g) ?? [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (CONTENT_MARKERS.has(tokens[i])) return tokens[i];
    if (i + 1 < tokens.length && CONTENT_MARKERS.has(tokens[i] + tokens[i + 1])) {
      return tokens[i] + tokens[i + 1];
    }
  }
  return null;
}

const violations = [];
for (const file of swiftSources()) {
  if (EXEMPT.has(file.path)) continue;
  const basename = path.basename(file.path, ".swift");
  const fileMarker = marksContent(basename);
  /*
   * `JunoGlass` (iOS) and `JunoDesktopGlass` (macOS) ARE the container — each
   * wraps `GlassEffectContainer` with the availability check — and
   * `junoGlassSearchContainer()` is the single-element form. A file that reaches
   * for one of them has grouped its glass, which is the property this half of
   * the rule is actually asking about.
   */
  const hasContainer = /\b(?:GlassEffectContainer|JunoGlass|JunoDesktopGlass)\b|\.junoGlassSearchContainer\b/
    .test(file.code);

  for (const [pattern, label] of TRANSLUCENCY) {
    for (const match of file.code.matchAll(pattern)) {
      const line = lineAt(file.code, match.index);
      const typeName = enclosingTypeName(file.code, match.index);
      const marker = fileMarker ?? marksContent(typeName);
      if (marker) {
        const where = fileMarker ? `${basename}.swift` : typeName;
        violations.push({
          path: file.path,
          line,
          reason:
            `${label} on a content surface — \`${where}\` is a "${marker}", and content `
            + "is opaque; glass belongs to the sidebar, toolbar, tab bar and composer",
        });
        continue;
      }
      if (label.startsWith("Liquid Glass") && !hasContainer) {
        violations.push({
          path: file.path,
          line,
          reason:
            `loose ${label} — no GlassEffectContainer (or JunoGlass/JunoDesktopGlass) in `
            + "this file, so it samples on its own, cannot morph via glassEffectID, and "
            + "costs more to render",
        });
      }
    }
  }
}

violations.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

process.exit(
  gate({
    rule: "glass",
    headline: "Glass is chrome; content is opaque.",
    why:
      "  Text read through a blur has no fixed contrast — the same paragraph is legible\n"
      + "  over one background and not over the next. So the rule is one Liquid Glass\n"
      + "  layer per screen (sidebar, toolbar, tab bar, composer) over an OPAQUE content\n"
      + "  layer. For a row, card, bubble, diff hunk or empty state, use a JunoSurfaces\n"
      + "  fill and a hairline instead.\n"
      + "\n"
      + "  For the loose-glass case: put the cluster inside ONE `GlassEffectContainer`\n"
      + "  and give every participant a `glassEffectID` in a shared namespace. That is\n"
      + "  what makes neighbouring elements sample the same backdrop and morph into each\n"
      + "  other instead of cross-fading. Never cross-fade glass.",
    violations,
  }),
);
