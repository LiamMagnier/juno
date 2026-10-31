import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown, isOnlyComments } from "@/components/chat/markdown";
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

test("HTML comments are notes in the source, never text on the page", () => {
  // A saved research report keeps its section markers; published or opened in
  // the canvas, they must not print (they name the product's codename, too).
  const html = render("# Title\n<!-- juno:section=bottom-line -->\n## Bottom line\nText <!-- inline note --> stays [1].");
  assert.doesNotMatch(html, /juno:section|inline note|&lt;!--/);
  assert.match(html, /Bottom line/);
  assert.match(html, /Text/);
  // Anything that is not only a comment is left exactly as before.
  assert.match(render("<!-- open and still streaming"), /&lt;!-- open and still streaming/);
  assert.match(render("<div>raw</div>"), /&lt;div&gt;raw&lt;\/div&gt;/);
});

test("only a node made of whole comments counts as comments, however they are nested or split", () => {
  assert.equal(isOnlyComments("<!-- a -->"), true);
  assert.equal(isOnlyComments("  <!-- a -->\n<!-- b -->  "), true);
  assert.equal(isOnlyComments("<!---->"), true);
  // Not only comments: text between or after them, an unclosed one, nothing at all.
  assert.equal(isOnlyComments("<!-- a --> text"), false);
  assert.equal(isOnlyComments("<!-- a --><b>x</b>"), false);
  assert.equal(isOnlyComments("<!-- open"), false);
  assert.equal(isOnlyComments("<!-->"), false);
  assert.equal(isOnlyComments(""), false);
  assert.equal(isOnlyComments(undefined), false);
  // A removal that would stitch a new opener together never makes it "only comments".
  assert.equal(isOnlyComments("<!<!-- x -->-- y -->"), false);
  assert.equal(isOnlyComments("<!-- a --><!-- b"), false);
  // And through the component: such a node stays visible text.
  assert.match(render("<!<!-- x -->-- y -->"), /&lt;!/);
});
