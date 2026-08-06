import assert from "node:assert/strict";
import test from "node:test";

import { layoutPage, layoutSubtree, measureText, resizeWithConstraints } from "../src/lib/design/layout";
import { renderNodeSvg, renderSelectionSvg } from "../src/lib/design/render";
import { PAGE_ID, run, signInDocument } from "./design-fixtures";

test("vertical auto layout stacks children with padding and gap", () => {
  const doc = signInDocument();
  const boxes = layoutPage(doc, PAGE_ID);

  const card = boxes.get("card")!;
  const title = boxes.get("title")!;
  const email = boxes.get("email")!;
  const button = boxes.get("button")!;

  assert.equal(title.x, card.x + 24, "left padding");
  assert.equal(title.y, card.y + 24, "top padding");
  assert.equal(email.y, title.y + title.height + 16, "gap after the title");
  assert.equal(button.y, email.y + email.height + 16, "gap after the field");
});

test("fill children take the container's content width", () => {
  const doc = signInDocument();
  const boxes = layoutPage(doc, PAGE_ID);
  const card = boxes.get("card")!;
  assert.equal(boxes.get("email")!.width, card.width - 48);
  assert.equal(boxes.get("button")!.width, card.width - 48);
});

test("hug height grows with content and shrinks again", () => {
  const doc = signInDocument();
  const before = layoutPage(doc, PAGE_ID).get("card")!.height;

  const taller = run(doc, [{ op: "updateNode", nodeId: "email", patch: { height: 88 } }]).document;
  const after = layoutPage(taller, PAGE_ID).get("card")!.height;
  assert.equal(after, before + 44, "the hug container absorbed the extra 44pt");

  const back = run(taller, [{ op: "updateNode", nodeId: "email", patch: { height: 44 } }]).document;
  assert.equal(layoutPage(back, PAGE_ID).get("card")!.height, before);
});

test("changing padding moves every child and resizes the hug parent", () => {
  const doc = signInDocument();
  const base = layoutPage(doc, PAGE_ID);
  const padded = run(doc, [
    {
      op: "setAutoLayout",
      nodeId: "card",
      layout: {
        direction: "vertical",
        padding: { top: 40, right: 24, bottom: 24, left: 32 },
        gap: 16,
        align: "start",
        justify: "start",
        wrap: false,
      },
    },
  ]).document;
  const next = layoutPage(padded, PAGE_ID);
  assert.equal(next.get("title")!.x, base.get("card")!.x + 32);
  assert.equal(next.get("title")!.y, base.get("card")!.y + 40);
  assert.equal(next.get("card")!.height, base.get("card")!.height + 16);
});

test("horizontal layout distributes and centres", () => {
  let doc = signInDocument();
  doc = run(doc, [
    {
      op: "setAutoLayout",
      nodeId: "button",
      layout: {
        direction: "horizontal",
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        gap: 8,
        align: "center",
        justify: "center",
        wrap: false,
      },
    },
    { op: "updateNode", nodeId: "buttonLabel", patch: { width: 60, height: 20, widthMode: "fixed", heightMode: "fixed" } },
  ]).document;

  const boxes = layoutPage(doc, PAGE_ID);
  const button = boxes.get("button")!;
  const label = boxes.get("buttonLabel")!;
  assert.equal(label.x, button.x + (button.width - 60) / 2);
  assert.equal(label.y, button.y + (button.height - 20) / 2);
});

test("wrapping breaks a horizontal row at the content width", () => {
  let doc = signInDocument();
  doc = run(doc, [
    {
      op: "setAutoLayout",
      nodeId: "card",
      layout: {
        direction: "horizontal",
        padding: { top: 0, right: 0, bottom: 0, left: 0 },
        gap: 10,
        align: "start",
        justify: "start",
        wrap: true,
      },
    },
    { op: "updateNode", nodeId: "title", patch: { width: 200, widthMode: "fixed", heightMode: "fixed", height: 40 } },
    { op: "updateNode", nodeId: "email", patch: { width: 200, widthMode: "fixed" } },
    { op: "updateNode", nodeId: "button", patch: { width: 200, widthMode: "fixed" } },
  ]).document;

  const boxes = layoutPage(doc, PAGE_ID);
  // 327 wide: two 200pt items cannot share a row, so each wraps.
  assert.equal(boxes.get("email")!.x, boxes.get("title")!.x);
  assert.ok(boxes.get("email")!.y > boxes.get("title")!.y, "second item wrapped to a new row");
});

