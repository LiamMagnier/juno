/**
 * No "universal sibling" selector reaches the app's CSS (PERFORMANCE.md, "Row
 * insertion restyle").
 *
 * A `+` or `~` whose left-hand compound has no class, id or attribute (Tailwind
 * 3's `.space-y-4 > :not([hidden]) ~ :not([hidden])`, `.prose > * + *`,
 * `div + div`, `:hover + *`, `:is(h3, h4) + *`) goes into Chrome's one
 * universal sibling invalidation set, which Chrome applies on every insertion
 * to the siblings after the new element and their subtrees. A single such rule
 * anywhere in the page made each row the transcript mounted restyle the whole
 * page: 3,219 elements per insert on the paged fixture, 1 with none of these
 * rules (scripts/perf/trace-row-insert-restyle.mjs). The last test in
 * e2e/transcript-history.spec.ts measures the same thing in Chrome; this guard
 * keeps the rules out of the CSS.
 *
 * The guard runs the real pipeline: the plugins postcss.config.mjs names, over
 * every stylesheet under src/ (dev-only pages aside) and the third-party sheets
 * the app imports. Tailwind scans the components, so arbitrary variants such as
 * `[&>p+p]:mt-2` are covered too.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import postcss, { type AcceptedPlugin } from "postcss";
import { Markdown } from "@/components/chat/markdown";
import { TooltipProvider } from "@/components/ui/tooltip";

const require = createRequire(import.meta.url);
const root = process.cwd();
const sibling = require(path.join(root, "scripts/postcss/sibling-invalidation.cjs")) as {
  universalSiblingSelectors(selector: string): string[];
  rewriteTailwindSiblings(selector: string): string;
};

test("the classifier flags the selectors that restyled the transcript, and only those", () => {
  const flagged = [
    ".space-y-4 > :not([hidden]) ~ :not([hidden])",
    ".divide-y > :not([hidden]) ~ :not([hidden])",
    ".prose-juno.prose-juno > * + *",
    ".prose-juno.prose-juno > :is(h3, h4, h5, h6) + *",
    ".prose-juno.prose-juno > :is(h3, h4).md-heading + *",
    ".ed-list > * + *::before",
    ".ed-list > :hover + *::before",
    ".alv-ledger > div + div",
    ".\\[\\&\\>section\\+section\\]\\:mt-5>section+section",
    ".a :is(.b, p + p)",
  ];
  for (const selector of flagged) assert.equal(sibling.universalSiblingSelectors(selector).length, 1, selector);

  const clean = [
    ".space-y-4 > :nth-child(n + 2 of :not([hidden]))",
    ".prose-juno.prose-juno > :where(:not(:first-child))",
    ".prose-juno.prose-juno > h3:where([data-md-heading]) + *",
    ".ed-list > :where(.ed-row):hover + *::before",
    ".vs-face + .vs-face",
    ".peer:checked ~ .peer-checked\\:block",
    ".research-document .report-group:has(> .prose-juno > :is(h3, h4, h5):last-child) + .report-group",
    ".research-document .prose-juno li > p:has(+ p)",
    ".alv-ledger > div:not(:first-child)",
  ];
  for (const selector of clean) assert.deepEqual(sibling.universalSiblingSelectors(selector), [], selector);
});

test("Tailwind's space and divide selectors become positional, same elements and specificity", () => {
  assert.equal(
    sibling.rewriteTailwindSiblings(".space-y-4 > :not([hidden]) ~ :not([hidden])"),
    ".space-y-4 > :nth-child(n + 2 of :not([hidden]))",
  );
  assert.equal(
    sibling.rewriteTailwindSiblings(".\\[\\&_ul\\]\\:space-y-2 ul > :not([hidden]) ~ :not([hidden])"),
    ".\\[\\&_ul\\]\\:space-y-2 ul > :nth-child(n + 2 of :not([hidden]))",
  );
  assert.equal(
    sibling.rewriteTailwindSiblings(".x>:not([hidden])~:not([hidden])"),
    ".x> :nth-child(n + 2 of :not([hidden]))",
  );
  assert.equal(sibling.rewriteTailwindSiblings(".vs-face + .vs-face"), ".vs-face + .vs-face");
  // The same text where `:not([hidden])` is not a whole compound after `>` means
  // something else, and must be left alone.
  for (const other of [
    ".a:not([hidden]) ~ :not([hidden])",
    ".a > .b:not([hidden]) ~ :not([hidden])",
    ".a + :not([hidden]) ~ :not([hidden])",
    ".a ~ :not([hidden]) ~ :not([hidden])",
  ]) {
    assert.equal(sibling.rewriteTailwindSiblings(other), other, other);
  }
});

function stylesheets(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      // Dev-only pages (page.dev.tsx) are not in a production build.
      if (entry.isDirectory()) { if (full !== path.join(root, "src/app/dev")) walk(full); }
      else if (entry.name.endsWith(".css")) out.push(full);
    }
  };
  walk(path.join(root, "src"));
  return out.sort();
}

async function pipeline(): Promise<AcceptedPlugin[]> {
  const config = (await import(path.join(root, "postcss.config.mjs"))).default as { plugins: Record<string, object> };
  const names = Object.keys(config.plugins);
  assert.ok(names.includes("./scripts/postcss/sibling-invalidation.cjs"), "postcss.config.mjs must run the sibling-invalidation plugin");
  assert.ok(names.indexOf("./scripts/postcss/sibling-invalidation.cjs") > names.indexOf("tailwindcss"), "the plugin must run after Tailwind");
  return names.map((name) => {
    const plugin = require(name.startsWith(".") ? path.join(root, name) : name);
    return plugin(config.plugins[name]);
  });
}

test("no stylesheet the app ships has a universal sibling selector", { timeout: 180_000 }, async () => {
  const plugins = await pipeline();
  const found: string[] = [];
  for (const file of stylesheets()) {
    const result = await postcss(plugins).process(fs.readFileSync(file, "utf8"), { from: file });
    result.root.walkRules((rule) => {
      for (const selector of sibling.universalSiblingSelectors(rule.selector)) found.push(`${path.relative(root, file)}: ${selector}`);
    });
  }
  for (const file of ["katex/dist/katex.min.css", "@xterm/xterm/css/xterm.css"]) {
    postcss.parse(fs.readFileSync(require.resolve(file), "utf8")).walkRules((rule) => {
      for (const selector of sibling.universalSiblingSelectors(rule.selector)) found.push(`${file}: ${selector}`);
    });
  }
  assert.deepEqual(found, [], `Each of these makes Chrome restyle a parent's whole subtree on every DOM insertion:\n${found.join("\n")}`);
});

test("markdown headings carry the attribute the heading rhythm rules key on", () => {
  const html = renderToStaticMarkup(
    createElement(TooltipProvider, null, createElement(Markdown, { content: "# Title\n\nBody.\n\n## Section\n\nMore." })),
  );
  assert.match(html, /<h3 data-md-heading=""[^>]*>Title<\/h3>/);
  assert.match(html, /<h4 data-md-heading=""[^>]*>Section<\/h4>/);
  assert.doesNotMatch(html, /<p data-md-heading/);
  const css = fs.readFileSync(path.join(root, "src/app/globals.css"), "utf8");
  assert.match(css, /\.prose-juno\.prose-juno > h3:where\(\[data-md-heading\]\) \+ \*/);
});
