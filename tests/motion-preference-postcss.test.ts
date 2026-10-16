import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import test from "node:test";
import postcss, { type AcceptedPlugin } from "postcss";

/*
 * G45: the in-app Motion setting runs the OS tiers, compiled from the same
 * rules (postcss/motion-preference.cjs). These pin the compiler's output.
 */

const require = createRequire(path.join(process.cwd(), "package.json"));
const plugin = require("./postcss/motion-preference.cjs") as AcceptedPlugin & {
  scopeSelector: (selector: string, scope: string) => string | null;
};

const ON_REDUCED = ':where([data-motion^="reduce"], [data-motion^="reduce"] *)';
const NOT_FULL = ':where(:not([data-motion="full"], [data-motion="full"] *))';
const NOT_REDUCED = ':where(:not([data-motion^="reduce"], [data-motion^="reduce"] *))';
const ON_FULL = ':where([data-motion="full"], [data-motion="full"] *)';

const run = (css: string) => {
  const result = postcss([plugin]).process(css, { from: undefined });
  return { css: result.css.replace(/\s+/g, " ").trim(), warnings: result.warnings().map((w) => w.text) };
};

test("a reduce block keeps its media rule (unless Full) and gains an in-app Reduced twin", () => {
  const { css } = run("@media (prefers-reduced-motion: reduce) { .a .b { animation: none; } }");
  assert.equal(
    css,
    `@media (prefers-reduced-motion: reduce) { .a${NOT_FULL} .b { animation: none; } } .a${ON_REDUCED} .b { animation: none; }`
  );
});

test("a no-preference block skips Reduced, and plays under Full on a device that reduces", () => {
  const { css } = run("@media (prefers-reduced-motion: no-preference) { .a { transition: translate 1s; } }");
  assert.equal(
    css,
    `@media (prefers-reduced-motion: no-preference) { .a${NOT_REDUCED} { transition: translate 1s; } } ` +
      `@media (prefers-reduced-motion: reduce) { .a${ON_FULL} { transition: translate 1s; } }`
  );
});

test("the condition sits on the first compound, before any pseudo-element, without changing specificity", () => {
  const scope = plugin.scopeSelector;
  // `.dark` is <html>: the condition must be on it, not on a descendant of it.
  assert.equal(scope(".dark .b::after", "onReduced"), `.dark${ON_REDUCED} .b::after`);
  assert.equal(scope(".x::before", "notFull"), `.x${NOT_FULL}::before`);
  assert.equal(scope(".x:after", "notFull"), `.x${NOT_FULL}:after`);
  assert.equal(scope(".rf ::selection", "onReduced"), `.rf${ON_REDUCED} ::selection`);
  assert.equal(scope(".c > .d", "onFull"), `.c${ON_FULL} > .d`);
  assert.equal(scope(".e:hover svg", "notReduced"), `.e:hover${NOT_REDUCED} svg`);
  assert.equal(scope(".i:is(.a, .b) .j", "onReduced"), `.i:is(.a, .b)${ON_REDUCED} .j`);
  // Tailwind's escaped variant classes stay one compound.
  assert.equal(scope(".motion-safe\\:animate-x", "notReduced"), `.motion-safe\\:animate-x${NOT_REDUCED}`);
  assert.equal(scope("[data-x='a b'] .y", "onReduced"), `[data-x='a b']${ON_REDUCED} .y`);
  // Nesting cannot be scoped safely.
  assert.equal(scope("& .z", "onReduced"), null);
});

test("a bare :root / html in a twin becomes the attribute, so the token overrides reach a gallery root", () => {
  const { css } = run("@media (prefers-reduced-motion: reduce) { :root { --motion-shift: 0; } html { scroll-behavior: auto; } }");
  assert.match(css, /\[data-motion\^="reduce"\] \{ --motion-shift: 0; \}/);
  assert.match(css, /\[data-motion\^="reduce"\] \{ scroll-behavior: auto; \}/);
  assert.ok(css.includes(`:root${NOT_FULL} { --motion-shift: 0; }`));
});

test("combined queries keep their other conditions; query lists keep their other alternatives", () => {
  const combined = run("@media (hover: hover) and (prefers-reduced-motion: no-preference) { .a:hover svg { rotate: 9deg; } }").css;
  assert.ok(combined.startsWith(`@media (hover: hover) and (prefers-reduced-motion: no-preference) { .a:hover${NOT_REDUCED} svg`));
  assert.ok(combined.includes(`@media (hover: hover) and (prefers-reduced-motion: reduce) { .a:hover${ON_FULL} svg`));

  const list = run("@media (max-width: 860px), (prefers-reduced-motion: reduce) { .f { transition: none; } }").css;
  assert.ok(list.startsWith("@media (max-width: 860px) { .f { transition: none; } }"), "the width alternative is untouched");
  assert.ok(list.includes(`@media (prefers-reduced-motion: reduce) { .f${NOT_FULL} { transition: none; } }`));
  assert.ok(list.includes(`.f${ON_REDUCED} { transition: none; }`));

  const compact = run("@media(prefers-reduced-motion:reduce){.g{animation:none}}").css;
  assert.ok(compact.includes(`.g${ON_REDUCED}`));
});

test("keyframes with one body move out in front of the block, so the Full twin can name them", () => {
  // Tailwind's `motion-safe:animate-*` writes its @keyframes inside the media block.
  const { css, warnings } = run(
    "@media (prefers-reduced-motion: no-preference) { .a { animation: k 1s; } @keyframes k { from { opacity: 0; } } }"
  );
  assert.equal((css.match(/@keyframes k/g) ?? []).length, 1);
  assert.ok(css.startsWith("@keyframes k { from { opacity: 0; } } @media (prefers-reduced-motion: no-preference)"), css);
  assert.ok(css.includes(`@media (prefers-reduced-motion: reduce) { .a${ON_FULL} { animation: k 1s; } }`));
  assert.deepEqual(warnings, []);

  // Already defined unconditionally with the same body: the conditional copy is simply dropped.
  const twice = run("@keyframes k { to { opacity: 1; } } @media (prefers-reduced-motion: no-preference) { @keyframes k { to { opacity: 1; } } .b { animation: k 1s; } }").css;
  assert.equal((twice.match(/@keyframes k/g) ?? []).length, 1);
});

test("keyframes whose name has another body stay in the original block and never reach a twin", () => {
  const { css, warnings } = run(
    "@keyframes k { to { opacity: 0.5; } } @media (prefers-reduced-motion: no-preference) { .a { animation: k 1s; } @keyframes k { from { opacity: 0; } } }"
  );
  assert.equal((css.match(/@keyframes k/g) ?? []).length, 2);
  assert.ok(css.includes("@media (prefers-reduced-motion: no-preference) { .a"), css);
  assert.equal(warnings.length, 1);
});

test("rules without a motion query, and preludes it cannot rewrite, are left exactly as written", () => {
  const css = "@media (min-width: 40rem) { .a { color: red; } } @media not all and (prefers-reduced-motion: reduce) { .b { color: blue; } }";
  assert.equal(run(css).css, css);
});

test("the build runs it after Tailwind, and the blanket in-app clamp is gone", () => {
  const config = readFileSync(path.join(process.cwd(), "postcss.config.mjs"), "utf8");
  const order = ["tailwindcss", "./postcss/motion-preference.cjs", "autoprefixer"].map((name) => config.indexOf(name));
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], "plugin order");
  const globals = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(globals, /html\[data-motion="reduced"\] \*/, "the 0.01ms !important clamp is back");
});
