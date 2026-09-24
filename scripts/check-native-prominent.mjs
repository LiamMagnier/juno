import process from "node:process";
import { gate, lineAt, swiftSources } from "./check-native-design-lib.mjs";

/*
 * THE ONE PROMINENT BUTTON IS IN THE JUNO ACCENT (docs/native/MACOS_LIQUID_GLASS_REDESIGN.md
 * §0.4, register #48).
 *
 * `.borderedProminent` fills with whatever `tint` its environment carries and
 * falls back to the app's accent colour, which Juno leaves to the system — the
 * reader's own, blue by default. The accent tint sits only BELOW the view that
 * owns the toolbar, so a prominent button anywhere else (a sheet presented from
 * the split view, another window, a card drawn outside the chat column) came out
 * system blue unless its call site remembered a tint of its own. The approval
 * card's verb button was the case that showed it.
 *
 * `.buttonStyle(.junoProminent)` (JunoDesignSystem/JunoButtonStyles.swift) is the
 * system's `.borderedProminent` carrying the accent itself, so there is no tint
 * to forget. This gate ratchets the raw spelling down: every new prominent
 * button in a file that ships to the Mac goes through the Juno style. The
 * baseline is Juno Code's own sites, which belong to the Code rework.
 */

// The style itself.
const EXEMPT = new Set([
  "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoButtonStyles.swift",
]);

/** Files that ship to the Mac. The phone app has its own chrome and tint. */
function shipsToMac(filePath) {
  return filePath.startsWith("native/macOS/") || filePath.startsWith("native/Packages/");
}

const RAW = /\.borderedProminent\b/g;

const violations = [];
for (const file of swiftSources()) {
  if (EXEMPT.has(file.path) || !shipsToMac(file.path)) continue;
  for (const match of file.code.matchAll(RAW)) {
    violations.push({
      path: file.path,
      line: lineAt(file.code, match.index),
      reason:
        "raw `.borderedProminent` — it fills with the system accent wherever the Juno tint "
        + "does not reach; use `.buttonStyle(.junoProminent)`",
    });
  }
}

process.exit(
  gate({
    rule: "prominent",
    headline: "The one prominent button is in the Juno accent.",
    why:
      "  `.borderedProminent` takes its colour from the environment's tint and falls\n"
      + "  back to the system accent (blue) wherever `.junoAccentTint()` does not reach:\n"
      + "  sheets, other windows, anything above the toolbar's owner. Use\n"
      + "  `.buttonStyle(.junoProminent)`, which carries the Juno accent itself.",
    violations,
  }),
);
