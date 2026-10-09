import path from "node:path";
import process from "node:process";
import { bracedRegions, enclosingTypeName, gate, lineAt, swiftSources } from "./check-native-design-lib.mjs";

/*
 * RULE 1 OF THE REWORK BRIEF: the chrome is glass; everything you read or act on
 * is opaque.
 *
 * The system draws the chrome's glass — the sidebar pane, toolbar item groups,
 * menus, popovers, sheets and alerts. Juno adds Liquid Glass of its own in
 * EXACTLY FIVE places (§0.1 of docs/native/MACOS_LIQUID_GLASS_REDESIGN.md): the
 * composer cluster, the ⌘K / Search panel, the find bar, the toast host and the
 * Quick Entry panel. Glass on a transcript row, a diff hunk, a code block, a
 * message bubble, a card or an empty state is a defect, and it is the single
 * most reliable way to make a product look experimental: text sampled through a
 * blur of whatever happens to be behind it has no fixed contrast, so the same
 * paragraph is legible over one background and not over another.
 *
 * FOUR CHECKS.
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
 *   3. Custom Liquid Glass in a file shipped to the Mac that is not one of the
 *      five allow-listed sites (§8.7). This is the check that catches a glass
 *      button on a page, a glass pill in a toolbar item, a glass capsule on a
 *      dictation bar — each "just one", and together the reason the old composer
 *      read as five materials on one row. The phone app is out of scope here: it
 *      has its own chrome (`JunoMobileChrome`), and checks 1 and 2 still hold it.
 *   4. Glass inside `.sheet` or `.popover` content, anywhere. Both are system
 *      glass on macOS 26; glass drawn inside them is glass on glass.
 *
 * Checks 3 and 4 were added with the redesign and start from a recorded
 * baseline: the sites they find today are the migration's to-do list, and the
 * ratchet makes sure the list only ever gets shorter.
 */

// The primitives that OWN glass: `JunoMaterials` and the two chrome files are
// the modifiers and containers themselves. Exempting them is not a loophole,
// because every one of their callers is still scanned — and the callers are
// where a glass surface is actually decided.
//
// `JunoGlassControls.swift` joined in Mac round 3 (2026-10-09), on the owner's
// own instruction: every button, segmented selector, menu trigger and search
// field on the Mac is a native Liquid Glass capsule. Pages reach that glass
// only through the controls (`.junoGlass`, `.junoProminent`, `JunoSegmented`,
// `.junoGlassMenu`, `JunoPageSearchField`), never a `.glassEffect` of their
// own — content surfaces stay opaque, and checks 1–4 still hold every caller.
const EXEMPT = new Set([
  "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoMaterials.swift",
  "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoGlassControls.swift",
  "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoDesktopChrome.swift",
  "native/iOS/JunoMobile/App/JunoMobileChrome.swift",
]);

/*
 * The places Juno draws glass of its own (§0.1, §8.7): the five chrome sites,
 * plus the transcript's Scroll to latest circle, which the Phase 2 brief
 * (§1, §6.7) allow-lists beside the find bar. Matched by file name rather than
 * path so a site can move between the design system and the app without
 * editing this list — and so another file cannot join it by living in the
 * right directory.
 */
const GLASS_SITES = new Set([
  "JunoComposerShell.swift",
  "DesktopSearchPanel.swift",
  "DesktopFindBar.swift",
  "ScrollToLatestButton.swift",
  "JunoToastHost.swift",
  "DesktopQuickEntry.swift",
]);

/** Files that ship to the Mac, which is what the allow-list governs. */
function shipsToMac(filePath) {
  return filePath.startsWith("native/macOS/") || filePath.startsWith("native/Packages/");
}

/*
 * `.thinMaterial` and `.ultraThickMaterial` are on this list even though the
 * brief names only three. Leaving them off would make the rule trivially
 * bypassable by swapping one member of the same enum for another, and every
 * member has the identical problem: sampled contrast on something meant to be
 * read.
 */
const MATERIALS = [
  [/\.ultraThinMaterial\b/g, "`.ultraThinMaterial`"],
  [/\.thinMaterial\b/g, "`.thinMaterial`"],
  [/\.regularMaterial\b/g, "`.regularMaterial`"],
  [/\.thickMaterial\b/g, "`.thickMaterial`"],
  [/\.ultraThickMaterial\b/g, "`.ultraThickMaterial`"],
];

/*
 * Every spelling of Liquid Glass in this tree: the SDK's own and the house
 * wrappers. A wrapper left off the list is a way round the rule, and the tidier
 * spelling is the one the rework pushes everyone towards.
 *
 * `\(` rather than `\b` after the house names, so `.junoGlassID(…)` — which only
 * tags a participant and applies no material — is not caught by `.junoGlass(`.
 */
