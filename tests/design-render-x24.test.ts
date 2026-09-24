/**
 * X-24: a container's opacity, rotation, blend mode and effects reach its
 * children — and a plain group's do too.
 *
 * The renderer used to hang all four on the container's own shape element and
 * nowhere else, then paint the children after it as separate elements. So a
 * frame at 50% drew its contents at full strength, a rotated frame left them
 * upright, and a group with no fill of its own applied them to nothing. The
 * HTML, React and SwiftUI exports nest, so they did apply them: the canvas and
 * the code the same document generates disagreed.
 *
 * These tests read the SVG as a tree (a small strict parser below, which also
 * refuses a duplicated attribute) and ask the question that matters: is the
 * child *inside* an element that carries the parent's setting? Matching whole
 * strings would fail on every cosmetic change and prove nothing about nesting.
 *
 * Run: NODE_OPTIONS=--conditions=react-server npx tsx --test --experimental-test-module-mocks tests/design-render-x24.test.ts
 */

import assert from "node:assert/strict";
import test from "node:test";

import { renderNodeSvg, renderPageSvg } from "../src/lib/design/render";
import { exportHtmlPrototype } from "../src/lib/design/export";
import { defaultEffect } from "../src/lib/design/schema";
import { PAGE_ID, run, signInDocument } from "./design-fixtures";
import type { DesignOperation } from "../src/lib/design/operations";
import type { DesignDocument, GlassEffect } from "../src/lib/design/types";

// ---------------------------------------------------------------------------
// A strict little SVG reader
// ---------------------------------------------------------------------------

interface Element {
  name: string;
  attrs: Record<string, string>;
  parent: Element | null;
  children: Element[];
}

/**
 * The renderer's output as a tree. Strict on purpose: every attribute quoted,
 * none repeated, every tag closed in order. A browser's HTML parser forgives
 * all three (it keeps the first of two `transform`s and says nothing), which is
 * exactly how a malformed export hid for as long as it did.
 */
function parseSvg(svg: string): Element {
  const root: Element = { name: "#root", attrs: {}, parent: null, children: [] };
  let current = root;
  for (const [token] of svg.matchAll(/<[^>]*>/g)) {
    const closing = /^<\/([\w:-]+)\s*>$/.exec(token);
    if (closing) {
      assert.equal(current.name, closing[1], `</${closing[1]}> closes <${current.name}>`);
      current = current.parent!;
      continue;
    }
    const open = /^<([\w:-]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>$/.exec(token);
    assert.ok(open, `malformed tag: ${token.slice(0, 120)}`);
    const attrs: Record<string, string> = {};
    for (const [, key, value] of open[2].matchAll(/\s([\w:-]+)="([^"]*)"/g)) {
      assert.ok(!(key in attrs), `duplicate attribute ${key} on <${open[1]}>`);
      attrs[key] = value;
    }
    const element: Element = { name: open[1], attrs, parent: current, children: [] };
    current.children.push(element);
    if (!open[3]) current = element;
  }
  assert.equal(current, root, "every element is closed");
  return root;
}

function find(root: Element, predicate: (element: Element) => boolean): Element | null {
  for (const child of root.children) {
    if (predicate(child)) return child;
    const deeper = find(child, predicate);
    if (deeper) return deeper;
  }
  return null;
}

function byNode(root: Element, id: string): Element {
  const element = find(root, (e) => e.attrs["data-juno-node"] === id);
  assert.ok(element, `an element for ${id}`);
  return element;
}

/** The nearest ancestor that carries `attr`, or null. */
function ancestorWith(element: Element, attr: string): Element | null {
  for (let cursor = element.parent; cursor; cursor = cursor.parent) {
    if (attr in cursor.attrs) return cursor;
  }
  return null;
}

function render(doc: DesignDocument): Element {
  return parseSvg(renderPageSvg(doc, PAGE_ID, { includeNodeIds: true }).svg);
}

const update = (nodeId: string, patch: Record<string, unknown>): DesignOperation =>
  ({ op: "updateNode", nodeId, patch }) as DesignOperation;

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

test("a frame's opacity fades its children with it, once", () => {
  const tree = render(run(signInDocument(), [update("card", { opacity: 0.5 })]).document);

  const title = byNode(tree, "title");
  const faded = ancestorWith(title, "opacity");
  assert.ok(faded, "the title sits inside the element that fades");
  assert.equal(faded.attrs.opacity, "0.5");
  // The card's own box is inside the same group and carries no opacity of its
  // own — otherwise the fill would be faded twice and the children once.
  const card = byNode(tree, "card");
  assert.equal(card.attrs.opacity, undefined);
  assert.equal(ancestorWith(card, "opacity"), faded);
  assert.equal(title.attrs.opacity, undefined);
});

