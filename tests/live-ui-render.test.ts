import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LiveUIBlock } from "@/components/chat/live-ui/live-ui-block";

(globalThis as { React?: typeof React }).React = React;

/* The web Live UI view rendered to markup: what a screen reader is told. */

const render = (view: unknown) => renderToStaticMarkup(React.createElement(LiveUIBlock, { source: JSON.stringify(view) }));

test("a reply that ended mid-block shows what arrived, without loading skeletons", () => {
  const cut = `{"title":"T","ui":[{"type":"slider","id":"a","label":"Amount","min":0,"max":5,"value":1},{"type":"metric","label":"x","value":"a*2"`;
  const ended = renderToStaticMarkup(React.createElement(LiveUIBlock, { source: cut, streaming: false }));
  assert.match(ended, /Amount/);
  assert.doesNotMatch(ended, /class="skeleton/);
  assert.doesNotMatch(ended, /aria-busy/);
  const streaming = renderToStaticMarkup(React.createElement(LiveUIBlock, { source: cut, streaming: true }));
  assert.match(streaming, /class="skeleton/);
});

test("a progress meter's accessible name is its label as shown, formulas filled in", () => {
  const html = render({
    data: { saved: 300 },
    ui: [{ type: "progress", label: "Saved {{saved}} of 1000", value: "saved", max: 1000 }],
  });
  const name = /role="meter" aria-label="([^"]*)"/.exec(html)?.[1];
  assert.equal(name, "Saved 300 of 1000");
});
