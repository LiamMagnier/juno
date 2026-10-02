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
