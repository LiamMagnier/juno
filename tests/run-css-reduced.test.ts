import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

/*
 * The run UI's CSS under reduced motion (SPEC §7.9, U5).
 *
 * WS0 landed §7.9 verbatim; these checks read `globals.css` as text. WS5 owns
 * this file with the stylesheet, and adds "every loop has a reduced rule" as it
 * adds loops.
 */

const css = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "");

/** `--name: value;` declarations, in order. */
function customProperties(block: string): string[] {
  return [...withoutComments(block).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, name, value]) => `${name}: ${value.trim()}`);
}

/** The unlayered `@media (prefers-reduced-motion: reduce)` block for the run UI, dedented. */
function reducedBlock(): string {
  const start = css.indexOf("@media (prefers-reduced-motion: reduce) {\n  .run-sweep__window");
  assert.notEqual(start, -1, "the run UI's reduced-motion block is missing");
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}\n", start));
  return body
    .split("\n")
    .map((line) => line.replace(/^ {2}/, ""))
    .join("\n")
    .trim();
}

/** The gallery's `[data-motion="reduce"]` root rule and the prefixed copy that follows it. */
function galleryCopy(): { root: string; rules: string } {
  const start = css.indexOf('[data-motion="reduce"] {\n');
  assert.notEqual(start, -1, "the gallery copy is missing");
  const end = css.indexOf("\n}\n", start);
  return {
    root: css.slice(start, end + 2),
    rules: css.slice(end + 3).trim().replaceAll('[data-motion="reduce"] ', ""),
  };
}

test("the run tokens, the z rung and the print rule landed", () => {
  for (const token of ["--loop-beat: 1.2s;", "--loop: 2.4s;", "--loop-calm: 4.8s;", "--z-panel: 30;", "--spring-pop-dur: 370ms;"]) {
    assert.ok(css.includes(token), `${token} is missing`);
  }
  assert.ok(css.indexOf("--z-panel: 30;") < css.indexOf("--z-aura: 40;"));
  assert.match(css, /@media print \{ \[data-print-document\] a\[href\^="http"\]::after \{ content: " \(" attr\(href\) "\)"; \} \}/);
});

test("the gallery's reduced-motion copy is the media block, prefixed", () => {
  assert.equal(galleryCopy().rules, reducedBlock());
});

test("the gallery's reduced-motion tokens are the preference's", () => {
  // The real preference also shortens the slow duration and flattens every curve with travel;
  // setting only --motion-shift would let the gallery approve motion reduced-motion users never see.
  const base = /@media \(prefers-reduced-motion: reduce\) \{\s*:root \{([^}]*)\}/.exec(css);
  assert.ok(base, "the reduced :root block in the base layer is missing");
  const preference = customProperties(base[1]);
  assert.ok(preference.includes("--motion-shift: 0"));
  assert.deepEqual(customProperties(galleryCopy().root), preference);
});

test("no reduced-motion loop runs offscreen", () => {
  // The block is unlayered, so it beats the layered `[data-offscreen]` pause; an `animation`
  // shorthand would also reset the play state. Each loop it starts must exclude offscreen elements.
  const rules = withoutComments(reducedBlock()).split("}").map((rule) => rule.split("{"));
  let loops = 0;
  for (const [selector, declarations] of rules) {
    if (declarations === undefined || !/animation(?:-name)?:\s*(?!none\b)\S/.test(declarations)) continue;
    loops += 1;
    for (const one of selector.split(/,(?![^(]*\))/)) {
      assert.match(one, /:not\(\[data-offscreen\]\)/, `${one.trim()} can loop offscreen`);
    }
  }
  assert.ok(loops >= 2, "the glyph breath and the marker breath");
});

// ── WS5: every loop has a reduced rule and an offscreen pause ─────────────────

/** The run UI's component rules: from the glyph's heading to the end of that layer block. */
function runComponents(): string {
  const start = css.indexOf("/* ── Run glyph (Concept A)");
  assert.notEqual(start, -1, "the run components block is missing");
  return css.slice(start, css.indexOf("\n}\n", start));
}

/**
 * For each infinite loop the run UI declares: the rule that stops it under
 * reduced motion (in the unlayered block, which beats the layer) and the rule
 * that pauses it offscreen, or while it does not own the loop.
 */
const LOOPS: Record<string, { reduced: string; offscreen: string }> = {
  "run-lit": { reduced: ".run-glyph > i::after { animation: none; }", offscreen: ".run-glyph[data-offscreen] > i::after" },
  "run-lit-bar": { reduced: ".run-glyph > i::after { animation: none; }", offscreen: ".run-glyph[data-offscreen] > i::after" },
  "run-lit-type": { reduced: ".run-glyph > i::after { animation: none; }", offscreen: ".run-glyph[data-offscreen] > i::after" },
  "run-sweep-window": {
    reduced: ".run-sweep__window { display: none; }",
    offscreen: ".run-sweep[data-offscreen] :is(.run-sweep__window, .run-sweep__text--hi) { animation-play-state: paused; }",
  },
  "run-sweep-counter": {
    // The full-ink copy lives inside the window, which is hidden.
    reduced: ".run-sweep__window { display: none; }",
    offscreen: ".run-sweep[data-offscreen] :is(.run-sweep__window, .run-sweep__text--hi) { animation-play-state: paused; }",
  },
  "run-breathe": {
    reduced: ".run-marker[data-state=\"running\"]:not([data-loop=\"off\"]):not([data-offscreen])::before {\n  animation-name: run-breathe-opacity;",
    offscreen: ".run-marker[data-state=\"running\"]:is([data-loop=\"off\"], [data-offscreen])::before { animation: none;",
  },
};

test("every loop in the run components has a reduced rule and an offscreen pause", () => {
  const block = withoutComments(runComponents());
  const used = new Set<string>();
  for (const [, value] of block.matchAll(/animation\s*:\s*([^;]+);/g)) {
    const name = value.trim().split(/\s+/)[0];
    if (name.startsWith("run-")) used.add(name);
  }
  for (const [, name] of block.matchAll(/--lit-name:\s*(run-[\w-]+)/g)) used.add(name);
  assert.ok(used.size >= 5, `found ${[...used].join(", ")}`);
  const reduced = reducedBlock();
  for (const name of used) {
    const rule = LOOPS[name];
    assert.ok(rule, `the loop ${name} has no reduced or offscreen rule recorded here`);
    assert.ok(reduced.includes(rule.reduced), `${name}: no reduced-motion rule`);
    assert.ok(block.includes(rule.offscreen), `${name}: no offscreen pause`);
  }
  // Every loop reads its own phase lock and runs on the loop family.
  assert.doesNotMatch(block, /animation:[^;]*\b\d+(?:\.\d+)?m?s\b[^;]*infinite/, "a loop off the --loop family");
});

test("the peek clips at its list, and the page's progress line joined the loop family", () => {
  assert.match(css, /\.run-peek \{ block-size: 3\.5rem; margin-block-start: 0\.5rem; overflow: clip; \}/);
  assert.match(css, /animation: stream-progress var\(--loop\) var\(--ease-in-out\) infinite;/);
  assert.match(css, /\.stream-progress\[data-paused\]::before \{ animation-play-state: paused; \}/);
  assert.doesNotMatch(css, /hsl\(var\(--primary\) \/ \.9\), transparent\);\s*animation: stream-progress 1\.4s/, "no coral sweep");
});
