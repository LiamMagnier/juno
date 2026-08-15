import process from "node:process";
import { gate, lineAt, swiftSources } from "./check-native-design-lib.mjs";

/*
 * RULE 3 OF THE REWORK BRIEF: everything goes through `junoFont(size:relativeTo:)`
 * or a semantic style. `Font.system(size:)` is banned.
 *
 * This is not a style preference. `Font.system(size:weight:design:)` has no
 * `relativeTo:` overload, so a size passed to it is FROZEN at every accessibility
 * text size — an 11pt gutter number stays 11pt at AX5, and a user who has turned
 * Dynamic Type up gets a screen where the labels grew and the numbers did not.
 * It is the native form of the fixed-`px` bug the web surface already fixed for
 * WCAG 1.4.4.
 *
 * `junoFont(size:relativeTo:)` is a ViewModifier rather than a `Font` factory
 * because `@ScaledMetric(relativeTo:)` — the only mechanism that scales an
 * arbitrary point size — has to live on a `DynamicProperty`. Prefer a named rung
 * (`junoBody()`, `junoCaption()`, `junoCode()`…) and reach for the explicit size
 * only where the number is load-bearing: a code gutter that has to align, a badge
 * that has to fit inside a mark.
 */

// The one file allowed to say it: `JunoScaledFont` is the modifier that turns a
// scaled metric back into a concrete font. Exempting the whole design system
// would be wrong — most of that directory is ordinary UI, and it holds real
// violations of its own.
const EXEMPT = new Set([
  "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoTypography.swift",
]);

// Matches `Font.system(size:`, `.font(.system(size:` and every other spelling,
// because all of them route through the same `.system(size:` fragment.
const FROZEN_FONT = /\.system\(\s*size\s*:/g;

const violations = [];
for (const file of swiftSources()) {
  if (EXEMPT.has(file.path)) continue;
  for (const match of file.code.matchAll(FROZEN_FONT)) {
    violations.push({
      path: file.path,
      line: lineAt(file.code, match.index),
      reason:
        "Font.system(size:) is frozen at every accessibility size — "
        + "use junoFont(size:relativeTo:) or a semantic style",
    });
  }
}

process.exit(
  gate({
    rule: "type",
    headline: "Type must scale.",
    why:
      "  `Font.system(size:)` has no `relativeTo:` overload, so the size is pinned at\n"
      + "  every Dynamic Type setting: an 11pt gutter number is still 11pt at AX5 while\n"
      + "  every semantic style around it has doubled. Replace it with\n"
      + "  `.junoFont(size:relativeTo:)`, picking the text style for the ROLE the text\n"
      + "  plays rather than for a matching default size — or better, with a named rung\n"
      + "  (`junoBody()`, `junoCaption()`, `junoCode()`), which needs no number at all.",
    violations,
  }),
);
