/**
 * The assistant's markdown headings are demoted two levels (src/lib/markdown-headings.ts).
 *
 * The transcript's outline is the conversation title (h1) and one hidden h2
 * per turn. A reply that opened with `# Title` used to put a second h1 on the
 * page, and its `##` sections landed level with the turn markers — so the
 * heading list a screen-reader user navigates by could no longer tell a
 * section of an answer from the start of the next turn. These pins stop the
 * map from silently losing an entry, and stop a future component-based
 * rewrite from dropping the attributes the citation audit stamps on headings.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type Options } from "react-markdown";
import { DEMOTED_HEADINGS } from "@/lib/markdown-headings";

type HastNode = {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

function render(markdown: string, rehypePlugins?: Options["rehypePlugins"]): string {
  return renderToStaticMarkup(
    createElement(ReactMarkdown, { components: DEMOTED_HEADINGS, rehypePlugins }, markdown)
  );
}

test("no heading the model writes can outrank the turn marker", () => {
  const html = render("# Title\n\n## Section\n\n### Sub\n\n#### Four\n\n##### Five\n\n###### Six");
  assert.doesNotMatch(html, /<h[12][\s>]/, "an h1 or h2 reached the transcript");
  assert.match(html, /<h3>Title<\/h3>/);
  assert.match(html, /<h4>Section<\/h4>/);
  assert.match(html, /<h5>Sub<\/h5>/);
  // Four, Five and Six all land on the floor — there is nothing under h6.
  assert.equal((html.match(/<h6>/g) ?? []).length, 3);
});

test("every markdown heading level is in the map", () => {
  for (const level of [1, 2, 3, 4, 5, 6]) {
    assert.ok(`h${level}` in DEMOTED_HEADINGS, `h${level} is not remapped`);
  }
});

test("the demotion keeps the attributes a rehype plugin stamped on the heading", () => {
  // The same shape as rehypeSourceOffsets in markdown.tsx: walk the tree and
  // write a data attribute onto every heading. If the demoted element lost
  // it, the citation audit could no longer locate a claim inside a heading.
  const stampHeadings = () => (tree: HastNode) => {
    const walk = (node: HastNode) => {
      if (node.type === "element" && /^h[1-6]$/.test(node.tagName ?? "")) {
        node.properties = { ...node.properties, dataSourceStart: "7" };
      }
      node.children?.forEach(walk);
    };
    walk(tree);
  };
  const html = render("# Title", [stampHeadings]);
  assert.match(html, /<h3 data-source-start="7">Title<\/h3>/);
  // A component that spread `node` onto the element would leak it as an attribute.
  assert.doesNotMatch(html, /\bnode=/);
});
