import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { GROUNDS, KNOWN_MISUSES, runMatrix, simulate } from "../scripts/check-contrast-matrix";
import { appearanceTables, contrastRatio, hex, parseBlocks, resolveColor, type Appearance } from "../scripts/generate-design-tokens";

/**
 * P1 acceptance, contrast (spec §3.1, §3.2): the numbers the spec states,
 * measured from globals.css rather than restated, and the matrix gate itself.
 */

const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
const tables = appearanceTables(parseBlocks(css));
const colour = (name: string, a: Appearance) => {
  const c = resolveColor(tables[a], name);
  assert.ok(c, `--${name} does not resolve in ${a}`);
  return c;
};
const ratio = (ink: string, ground: string, a: Appearance) => contrastRatio(colour(ink, a), colour(ground, a));

test("muted-on-fill clears 4.9 on the selected fill in both themes (#5F6267 on #E6E7E9, #A6A8AD on #37383C)", () => {
  assert.equal(hex(colour("muted-foreground-on-fill", "light")), "#5f6267");
  assert.equal(hex(colour("selected", "light")), "#e6e7e9");
  assert.equal(hex(colour("muted-foreground-on-fill", "dark")), "#a6a8ad");
  assert.equal(hex(colour("selected", "dark")), "#37383c");
  assert.ok(ratio("muted-foreground-on-fill", "selected", "light") >= 4.9);
  assert.ok(ratio("muted-foreground-on-fill", "selected", "dark") >= 4.9);
});

test("high-contrast muted clears 7.2 on every ground in both themes", () => {
  for (const a of ["hcLight", "hcDark"] as const) {
    for (const g of GROUNDS) {
      for (const ink of ["muted-foreground", "muted-foreground-on-fill"]) {
        const r = ratio(ink, g, a);
        assert.ok(r >= 7.2, `${a}: --${ink} on --${g} is ${r.toFixed(2)}`);
      }
    }
  }
});

test("the high-contrast border is a real edge: 3.58 on selected (light), 4.09 on card (dark)", () => {
  assert.ok(ratio("border", "selected", "hcLight") >= 3.58);
  assert.ok(ratio("border", "card", "hcDark") >= 4.09);
  // ...and the hairline becomes the same solid line, not a tint.
  assert.equal(colour("hairline", "hcLight").a, 1);
  assert.equal(colour("hairline", "hcDark").a, 1);
});

test("signal: the glyph #D36317 clears 3.0 on selected, the ink #B65116 clears 4.9 on the canvas", () => {
  assert.equal(hex(colour("signal", "light")), "#d36317");
  assert.equal(hex(colour("signal-ink", "light")), "#b65116");
  assert.ok(ratio("signal", "selected", "light") >= 3.0);
  assert.ok(ratio("signal-ink", "background", "light") >= 4.9);
});

test("destructive #B81E28 clears 6.4 on a card", () => {
  assert.equal(hex(colour("destructive", "light")), "#b81e28");
  assert.ok(ratio("destructive", "card", "light") >= 6.4);
});

test("--input, the control boundary, clears 3.26 in both themes", () => {
  for (const a of ["light", "dark"] as const) {
    for (const g of ["background", "card"]) {
      const r = ratio("input", g, a);
      assert.ok(r >= 3.26, `${a}: --input on --${g} is ${r.toFixed(2)}`);
    }
  }
});

test("the muted-on-selected 4.32 pair is recorded as a misuse, and still fails", () => {
  const entry = KNOWN_MISUSES.find((k) => k.ink === "muted-foreground" && k.ground === "selected");
  assert.ok(entry, "the known-bad pair is not recorded");
  const r = ratio("muted-foreground", "selected", "light");
  assert.ok(Math.abs(r - 4.32) < 0.01, `expected 4.32, measured ${r.toFixed(3)}`);
  const result = runMatrix(css);
  const check = result.checks.find((c) => c.ink === "muted-foreground" && c.ground === "selected" && c.appearance === "light");
  assert.equal(check?.recorded, true);
  assert.equal(check?.pass, false);
});

test("the matrix holds on the tree", () => {
  const result = runMatrix(css);
  assert.deepEqual(
    result.failures.map((f) => `${f.appearance} ${f.ink} on ${f.ground} ${f.ratio.toFixed(2)}`),
    []
  );
  assert.ok(result.ok);
  // Every ground in every appearance, so a new appearance cannot silently skip one.
  for (const a of ["light", "dark", "hcLight", "hcDark"] as const) {
    for (const g of GROUNDS) assert.ok(result.checks.some((c) => c.appearance === a && c.ground === g), `${a} ${g} unmeasured`);
  }
});

test("a ground that moves fails the matrix (the regression it exists for)", () => {
  // Darken the light selected fill until muted-on-fill drops under 4.5.
  const moved = css.replace("--selected: 220.000 6.383% 90.784%;", "--selected: 220 6% 82%;");
  assert.notEqual(moved, css, "the fixture did not find --selected");
  const result = runMatrix(moved);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.ink === "muted-foreground-on-fill" && f.ground === "selected"));
});

test("a recorded misuse that starts passing fails the matrix too, so the list cannot go stale", () => {
  const fixed = css.replace("--selected: 220.000 6.383% 90.784%;", "--selected: 220 6% 97%;");
  const result = runMatrix(fixed);
  assert.ok(result.failures.some((f) => f.recorded && f.ink === "muted-foreground"));
});

test("CVD arithmetic: signal and destructive stay 2.0:1 apart under simulated deuteranopia in both themes", () => {
  for (const a of ["light", "dark"] as const) {
    const r = contrastRatio(simulate(colour("signal", a), "deuteranopia"), simulate(colour("destructive", a), "deuteranopia"));
    assert.ok(r >= 2.0, `${a}: ${r.toFixed(3)}`);
  }
  // The spec's own figures, as a check on the arithmetic (sRGB-space Machado).
  const light = contrastRatio(simulate(colour("signal", "light"), "deuteranopia"), simulate(colour("destructive", "light"), "deuteranopia"));
  assert.ok(Math.abs(light - 2.3) < 0.02, `light deuteranopia ${light.toFixed(3)} (spec 2.30)`);
  // The linear-light figure is reported, not gated, and is smaller: the glyph carries the rest.
  const linear = contrastRatio(
    simulate(colour("signal", "light"), "deuteranopia", "linear"),
    simulate(colour("destructive", "light"), "deuteranopia", "linear")
  );
  assert.ok(linear > 1.5 && linear < light);
  assert.ok(runMatrix(css).cvd.some((c) => c.space === "linear" && !c.gate));
});

test("the CVD gate fails when needs-you drifts back toward destructive", () => {
  const coral = css.replace("--signal: 24 80% 46%;", "--signal: 14 64% 46%;");
  assert.notEqual(coral, css);
  assert.ok(runMatrix(coral).cvdFailures.some((c) => c.appearance === "light"));
});
