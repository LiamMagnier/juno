/**
 * Keeps "universal sibling" selectors out of the app's CSS.
 *
 * Chrome keys sibling invalidation on a class, id or attribute in the compound
 * left of `+` or `~`. A rule whose left compound has none, such as Tailwind 3's
 * `.space-y-4 > :not([hidden]) ~ :not([hidden])` or `.prose > * + *`, lands in
 * one "universal sibling" invalidation set instead. Chrome applies that set on
 * every insertion into a parent marked as having sibling-affected children, to
 * the siblings after the new element and their subtrees, whether or not the
 * rule could ever match there. A rule ending in `+ *` or `~ *` (the app has
 * several) is tried on every element, which marks every parent, so one
 * universal rule anywhere was enough: each row the
 * transcript mounted above the reader restyled 3,219 elements on the paged
 * fixture, the whole page; without them, 1.
 * docs/rework/program/PERFORMANCE.md, "Row insertion restyle".
 *
 * The plugin rewrites the Tailwind 3 space-* and divide-* selectors after
 * Tailwind has generated them, to the same elements at the same specificity:
 *
 *   X > :not([hidden]) ~ :not([hidden])   ->   X > :nth-child(n + 2 of :not([hidden]))
 *
 * "Not [hidden], with a not-[hidden] sibling before it" is "the second or later
 * of the children that are not [hidden]". Both add (0,2,0) to X. A positional
 * rule only restyles the children of a parent it was matched under, so the cost
 * stays with space-y containers. `:nth-child(of S)` needs Chrome 111, Firefox
 * 113 or Safari 9, all from 2023 or earlier.
 *
 * Hand-written rules are not rewritten. Write them without a sibling combinator
 * (`> :where(:not(:first-child))` for `> * + *`; `div:not(:first-child)` for
 * `div + div` where every child is a div, (0,1,1) against (0,0,2)), or give the left
 * side a class or attribute (`h3:where([data-md-heading]) + *`). The guard
 * test, tests/sibling-invalidation-guard.test.ts, fails on any that return.
 *
 * CommonJS because Next loads PostCSS plugins by path with require().
 */

/** postcss-selector-parser (Tailwind 3's own dependency), loaded only by the guard test. */
function selectorParser(transform) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- CommonJS file, see above
  return require("postcss-selector-parser")(transform);
}

// Only the exact child form Tailwind writes. The `>` makes the left
// `:not([hidden])` a whole compound: in `.a:not([hidden]) ~ …` or
// `.a + :not([hidden]) ~ …` the same text means something else, and rewriting it
// would change what the rule matches.
const TAILWIND_SIBLINGS = />\s*:not\(\[hidden\]\)\s*~\s*:not\(\[hidden\]\)/g;
const TAILWIND_REPLACEMENT = "> :nth-child(n + 2 of :not([hidden]))";

const FORGIVING = new Set([":is", ":where", ":matches", ":-webkit-any"]);

/**
 * True when Chrome can key a sibling invalidation set on this compound: it has a
 * class, id or attribute, and no :is()/:where() with a branch that has none.
 * Measured in Chrome 155 (a 40-row page, one insertion above the rows):
 * `h4:where([data-md-heading]) + *` and `:where(.ed-row):hover + *` restyle 1
 * element; `* + *`, `* ~ *`, `:hover + *`, `:is(h3, h4) + *` and even
 * `:is(h3, h4).md + *` restyle all 602, and `div + div` every row. A tag never
 * keys.
 */
function isKeyed(compound) {
  let keyed = false;
  for (const node of compound) {
    if (node.type === "class" || node.type === "id" || node.type === "attribute") keyed = true;
    else if (node.type === "pseudo" && FORGIVING.has(node.value)) {
      const branches = node.nodes ?? [];
      if (branches.length === 0 || !branches.every((branch) => isKeyed(lastCompound(branch)))) return false;
      keyed = true;
    }
  }
  return keyed;
}

function lastCompound(selector) {
  const compound = [];
  for (const node of selector.nodes) {
    if (node.type === "combinator") compound.length = 0;
    else if (node.type !== "comment") compound.push(node);
  }
  return compound;
}

/**
 * The complex selectors in `selectorText` that hold a universal sibling
 * combinator, including inside :is(), :where() and :not() (not :has(), whose
 * relative selectors are invalidated another way).
 */
function universalSiblingSelectors(selectorText) {
  const found = [];
  const visit = (selector) => {
    let compound = [];
    for (const node of selector.nodes) {
      if (node.type === "combinator") {
        const value = node.value.trim();
        if ((value === "+" || value === "~") && !isKeyed(compound)) found.push(selector.toString().trim());
        compound = [];
        continue;
      }
      if (node.type === "comment") continue;
      compound.push(node);
      if (node.type === "pseudo" && (FORGIVING.has(node.value) || node.value === ":not")) {
        for (const inner of node.nodes) visit(inner);
      }
    }
  };
  try {
    selectorParser((root) => root.each(visit)).processSync(selectorText);
  } catch {
    // Not a parseable selector (a keyframe stop, an @page margin box): nothing to report.
  }
  return [...new Set(found)];
}

function rewriteTailwindSiblings(selectorText) {
  return selectorText.replace(TAILWIND_SIBLINGS, TAILWIND_REPLACEMENT);
}

const plugin = () => ({
  postcssPlugin: "juno-sibling-invalidation",
  Rule(rule) {
    if (rule.parent?.type === "atrule" && /keyframes$/i.test(rule.parent.name)) return;
    const next = rewriteTailwindSiblings(rule.selector);
    if (next !== rule.selector) rule.selector = next;
  },
});
plugin.postcss = true;

module.exports = plugin;
module.exports.universalSiblingSelectors = universalSiblingSelectors;
module.exports.rewriteTailwindSiblings = rewriteTailwindSiblings;
