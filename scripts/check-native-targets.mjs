import process from "node:process";
import { bracedRegions, gate, lineAt, swiftSources } from "./check-native-design-lib.mjs";

/*
 * RULE 4 OF THE REWORK BRIEF: every hit target is at least 44×44, with a
 * `.contentShape` matching what the control visibly is.
 *
 * Two failures, and the second is the one people miss. A 20pt icon button is
 * obviously too small. But a correctly sized button whose label is an `HStack`
 * with a `Spacer` has a hit region shaped like its *glyphs* — SwiftUI hit-tests
 * the drawn content, not the frame — so the row looks tappable across its whole
 * width and answers only where ink happens to be. `.contentShape` is what makes
 * the target equal the affordance.
 *
 * THIS CHECK IS A HEURISTIC AND KNOWINGLY OVER-REPORTS.
 *
 * It cannot see padding, so a `.frame(width: 20, height: 20)` icon with
 * `.padding(12)` around it measures 44pt in reality and is counted here anyway.
 * It cannot see a `.contentShape` applied by a shared button style either. Both
 * are false positives, both are absorbed by the baseline, and in both cases the
 * remedy is the same and is worth doing regardless: state the target explicitly
 * with `.frame(minWidth: 44, minHeight: 44)` and `.contentShape(…)` so the size
 * is auditable from the call site instead of inferred from three modifiers up.
 */

const MINIMUM = 44;