test("absolute children ignore the flow", () => {
  let doc = signInDocument();
  doc = run(doc, [
    { op: "updateNode", nodeId: "email", patch: { layoutChild: { grow: false, absolute: true }, x: 5, y: 7 } },
  ]).document;
  const boxes = layoutPage(doc, PAGE_ID);
  const card = boxes.get("card")!;
  assert.equal(boxes.get("email")!.x, card.x + 5);
  assert.equal(boxes.get("email")!.y, card.y + 7);
  // The button now follows the title directly — the absolute field took no room.
  assert.equal(boxes.get("button")!.y, boxes.get("title")!.y + boxes.get("title")!.height + 16);
});

test("constraints reposition and stretch on resize", () => {
  const doc = signInDocument();
  const withConstraints = run(doc, [
    { op: "setConstraints", nodeIds: ["card"], constraints: { horizontal: "stretch", vertical: "center" } },
  ]).document;

  const updates = resizeWithConstraints(withConstraints, "screen", { width: 375, height: 812 }, { width: 500, height: 900 });
  const card = updates.find((u) => u.nodeId === "card")!;
  assert.equal(card.width, 327 + 125, "stretch grows with the parent");
  // centre: the card's centre stays at the same fraction of the parent.
  const originalCentreRatio = (200 + 240 / 2) / 812;
  assert.equal(card.y, Math.round((900 * originalCentreRatio - 240 / 2) * 1000) / 1000);
});

test("scale constraint scales both position and size", () => {
  const doc = run(signInDocument(), [
    { op: "setConstraints", nodeIds: ["card"], constraints: { horizontal: "scale", vertical: "scale" } },
  ]).document;
  const [update] = resizeWithConstraints(doc, "screen", { width: 375, height: 812 }, { width: 750, height: 1624 });
  assert.equal(update.x, 48);
  assert.equal(update.width, 654);
  assert.equal(update.y, 400);
});

test("min constraint pins to the top-left and does not move", () => {
  const doc = signInDocument();
  const updates = resizeWithConstraints(doc, "screen", { width: 375, height: 812 }, { width: 500, height: 900 });
  assert.deepEqual(updates, [], "a min/min child needs no update at all");
});

test("layout is deterministic across repeated runs", () => {
  const doc = signInDocument();
  const a = [...layoutPage(doc, PAGE_ID).entries()].sort();
  const b = [...layoutPage(doc, PAGE_ID).entries()].sort();
  assert.deepEqual(a, b);
});

test("layoutSubtree places the root at the origin", () => {
  const doc = signInDocument();
  const boxes = layoutSubtree(doc, "card");
  assert.equal(boxes.get("card")!.x, 0);
  assert.equal(boxes.get("card")!.y, 0);
  assert.equal(boxes.get("title")!.x, 24);
});

test("text measurement wraps and reports line count", () => {
  const typography = {
    fontFamily: "Inter",
    fontSize: 16,
    fontWeight: 400,
    lineHeight: { unit: "percent" as const, value: 150 },
    letterSpacing: 0,
    textAlign: "left" as const,
    verticalAlign: "top" as const,
  };
  const single = measureText("Hello", typography, 0);
  assert.equal(single.lines, 1);
  assert.equal(single.height, 24);

  const wrapped = measureText("the quick brown fox jumps over the lazy dog", typography, 100);
  assert.ok(wrapped.lines > 1, "long text wraps inside a narrow box");
  assert.equal(wrapped.height, wrapped.lines * 24);

  const explicit = measureText("a\nb\nc", typography, 0);
  assert.equal(explicit.lines, 3);
});

test("the renderer emits inert, escaped SVG with node ids only when asked", () => {
  const doc = run(signInDocument(), [
    { op: "updateNode", nodeId: "buttonLabel", patch: { characters: "<script>alert(1)</script> & \"go\"" } },
  ]).document;

  const rendered = renderNodeSvg(doc, "button", { includeNodeIds: true })!;
  assert.ok(rendered.svg.startsWith("<svg "));
  assert.ok(rendered.svg.includes('data-juno-node="button"'));
  assert.ok(!rendered.svg.includes("<script"), "user text must never re-enter as markup");
  assert.ok(rendered.svg.includes("&lt;script&gt;"));

  const exported = renderNodeSvg(doc, "button")!;
  assert.ok(!exported.svg.includes("data-juno-node"), "exports carry no Juno internals");
});

test("a selection render is cropped to the selection plus padding", () => {
  const doc = signInDocument();
  const rendered = renderSelectionSvg(doc, PAGE_ID, ["button"], 10)!;
  const box = layoutPage(doc, PAGE_ID).get("button")!;
  assert.equal(rendered.width, box.width + 20);
  assert.equal(rendered.height, box.height + 20);
});