test("almost invisible and invisible now agree about the children", () => {
  // Opacity 0 always hid the subtree (an early return), while 0.01 left the
  // children at full strength — a cliff between two values a slider passes
  // through. Now both reach the children.
  const faint = render(run(signInDocument(), [update("card", { opacity: 0.01 })]).document);
  assert.equal(ancestorWith(byNode(faint, "buttonLabel"), "opacity")?.attrs.opacity, "0.01");

  const hidden = renderPageSvg(run(signInDocument(), [update("card", { opacity: 0 })]).document, PAGE_ID, { includeNodeIds: true }).svg;
  assert.doesNotMatch(hidden, /data-juno-node="title"/);
});

test("a rotated frame turns its children about its own centre", () => {
  const doc = run(signInDocument(), [update("card", { rotation: 30 })]).document;
  const tree = render(doc);

  const title = byNode(tree, "title");
  const turned = ancestorWith(title, "transform");
  assert.ok(turned, "the title sits inside the rotation");
  const card = byNode(tree, "card");
  assert.equal(card.attrs.transform, undefined, "the card's box is turned by the group, not by itself as well");
  assert.equal(ancestorWith(card, "transform"), turned);

  const match = /^rotate\(30 ([\d.]+) ([\d.]+)\)$/.exec(turned.attrs.transform);
  assert.ok(match, turned.attrs.transform);
  // The card is 327 wide at x 24; its centre, not the child's, is the pivot.
  assert.equal(Number(match[1]), 24 + 327 / 2);
});