/** End offset of the balanced `(…)`/`{…}` group opening at `open`. */
function consumeBalanced(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    const character = code[i];
    if (character === "(" || character === "{") depth += 1;
    else if (character === ")" || character === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return code.length;
}

function skipSpace(code, i) {
  while (i < code.length && /\s/.test(code[i])) i += 1;
  return i;
}

/**
 * The full extent of a control expression: every group it opens, plus the
 * trailing `.modifier(…)` chain hung off it.
 *
 * Three things have to be swallowed or the check silently measures nothing.
 * `Button(action: send) { Label(…) }` opens TWO groups in a row, and stopping at
 * the first — which an obvious balanced-paren scan does — cuts the label off,
 * which is where every `.frame` lives. `Menu { … } label: { … }` uses Swift's
 * multiple-trailing-closure form, so the second closure is reached through a
 * bare `label:`. And the chain matters most of all: `.contentShape` and the
 * outer `.frame` are nearly always applied to the control rather than inside its
 * label, so a span that ended at the closing brace would report every correctly
 * shaped button in the tree as a violation.
 */
function expressionSpan(code, start) {
  let i = start + (code.slice(start).match(/^[A-Za-z_][A-Za-z0-9_]*/)?.[0].length ?? 0);
  let consumedAny = false;
  for (;;) {
    const j = skipSpace(code, i);
    if (code[j] === "(" || code[j] === "{") {
      i = consumeBalanced(code, j);
      consumedAny = true;
      continue;
    }
    if (!consumedAny) break;
    // `label: {` — the second half of a multiple-trailing-closure call.
    const labelled = code.slice(j).match(/^[A-Za-z_][A-Za-z0-9_]*\s*:\s*\{/);
    if (labelled) {
      i = consumeBalanced(code, j + labelled[0].length - 1);
      continue;
    }
    const chain = code.slice(j).match(/^\.[A-Za-z_][A-Za-z0-9_]*/);
    if (chain) {
      i = j + chain[0].length;
      continue;
    }
    break;
  }
  return { start, end: i, text: code.slice(start, i) };
}

/** Every `width:`/`height:` literal in the `.frame(…)` calls inside a span. */
function frameDimensions(text) {
  const found = [];
  for (const match of text.matchAll(/\.frame\(([^)]*)\)/g)) {
    for (const dimension of match[1].matchAll(/\b(width|height|minWidth|minHeight)\s*:\s*(\d+(?:\.\d+)?)\b/g)) {
      found.push({ name: dimension[1], value: Number(dimension[2]), offset: match.index });
    }
  }
  return found;
}

// `(?<![A-Za-z0-9_.])` keeps `EditButton`, `.buttonStyle` and `ContextMenu` out.
const CONTROLS = /(?<![A-Za-z0-9_.])(Button|Menu)\s*(?=[({])/g;

/*
 * Places where the SYSTEM draws the row and owns its metrics.
 *
 * A `Button` inside a `Menu`, a context menu, an alert, a confirmation dialog, a
 * swipe action or a toolbar is not a view we lay out — AppKit/UIKit renders it,
 * at its own size, with its own hit region. Reporting those was the difference
 * between a gate whose failures are mostly real and one whose failures are
 * mostly menu items, and a gate people learn to skim is a gate that is off.
 */
const SYSTEM_DRAWN = new RegExp(
  [
    "(?<![A-Za-z0-9_.])Menu\\s*[({]",
    "\\.contextMenu\\s*[({]",
    "\\.confirmationDialog\\s*\\(",
    "\\.alert\\s*\\(",
    "\\.swipeActions\\s*\\(",
    "\\.toolbar\\s*[({]",
    "(?<![A-Za-z0-9_.])ToolbarItem",
    "(?<![A-Za-z0-9_.])(Picker|Section|Form|Settings)\\s*[({]",
  ].join("|"),
);

const violations = [];
for (const file of swiftSources()) {
  const systemDrawn = bracedRegions(file.lines, SYSTEM_DRAWN);
  const isSystemDrawn = (line) =>
    systemDrawn.some((region) => line > region.startLine && line <= region.endLine);

  for (const match of file.code.matchAll(CONTROLS)) {
    const control = match[1];
    if (isSystemDrawn(lineAt(file.code, match.index))) continue;
    const span = expressionSpan(file.code, match.index);
    if (span.end <= span.start) continue;
    const line = lineAt(file.code, match.index);

    /*
     * An explicit dimension below 44 with nothing in the same control reaching
     * 44. Requiring "nothing reaches 44" is what keeps a 20pt icon inside an
     * explicitly 44pt button from being reported — the common correct shape.
     */
    const dimensions = frameDimensions(span.text);
    const smallest = dimensions.filter((dimension) => dimension.value < MINIMUM);
    const reaches = dimensions.some((dimension) => dimension.value >= MINIMUM);
    if (smallest.length > 0 && !reaches) {
      const worst = smallest.reduce((a, b) => (a.value <= b.value ? a : b));
      violations.push({
        path: file.path,
        line: lineAt(file.code, span.start + worst.offset),
        reason:
          `${control} sized ${worst.name}: ${worst.value} with nothing in it reaching ${MINIMUM}pt `
          + `— state the target: .frame(minWidth: 44, minHeight: 44) (heuristic: padding is invisible here)`,
      });
      continue;
    }

    if (!/\.contentShape\s*\(/.test(span.text)) {
      violations.push({
        path: file.path,
        line,
        reason:
          `${control} label has no .contentShape — SwiftUI hit-tests the drawn glyphs, `
          + "so the target is ink-shaped rather than control-shaped (heuristic: a shared "
          + "button style may already supply one)",
      });
    }
  }
}

const seen = new Set();
const deduped = violations.filter((violation) => {
  const key = `${violation.path}:${violation.line}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});
deduped.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);

process.exit(
  gate({
    rule: "targets",
    headline: "Every target is 44pt and shaped like the control.",
    why:
      "  Two fixes, usually on the same line. Size: `.frame(minWidth: 44, minHeight: 44)`\n"
      + "  on the control itself, so the target is readable at the call site rather than\n"
      + "  inferred from padding three modifiers away. Shape: `.contentShape(.rect)` — or\n"
      + "  a concentric shape where the control has a visible corner — so the hit region\n"
      + "  is the whole control and not just the pixels its glyphs happen to cover.\n"
      + "\n"
      + "  This rule over-reports by design; it cannot see padding or a `.contentShape`\n"
      + "  applied by a shared ButtonStyle. The baseline absorbs the existing ones, so a\n"
      + "  FAILURE here is always about a control you just added.",
    violations: deduped,
  }),
);
