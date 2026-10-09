import process from "node:process";
import { gate, lineAt, swiftSources } from "./check-native-design-lib.mjs";

/*
 * EVERY GAP NAMES ITS STEP (spacing pass, 2026-10-09;
 * docs/native/spacing-pass/AUDIT.md X1).
 *
 * The owner: "rework the placement of icons, object, but also paddings and
 * everything". Before the pass the two apps spelled ~600 raw numbers into
 * `.padding(…)` and `spacing:` — 7 beside 8, 9 beside 10, 11 beside 12 for the
 * same role — and no two screens agreed on a gutter. The steps now live in
 * `JunoSpace` (the web's Tailwind scale, via `JunoGeneratedSpace`) and the
 * placements in `JunoLayout`.
 *
 * This gate counts a non-zero numeric literal used as a `.padding(…)` amount
 * or a `spacing:` argument in the iOS and Mac app sources. Zero is allowed (it
 * says "abut", not a size), and so is anything spelled through a name. It
 * ratchets: the count may only fall.
 */

const NUMBER = String.raw`-?\d+(?:\.\d+)?`;
const PATTERNS = [
  new RegExp(String.raw`\bspacing:\s*(${NUMBER})(?=\s*[,)])`, "g"),
  new RegExp(String.raw`\.padding\(\s*(${NUMBER})\s*\)`, "g"),
  new RegExp(String.raw`\.padding\(\s*(?:\.[A-Za-z]+|\[[^\]]*\])\s*,\s*(${NUMBER})\s*\)`, "g"),
];

function inScope(filePath) {
  if (filePath.includes("/Tests/") || filePath.includes("/UITests/")) return false;
  return filePath.startsWith("native/iOS/JunoMobile/App/") || filePath.startsWith("native/macOS/JunoDesktop/App/");
}

const violations = [];
for (const file of swiftSources()) {
  if (!inScope(file.path)) continue;
  for (const pattern of PATTERNS) {
    for (const match of file.code.matchAll(pattern)) {
      if (Number(match[1]) === 0) continue;
      violations.push({
        path: file.path,
        line: lineAt(file.code, match.index),
        reason: `a raw ${match[1]}pt gap — name its step (\`JunoSpace.*\`) or its placement (\`JunoLayout.*\`)`,
      });
    }
  }
}

process.exit(
  gate({
    rule: "spacing",
    headline: "Every gap names its step.",
    why:
      "  Gaps and paddings come from JunoSpace (the web's spacing scale) or\n"
      + "  JunoLayout (bar, control, row, page and sheet placements), so two\n"
      + "  screens cannot disagree by a point. Spell the step by name; if no step\n"
      + "  fits, the placement probably belongs in JunoLayout.",
    violations,
  }),
);