test("a rotated clipping frame's clip turns with its contents", () => {
  // The screen clips its contents. The clip group used to sit outside any
  // rotation, so a turned screen was clipped by an upright rectangle.
  const tree = render(run(signInDocument(), [update("screen", { rotation: 12 })]).document);
  const clipped = ancestorWith(byNode(tree, "card"), "clip-path");
  assert.ok(clipped);
  assert.match(ancestorWith(clipped, "transform")?.attrs.transform ?? "", /^rotate\(12 /);
});

test("a frame's blend mode composites its contents as one layer", () => {
  const tree = render(run(signInDocument(), [update("button", { blendMode: "multiply" })]).document);
  const blended = ancestorWith(byNode(tree, "buttonLabel"), "style");
  assert.equal(blended?.attrs.style, "mix-blend-mode:multiply");
  assert.equal(byNode(tree, "button").attrs.style, undefined);
});

test("a frame's layer blur blurs its contents, in the same ordered chain", () => {
  const doc = run(signInDocument(), [update("card", { effects: [{ type: "layer-blur", radius: 8 }] })]).document;
  const svg = renderPageSvg(doc, PAGE_ID, { includeNodeIds: true }).svg;
  const tree = parseSvg(svg);

  const filtered = ancestorWith(byNode(tree, "title"), "filter");
  assert.ok(filtered, "the title is inside the blur");
  assert.equal(byNode(tree, "card").attrs.filter, undefined, "and the blur is applied once, not once more on the box");
  assert.equal((svg.match(/ filter="url\(#jd[0-9a-z]+\)"/g) ?? []).length, 1);
});

// ---------------------------------------------------------------------------
// Plain groups
// ---------------------------------------------------------------------------

function withGroup(patch: Record<string, unknown>): DesignDocument {
  return run(signInDocument(), [
    { op: "createNode", parentId: null, pageId: PAGE_ID, node: { type: "group", id: "icons", name: "Icons", patch: { x: 400, y: 0, width: 120, height: 40 } } },
    {
      op: "createNode",
      parentId: "icons",
      pageId: PAGE_ID,
      node: { type: "rectangle", id: "dot1", name: "Dot", patch: { x: 0, y: 0, width: 40, height: 40, fills: [{ type: "solid", color: { r: 1, g: 0, b: 0, a: 1 } }] } },
    },
    {
      op: "createNode",
      parentId: "icons",
      pageId: PAGE_ID,
      node: { type: "ellipse", id: "dot2", name: "Dot", patch: { x: 80, y: 0, width: 40, height: 40, fills: [{ type: "solid", color: { r: 0, g: 0, b: 1, a: 1 } }] } },
    },
    update("icons", patch),
  ]).document;
}

test("a plain group's opacity, rotation and blend reach its children", () => {
  const tree = render(withGroup({ opacity: 0.4, rotation: 15, blendMode: "screen" }));

  // A group with no paint of its own draws no box — there is nothing of its
  // own to hang the settings on, which is why they used to apply to nothing.
  assert.equal(find(tree, (e) => e.attrs["data-juno-node"] === "icons"), null);

  for (const id of ["dot1", "dot2"]) {
    const dot = byNode(tree, id);
    const layer = ancestorWith(dot, "opacity");
    assert.ok(layer, `${id} is inside the group's layer`);
    assert.equal(layer.attrs.opacity, "0.4");
    assert.match(layer.attrs.transform, /^rotate\(15 /);
    assert.equal(layer.attrs.style, "mix-blend-mode:screen");
    assert.equal(dot.attrs.opacity, undefined);
  }
  // Both dots in the SAME group: the group is flattened, then faded.
  assert.equal(ancestorWith(byNode(tree, "dot1"), "opacity"), ancestorWith(byNode(tree, "dot2"), "opacity"));
});

test("a group with nothing to carry is not wrapped at all", () => {
  const svg = renderPageSvg(withGroup({}), PAGE_ID, { includeNodeIds: true }).svg;
  const tree = parseSvg(svg);
  // The dots sit directly on the page, exactly as before the fix.
  assert.equal(byNode(tree, "dot1").parent?.name, "svg");
});

// ---------------------------------------------------------------------------
// What did not change
// ---------------------------------------------------------------------------

test("a lone layer keeps its settings on its own element", () => {
  // The overwhelmingly common case, and the markup every snapshot holds.
  const doc = run(signInDocument(), [update("email", { opacity: 0.5, rotation: 10, blendMode: "multiply" })]).document;
  const email = byNode(render(doc), "email");
  assert.equal(email.attrs.opacity, "0.5");
  assert.match(email.attrs.transform, /^rotate\(10 /);
  assert.equal(email.attrs.style, "mix-blend-mode:multiply");
  assert.equal(ancestorWith(email, "opacity"), null);
});

test("a rotated vector is well-formed, with its rotation outermost", () => {
  const doc = run(signInDocument(), [
    {
      op: "createNode",
      parentId: null,
      pageId: PAGE_ID,
      node: { type: "path", id: "tick", name: "Tick", patch: { x: 500, y: 100, width: 20, height: 20, d: "M0 10 L8 18 L20 2", rotation: 45 } },
    },
  ]).document;
  // `parseSvg` refuses a repeated attribute; the path's group used to carry
  // `transform` twice, which made the whole SVG export refuse to open.
  const tick = byNode(render(doc), "tick");
  assert.equal(tick.attrs.transform, "rotate(45 510 110) translate(500 100)");
});

test("the canvas and the HTML export now nest the same way", () => {
  // The HTML prototype always put the title inside the card's div, and the div
  // carries the card's opacity and rotation — which is the behaviour the
  // renderer has now caught up with, not a new one.
  const doc = run(signInDocument(), [update("card", { opacity: 0.5, rotation: 30 })]).document;
  const html = exportHtmlPrototype(doc, PAGE_ID).content;
  const cardAt = html.indexOf('data-juno-node="card"');
  const titleAt = html.indexOf('data-juno-node="title"');
  assert.ok(cardAt > 0 && titleAt > cardAt);
  assert.match(html.slice(cardAt, titleAt), /opacity: 0\.5; transform: rotate\(30deg\)/);

  const title = byNode(render(doc), "title");
  assert.equal(ancestorWith(title, "opacity")?.attrs.opacity, "0.5");
  assert.match(ancestorWith(title, "transform")?.attrs.transform ?? "", /^rotate\(30 /);
});

// ---------------------------------------------------------------------------
// Backdrops inside a layer
// ---------------------------------------------------------------------------

const GLASS = defaultEffect("glass") as GlassEffect;

test("a faded glass layer fades its backdrop with it", () => {
  // CSS applies an element's opacity to its backdrop-filtered backdrop as well;
  // the canvas used to leave the blurred copy at full strength under a faded
  // tint.
  const doc = run(signInDocument(), [update("email", { effects: [GLASS], opacity: 0.6 })]).document;
  const tree = render(doc);
  const layer = ancestorWith(byNode(tree, "email"), "opacity");
  assert.equal(layer?.attrs.opacity, "0.6");
  const backdrop = find(layer!, (e) => e.name === "g" && "clip-path" in e.attrs);
  assert.ok(backdrop, "the backdrop is inside the faded layer");
});

test("a backdrop inside a rotated frame copies what is behind it back into place", () => {
  // A stripe painted before the card, which the glass button inside the card
  // samples. The copy is drawn inside the card's rotation, so it has to be
  // un-rotated or the glass would blur a tilted stripe.
  const doc = run(signInDocument(), [
    {
      op: "createNode",
      parentId: "screen",
      pageId: PAGE_ID,
      index: 0,
      node: {
        type: "rectangle",
        id: "stripe",
        name: "Stripe",
        patch: { x: 0, y: 380, width: 375, height: 60, fills: [{ type: "solid", color: { r: 0.9, g: 0.2, b: 0.2, a: 1 } }] },
      },
    },
    update("card", { rotation: 20 }),
    update("button", { effects: [GLASS] }),
  ]).document;
  const svg = renderPageSvg(doc, PAGE_ID).svg;
  parseSvg(svg);
  const card = doc.nodes.card;
  // The inverse of the card's own rotation, about the card's own centre.
  assert.match(svg, new RegExp(`<g transform="rotate\\(-20 ${24 + card.width / 2} [\\d.]+\\)"><rect[^>]*fill="rgba\\(230, 51, 51, 1\\)"`));
});

test("a translucent glass stack still grows linearly", () => {
  // Wrapping a glass layer in its own group must not smuggle its backdrop copy
  // back into what the next layer samples — the compounding `pushBackdrop`
  // exists to stop, reached through the new door.
  const stack = (count: number) => {
    let doc = signInDocument();
    for (let i = 0; i < count; i += 1) {
      doc = run(doc, [
        {
          op: "createNode",
          parentId: null,
          pageId: PAGE_ID,
          node: { type: "rectangle", id: `glass${i}`, name: `Glass ${i}`, patch: { x: 10 + i * 4, y: 10 + i * 4, width: 300, height: 300, opacity: 0.9, effects: [GLASS] } },
        },
      ]).document;
    }
    return renderPageSvg(doc, PAGE_ID).svg.length;
  };
  const one = stack(1);
  const four = stack(4);
  assert.ok(four < one * 6, `1 layer ${one} bytes, 4 layers ${four}`);
});

// ---------------------------------------------------------------------------
// Fitting a render to what it draws
// ---------------------------------------------------------------------------

test("fit: content crops to the drawn layers, not to the page origin", () => {
  const moved = run(signInDocument(), [update("screen", { x: 2000, y: 500 })]).document;
  const page = renderPageSvg(moved, PAGE_ID);
  assert.equal(page.x, 0, "the default still measures from the origin");

  const fitted = renderPageSvg(moved, PAGE_ID, { fit: "content" });
  assert.equal(fitted.x, 2000);
  assert.equal(fitted.y, 500);
  assert.equal(fitted.width, 375);
  assert.equal(fitted.height, 812);
  parseSvg(fitted.svg);
});

test("fit: content reaches as far as a shadow and around a rotation", () => {
  const shadowed = run(signInDocument(), [
    update("screen", { effects: [{ type: "drop-shadow", color: { r: 0, g: 0, b: 0, a: 0.3 }, offsetX: 0, offsetY: 8, blur: 24, spread: 0 }] }),
  ]).document;
  const fitted = renderPageSvg(shadowed, PAGE_ID, { fit: "content" });
  assert.ok(fitted.x < 0 && fitted.y < 0 && fitted.width > 375 && fitted.height > 812, JSON.stringify(fitted));

  const turned = renderPageSvg(run(signInDocument(), [update("screen", { rotation: 90 })]).document, PAGE_ID, { fit: "content" });
  // A tall screen turned a quarter is a wide picture.
  assert.ok(Math.abs(turned.width - 812) < 0.01 && Math.abs(turned.height - 375) < 0.01, JSON.stringify(turned));
});

test("a subtree render is unchanged in shape", () => {
  // `renderNodeSvg` feeds the AI crop and every frame export; it still starts
  // at its own origin and still parses.
  const rendered = renderNodeSvg(run(signInDocument(), [update("card", { opacity: 0.5 })]).document, "card");
  assert.ok(rendered);
  assert.equal(rendered.x, 0);
  parseSvg(rendered.svg);
});
