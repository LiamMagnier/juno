import process from "node:process";
import { gate, lineAt, swiftSources } from "./check-native-design-lib.mjs";

/*
 * RULE 2 OF THE REWORK BRIEF: every animation names a `JunoMotion` token or it is
 * a bug.
 *
 * The damage from ad-hoc curves is not the outliers, it is the near-misses. An
 * audit of this tree found 35 inline curve constructors across 16 files carrying
 * 21 distinct durations — and what read as machine-made was 0.15 sitting beside
 * `fast` 0.12, 0.2 beside `base` 0.22, 0.3/0.32/0.34 beside `slow` 0.36. Four
 * values that close are one intention executed inconsistently, which is the
 * entire reason a ladder exists.
 *
 * There are two ways to break the rule and this gate catches both.
 *
 *   1. Writing a raw curve. `.easeOut(duration:)`, `.spring(response:)`,
 *      `.snappy`, `.bouncy`, `.smooth` — the iOS 17 shorthands included, because
 *      `.snappy` and `.bouncy` carry bounce well above the 0.18 ceiling the brief
 *      sets and are how "bounce on chrome" gets in.
 *   2. Inventing a SECOND ladder. `JunoMobileMotion.riseIn`,
 *      `DesktopChatMotion.riseIn`, `Self.breatheEase` are each a private
 *      vocabulary that happens to animate. They are worse than a raw curve,
 *      because a raw curve is obviously ad-hoc and a parallel ladder looks
 *      principled while guaranteeing the two apps drift.
 *
 * `withAnimation` must therefore take the result of `JunoMotion.reduced(…)` or a
 * `JunoMotion.` rung directly. `reduced` is not optional politeness: without it,
 * Reduce Motion is unanswered, and the three-tier model (travel collapses, tint
 * survives, ambient stops) only applies where somebody called it.
 */

// `JunoDesignTokens.swift` DEFINES the ladder, so it is the one file that must
// write the raw constructors the rest of the tree is forbidden.
const EXEMPT = new Set([
  "native/Packages/JunoNativeKit/Sources/JunoDesignSystem/JunoDesignTokens.swift",
]);

const RAW_CURVES = [
  [/\.easeOut\(\s*duration\s*:/g, "raw .easeOut(duration:) — name JunoMotion.fast/.press or JunoMotion.outSoft()"],
  [/\.easeIn\(\s*duration\s*:/g, "raw .easeIn(duration:) — the accelerate curve is JunoMotion.exit"],
  [/\.easeInOut\(\s*duration\s*:/g, "raw .easeInOut(duration:) — a symmetric curve on everything is the uniform-0.3s tell"],
  [/\.linear\(\s*duration\s*:/g, "raw .linear(duration:) — for a loop use JunoMotion.ambient(_:when:) so Reduce Motion can stop it"],
  [/\.spring\(\s*response\s*:/g, "raw .spring(response:) — name JunoMotion.standard/.emphasized/.spring"],
  [/\.snappy\b/g, "`.snappy` carries bounce above the 0.18 ceiling — use JunoMotion.standard (bounce 0.05)"],
  [/\.bouncy\b/g, "`.bouncy` carries bounce above the 0.18 ceiling — use JunoMotion.standard (bounce 0.05)"],
  [/\.smooth\b/g, "`.smooth` is an unnamed spring — use JunoMotion.standard/.emphasized"],
  [/withAnimation\(\s*\.default/g, "withAnimation(.default) animates with whatever SwiftUI picks — name a JunoMotion rung"],
];

/** The balanced-paren argument list of a call whose `(` sits at `open`. */
function argumentText(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, i);
    }
  }
  return code.slice(open + 1);
}

const violations = [];
for (const file of swiftSources()) {
  if (EXEMPT.has(file.path)) continue;

  for (const [pattern, reason] of RAW_CURVES) {
    for (const match of file.code.matchAll(pattern)) {
      violations.push({ path: file.path, line: lineAt(file.code, match.index), reason });
    }
  }

  /*
   * `withAnimation` taking anything but the shared ladder.
   *
   * A substring test for `JunoMotion.` rather than a parse: it accepts
   * `JunoMotion.fast`, `JunoMotion.reduced(JunoMotion.standard, …)` and
   * `JunoMotion.ambient(…)`, and rejects a local (`withAnimation(travel)`) or a
   * parallel ladder (`JunoMobileMotion.riseIn`). A local that genuinely holds a
   * `JunoMotion` value is a FALSE POSITIVE and that is on purpose — hiding the
   * token behind a name is how the second ladder starts, and the fix is to name
   * the rung at the call site or to move the local into `JunoMotion` itself.
   */
  for (const match of file.code.matchAll(/\bwithAnimation\s*\(/g)) {
    const open = match.index + match[0].length - 1;
    if (/\bJunoMotion\./.test(argumentText(file.code, open))) continue;
    violations.push({
      path: file.path,
      line: lineAt(file.code, open),
      reason:
        "withAnimation() takes something other than JunoMotion.reduced(…) or a "
        + "JunoMotion. rung — Reduce Motion goes unanswered and the ladder forks",
    });
  }
}

/*
 * One line, one motion defect. `withAnimation(.easeOut(duration: 0.06))` trips
 * both checks above; counting it twice would make the baseline a number nobody
 * can reconcile against the code.
 */
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
    rule: "motion",
    headline: "Every animation names a JunoMotion token.",
    why:
      "  A raw curve at a call site is invisible to the ladder: it cannot be retuned\n"
      + "  from `globals.css`, it does not pass through `JunoMotion.reduced(_:when:tier:)`,\n"
      + "  and it lands a duration a few milliseconds off whatever the surface beside it\n"
      + "  uses. Replace it with the rung that matches the INTENT — press (70ms) for a\n"
      + "  press, fast (120ms) for feedback on the element under the pointer, exit (160ms)\n"
      + "  for a dismissal, standard for a transition, emphasized for a large spatial move\n"
      + "  — and wrap it in `JunoMotion.reduced(…, when: reduceMotion)` so the preference\n"
      + "  is answered. Bounce ceiling is 0.18; the house default is 0.05–0.10.",
    violations: deduped,
  }),
);
