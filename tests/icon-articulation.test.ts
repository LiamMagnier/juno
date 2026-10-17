import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/*
 * G46: icon hover articulation plays on destinations only.
 *
 * For a day every link, button, tab and menu row played its glyph's gesture,
 * so a pointer crossing a menu or a message's action row set glyphs moving
 * with no state change behind them. The gesture now answers only controls
 * marked `data-jicon-articulate` (or inside a `="within"` region).
 */

const root = process.cwd();
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const icons = strip(read("src/components/ui/juno-icons/icons.css"));

/** A selector list split at its top-level commas (not those inside `:is(…)`). */
function splitList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    if (list[i] === "(") depth += 1;
    else if (list[i] === ")") depth -= 1;
    else if (list[i] === "," && depth === 0) {
      out.push(list.slice(start, i));
      start = i + 1;
    }
  }
  return [...out, list.slice(start)];
}

/** Every selector that contains `:hover` and styles a part of the glyph. */
function hoverSelectors(css: string): string[] {
  const out: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{/g)) {
    const prelude = match[1].trim();
    if (prelude.startsWith("@")) continue;
    for (const selector of splitList(prelude)) {
      if (selector.includes(":hover") && /\.ji\b/.test(selector)) out.push(selector.trim());
    }
  }
  return out;
}

test("hover articulation targets destination controls, not every link, button or menu row", () => {
  const selectors = hoverSelectors(icons);
  assert.ok(selectors.length >= 5, `found ${selectors.length} hover selectors`);
  for (const selector of selectors) {
    assert.match(selector, /^:is\(\[data-jicon-articulate\]/, `not opt-in: ${selector}`);
    assert.doesNotMatch(selector, /role="menuitem|role="option|role="tab"|\bsummary\b|\blabel\b/, `a scanned control articulates: ${selector}`);
  }
});

test("the icon motion runs on the product's duration and curve tokens", () => {
  for (const literal of ["120ms", "160ms", "220ms", "360ms", "70ms", "cubic-bezier("]) {
    assert.ok(!icons.includes(literal), `icons.css still hard-codes ${literal}`);
  }
  assert.match(icons, /--ji-soft: var\(--ease-out-soft\)/);
});

test("the dead svg.icon[data-motion] rules and the unused juno-glyphs renderer are gone", () => {
  assert.doesNotMatch(strip(read("src/app/globals.css")), /svg\.icon\[data-motion|\.juno-part/);
  assert.doesNotMatch(strip(read("src/components/design/host/editor.css")), /svg\.icon\[data-motion/);
  assert.equal(existsSync(path.join(root, "src/components/ui/juno-glyphs.tsx")), false);
});

test("destinations opt in: sidebar destination rows, the product switch, empty-state actions", () => {
  const sidebar = read("src/components/app/app-sidebar.tsx");
  assert.match(sidebar, /const articulate = moves \? "" : undefined;/);
  assert.equal((sidebar.match(/data-jicon-articulate=\{articulate\}/g) ?? []).length, 2, "link and button forms of NavRow");
  assert.match(read("src/components/app/product-switch.tsx"), /data-jicon-articulate=\{locked \? undefined : ""\}/);
  assert.match(read("src/components/ui/empty-state.tsx"), /data-jicon-articulate="within"/);
});

test("menus, the composer and message actions never opt in", () => {
  for (const file of [
    "src/components/ui/menu-recipe.ts",
    "src/components/ui/dropdown-menu.tsx",
    "src/components/chat/message-item.tsx",
    "src/components/chat/composer.tsx",
  ]) {
    if (!existsSync(path.join(root, file))) continue;
    assert.doesNotMatch(read(file), /data-jicon-articulate|jicon-hover/, file);
  }
});
