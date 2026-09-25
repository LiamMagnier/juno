import process from "node:process";
import { gate, lineAt, swiftSources } from "./check-native-design-lib.mjs";

/*
 * MENUS USE THE RECIPE, NOT THE DEPRECATED STYLE (docs/native/MACOS_LIQUID_GLASS_REDESIGN.md
 * §7.1; Phase 3 brief A6).
 *
 * `.menuStyle(.borderlessButton)` is deprecated on macOS, and it draws its
 * trigger its own way: a system-inset label with its own hit region and its own
 * idea of the indicator, which is why the menus that still carry it look and
 * answer differently from the ones beside them. The recipe is
 * `.menuStyle(.button)` with `.buttonStyle(.borderless)`, `.plain` or a Juno
 * style, `.menuIndicator(.hidden)` for an icon-only trigger, a 28pt
 * `.contentShape` and a `.help`.
 *
 * The baseline is the sites other lanes own (page files, the task card,
 * research, the canvas, the legacy Work window, Juno Code); the count only
 * ever goes down.
 */

/** Files that ship to the Mac. The phone has no such menu style. */
function shipsToMac(filePath) {
  return filePath.startsWith("native/macOS/") || filePath.startsWith("native/Packages/");
}

const DEPRECATED = /\.borderlessButton\b|\bBorderlessButtonMenuStyle\b/g;

const violations = [];
for (const file of swiftSources()) {
  if (!shipsToMac(file.path)) continue;
  for (const match of file.code.matchAll(DEPRECATED)) {
    violations.push({
      path: file.path,
      line: lineAt(file.code, match.index),
      reason:
        "deprecated `.borderlessButton` menu style — use `.menuStyle(.button)` with "
        + "`.buttonStyle(.borderless | .plain)` and `.menuIndicator(.hidden)` (§7.1)",
    });
  }
}

process.exit(
  gate({
    rule: "menus",
    headline: "Menus use the §7.1 recipe.",
    why:
      "  `.menuStyle(.borderlessButton)` is deprecated and draws its trigger the old\n"
      + "  way. Use `.menuStyle(.button)` + `.buttonStyle(.borderless)` (or `.plain`, or\n"
      + "  a Juno style) + `.menuIndicator(.hidden)` for an icon-only trigger, with a\n"
      + "  28pt `.contentShape` and a `.help`. Rows are `Label`s with 16pt glyphs, Title\n"
      + "  Case, and no `.keyboardShortcut` inside an in-window menu.",
    violations,
  }),
);
