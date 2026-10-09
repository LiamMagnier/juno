import process from "node:process";
import { gate, lineAt, swiftSources } from "./check-native-design-lib.mjs";

/*
 * THE MAC DRAWS THE WEBSITE'S ICONS, NEVER SF SYMBOLS (owner, Oct 2026;
 * docs/native/ICON_MIGRATION_MAC.md).
 *
 * Every glyph the Mac app supplies is the web's own drawing, shipped by
 * `scripts/generate-native-icons.mjs` and drawn through `JunoIconView`,
 * `JunoSymbol` or `Image(JunoIcon.x.assetName)`. `Image(systemName:)`,
 * `Label(_, systemImage:)` and `systemImage:` arguments put Apple's drawings
 * beside the web's, at a different weight and optical size, and the column
 * stops reading as one set.
 *
 * The exceptions are glyphs the SYSTEM draws or that never reach a Mac
 * screen, listed below with the reason; everything else ratchets: the gate
 * fails when a file that ships to the Mac gains a use.
 */

const EXEMPT = new Map([
  // The SF-name → JunoIcon translation table itself.
  ["native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoBrand.swift", "translation table"],
  // App Shortcuts: the Shortcuts app and Spotlight draw this, and they only take SF names.
  ["native/macOS/JunoDesktop/App/JunoCodeIntents.swift", "system-drawn (App Intents)"],
  // String properties a model carries for the iPhone; nothing on the Mac draws them.
  ["native/Packages/JunoNativeKit/Sources/JunoCore/JunoRecentActivity.swift", "data, not drawn on the Mac"],
  ["native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoModelCatalog.swift", "data, not drawn on the Mac"],
]);

/** Files that ship to the Mac, excluding tests. */
function shipsToMac(filePath) {
  if (filePath.includes("/Tests/") || filePath.includes("/UITests/")) return false;
  return filePath.startsWith("native/macOS/") || filePath.startsWith("native/Packages/");
}

const RAW = /Image\(systemName:|systemImage:|systemName:/g;

const violations = [];
for (const file of swiftSources()) {
  if (EXEMPT.has(file.path) || !shipsToMac(file.path)) continue;
  for (const match of file.code.matchAll(RAW)) {
    violations.push({
      path: file.path,
      line: lineAt(file.code, match.index),
      reason:
        "an SF Symbol where the Mac draws the website's icon set — use `JunoIconView(.x)`, "
        + "`JunoSymbol(.x)` or `Image(JunoIcon.x.assetName)`; add a missing glyph through "
        + "scripts/generate-native-icons.mjs",
    });
  }
}

process.exit(
  gate({
    rule: "symbols",
    headline: "The Mac draws the website's icons.",
    why:
      "  The Mac app wears the web's icon set (JunoIcon, generated from\n"
      + "  src/components/ui/juno-icons). An SF Symbol beside them is a second\n"
      + "  family at a second weight. Use JunoIconView / JunoSymbol, or add the\n"
      + "  glyph through the generator. System-drawn exceptions are listed in\n"
      + "  scripts/check-native-symbols.mjs and docs/native/ICON_MIGRATION_MAC.md.",
    violations,
  }),
);