const GLASS = [
  [/\.glassEffect\b/g, "Liquid Glass"],
  [/\.junoGlass\s*\(/g, "Liquid Glass (via .junoGlass)"],
  [/\.junoFloatingGlass\s*\(/g, "Liquid Glass (via .junoFloatingGlass)"],
  [/\.junoAccentGlass\s*\(/g, "Liquid Glass (via .junoAccentGlass)"],
  [/\.junoFloatingChrome\s*\(/g, "Liquid Glass (via .junoFloatingChrome)"],
  [/\.junoGlassButton\s*\(/g, "Liquid Glass (via .junoGlassButton)"],
  [/\.junoProminentGlassButton\s*\(/g, "Liquid Glass (via .junoProminentGlassButton)"],
  [/\.junoProminentAction\s*\(/g, "Liquid Glass (via .junoProminentAction)"],
  [/buttonStyle\(\s*\.glass/g, "a glass button style"],
  [/\.glassProminent\b/g, "`.glassProminent`"],
  [/\bJunoGlassBackground\s*\(/g, "Liquid Glass (via JunoGlassBackground)"],
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

/*
 * A presentation's content: the braces opened on a `.sheet(` or `.popover(`
 * line. Brace counting on blanked source, so a sheet whose content is a named
 * view defined elsewhere is not seen here — that view's own file is scanned by
 * checks 1–3 in its own right.
 */
const PRESENTATION = /\.(?:sheet|popover)\s*\(/;

/*
 * One violation per line. A `.buttonStyle(.glassProminent)` on a content row
 * inside a popover trips three patterns and all four checks; counting it more
 * than once would make the baseline a number nobody can reconcile against the
 * code. The first reason recorded for a line is the most specific one, so
 * checks run most-specific first.
 */
const byLine = new Map();
function report(filePath, line, reason) {
  const key = `${filePath}:${line}`;
  if (!byLine.has(key)) byLine.set(key, { path: filePath, line, reason });
}

for (const file of swiftSources()) {
  if (EXEMPT.has(file.path)) continue;
  const basename = path.basename(file.path, ".swift");
  const fileMarker = marksContent(basename);
  const isGlassSite = GLASS_SITES.has(path.basename(file.path));
  const presentations = bracedRegions(file.lines, PRESENTATION);
  const insidePresentation = (line) =>
    presentations.some((region) => line > region.startLine && line <= region.endLine);
  /*
   * `JunoGlass` (iOS) and `JunoDesktopGlass` (macOS) ARE the container — each
   * wraps `GlassEffectContainer` — and `junoGlassSearchContainer()` is the
   * single-element form. A file that reaches for one of them has grouped its
   * glass, which is the property check 2 is actually asking about.
   */
  const hasContainer = /\b(?:GlassEffectContainer|JunoGlass|JunoDesktopGlass)\b|\.junoGlassSearchContainer\b/
    .test(file.code);

  const patterns = [
    ...GLASS.map(([pattern, label]) => ({ pattern, label, isGlass: true })),
    ...MATERIALS.map(([pattern, label]) => ({ pattern, label, isGlass: false })),
  ];
  for (const { pattern, label, isGlass } of patterns) {
    for (const match of file.code.matchAll(pattern)) {
      const line = lineAt(file.code, match.index);
      const typeName = enclosingTypeName(file.code, match.index);
      const marker = fileMarker ?? marksContent(typeName);

      // 1 — translucency on a surface whose name says it is content.
      if (marker) {
        const where = fileMarker ? `${basename}.swift` : typeName;
        report(
          file.path,
          line,
          `${label} on a content surface — \`${where}\` is a "${marker}", and content `
            + "is opaque; glass belongs to the system chrome and the five glass sites",
        );
        continue;
      }

      // 4 — glass on glass: a system sheet or popover already is glass.
      if (isGlass && insidePresentation(line)) {
        report(
          file.path,
          line,
          `${label} inside a .sheet or .popover — both are system glass on macOS 26, `
            + "so this is glass on glass; a presentation's content is opaque",
        );
        continue;
      }

      // 3 — custom glass outside the five sites.
      if (isGlass && shipsToMac(file.path) && !isGlassSite) {
        report(
          file.path,
          line,
          `${label} outside the five glass sites — Juno draws glass only in the composer `
            + "cluster, the Search panel, the find bar, the toast host and Quick Entry (§0.1)",
        );
        continue;
      }

      // 2 — loose glass that samples on its own.
      if (isGlass && label.startsWith("Liquid Glass") && !hasContainer) {
        report(
          file.path,
          line,
          `loose ${label} — no GlassEffectContainer (or JunoGlass/JunoDesktopGlass) in `
            + "this file, so it samples on its own, cannot morph via glassEffectID, and "
            + "costs more to render",
        );
      }
    }
  }
}

const violations = [...byLine.values()]
  .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

process.exit(
  gate({
    rule: "glass",
    headline: "Glass is chrome; content is opaque.",
    why:
      "  Text read through a blur has no fixed contrast — the same paragraph is legible\n"
      + "  over one background and not over the next. So the system draws the chrome's\n"
      + "  glass (sidebar, toolbar, menus, popovers, sheets), Juno adds glass only in the\n"
      + "  five allow-listed sites (JunoComposerShell, DesktopSearchPanel, DesktopFindBar,\n"
      + "  JunoToastHost, DesktopQuickEntry), and everything else is OPAQUE. For a row,\n"
      + "  card, bubble, control or empty state, use a JunoSurfaces fill and a hairline;\n"
      + "  inside a sheet or popover, use nothing — the presentation is already glass.\n"
      + "\n"
      + "  For the loose-glass case: put the cluster inside ONE `GlassEffectContainer`\n"
      + "  and give every participant a `glassEffectID` in a shared namespace. That is\n"
      + "  what makes neighbouring elements sample the same backdrop and morph into each\n"
      + "  other instead of cross-fading. Never cross-fade glass.",
    violations,
  }),
);
