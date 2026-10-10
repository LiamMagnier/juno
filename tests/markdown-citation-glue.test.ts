import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/chat/markdown";
import { TooltipProvider } from "@/components/ui/tooltip";

/*
 * A run of citation chips stays on the line of the word it cites, and the
 * report's prices render as text, through the real Markdown component.
 */

const sources = Array.from({ length: 5 }, (_, i) => ({
  title: `Source ${i + 1}`,
  url: `https://example${i + 1}.com/page`,
  snippet: "",
  cited: true,
}));

const render = (content: string) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, createElement(Markdown, { content, sources })));

test("chips are glued to the word before them, and the text is unchanged", () => {
  const html = render("the best value today [1][2][3]. Next sentence.");
  assert.match(html, /<span class="cite-glue">today <span data-cite="1">/);
  assert.match(html, /data-cite="3"/);
  assert.match(html, /the best value <span class="cite-glue">/);
});

test("a very long token is not glued (it must stay free to wrap)", () => {
  const id = "claude-max-5x-weekly-usage-limit-agentic-coding-sessions-reset-window";
  const html = render(`identifiers like ${id} [4].`);
  assert.match(html, new RegExp(`${id} <span class="cite-glue"><span data-cite="4">`));
});

test("the report's price strings render as text, not KaTeX", () => {
  const html = render("$100–$250 price band, Claude Max 5x ($100/month)");
  assert.doesNotMatch(html, /katex|math-inline/);
  assert.match(html, /\$100–\$250 price band, Claude Max 5x \(\$100\/month\)/);
});
