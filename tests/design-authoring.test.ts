import assert from "node:assert/strict";
import test from "node:test";

import { authoredDesignSchema, expandAuthoredDesign, normalizeDesignArtifact } from "../src/lib/design/authoring";
import { parseStoredDesignDocument, serializeDesignDocument } from "../src/lib/design/migrations";
import { layoutPage } from "../src/lib/design/layout";
import { renderPageSvg } from "../src/lib/design/render";
import { DesignValidationError } from "../src/lib/design/schema";

/**
 * The path a model's output actually travels: compact JSON → expansion through
 * the operation layer → a document the editor can open. If this breaks, asking
 * Juno for a design produces an artifact that will not open, which is exactly
 * the failure this file exists to prevent.
 */

/** The example the system prompt shows the model, verbatim in spirit. */
const SIGN_IN = {
  name: "Sign in",
  background: "#f5f5f7",
  nodes: [
    {
      type: "frame" as const,
      name: "Screen",
      width: 375,
      height: 812,
      fill: "#ffffff",
      clip: true,
      children: [
        { type: "text" as const, name: "Title", text: "Welcome back", x: 24, y: 96, width: 327, fontSize: 28, fontWeight: 600 },
        {
          type: "frame" as const,
          name: "Card",
          x: 24,
          y: 180,
          width: 327,
          fill: "#ffffff",
          radius: 16,
          heightMode: "hug" as const,
          layout: { direction: "vertical" as const, gap: 16, padding: [24, 24, 24, 24], align: "start" as const, justify: "start" as const, wrap: false },
          children: [
            { type: "rectangle" as const, name: "Email field", height: 44, radius: 8, fill: "#f2f2f5", widthMode: "fill" as const },
            {
              type: "frame" as const,
              name: "Sign in button",
              height: 48,
              radius: 8,
              fill: "#334de6",
              widthMode: "fill" as const,
              children: [{ type: "text" as const, name: "Label", text: "Sign in", x: 120, y: 14, fill: "#ffffff", fontWeight: 600 }],
            },
          ],
        },
      ],
    },
  ],
};

test("the prompt's own example parses and expands into a valid document", () => {
  const authored = authoredDesignSchema.parse(SIGN_IN);
  const document = expandAuthoredDesign(authored, "seed-1");

  // Valid by the same rules the editor and the Mac enforce.
  assert.doesNotThrow(() => parseStoredDesignDocument(serializeDesignDocument(document)));
  assert.equal(document.name, "Sign in");
  assert.equal(document.pages.length, 1);
  assert.equal(Object.keys(document.nodes).length, 6);
  assert.equal(document.revision, 1, "a fresh design starts at a revision an edit can build on");
});

test("the expanded design lays out the way the author described it", () => {
  const document = expandAuthoredDesign(authoredDesignSchema.parse(SIGN_IN), "seed-1");
  const boxes = layoutPage(document, document.pages[0].id);
  const byName = (name: string) =>
    boxes.get(Object.values(document.nodes).find((n) => n.name === name)!.id)!;

  const screen = byName("Screen");
  assert.equal(screen.width, 375);
  assert.equal(screen.height, 812);

  const card = byName("Card");
  assert.equal(card.x, 24);
  // hug height: 24 padding + 44 field + 16 gap + 48 button + 24 padding
  assert.equal(card.height, 156);

  // `widthMode: fill` really fills the card's content width.
  assert.equal(byName("Email field").width, 327 - 48);
  assert.equal(byName("Sign in button").width, 327 - 48);

  // Auto layout stacked them, so the button follows the field plus the gap.
  assert.equal(byName("Sign in button").y, byName("Email field").y + 44 + 16);
});

test("the expanded design renders", () => {
  const document = expandAuthoredDesign(authoredDesignSchema.parse(SIGN_IN), "seed-1");
  const rendered = renderPageSvg(document, document.pages[0].id);
  assert.ok(rendered.svg.startsWith("<svg "));
  assert.ok(rendered.svg.includes("Welcome back"));
  assert.ok(rendered.svg.includes("Sign in"));
  // The button's fill made it through as a colour, not a literal hex string.
  assert.ok(rendered.svg.includes("rgba(51, 77, 230, 1)"));
});

test("expansion is deterministic, so a regeneration does not churn ids", () => {
  const a = expandAuthoredDesign(authoredDesignSchema.parse(SIGN_IN), "same-seed");
  const b = expandAuthoredDesign(authoredDesignSchema.parse(SIGN_IN), "same-seed");
  assert.equal(serializeDesignDocument(a), serializeDesignDocument(b));
});

test("only the type is required — a bare node still expands", () => {
  const document = expandAuthoredDesign(authoredDesignSchema.parse({ nodes: [{ type: "rectangle" }] }), "s");
  assert.equal(Object.keys(document.nodes).length, 1);
  const node = Object.values(document.nodes)[0];
  assert.equal(node.type, "rectangle");
  assert.ok(node.width > 0 && node.height > 0, "defaults give it a real size");
});

test("text authored without a colour is still legible", () => {
  const document = expandAuthoredDesign(authoredDesignSchema.parse({ nodes: [{ type: "text", text: "Hi" }] }), "s");
  const node = Object.values(document.nodes)[0];
  assert.equal(node.fills.length, 1, "text defaults to a dark fill rather than invisible");
});

// ---------------------------------------------------------------------------
// The storage boundary
// ---------------------------------------------------------------------------

test("a compact body is expanded on the way into storage", () => {
  const stored = normalizeDesignArtifact(JSON.stringify(SIGN_IN), "sign-in");
  const document = parseStoredDesignDocument(stored);
  assert.equal(document.name, "Sign in");
  assert.equal(Object.keys(document.nodes).length, 6);
});

test("a full document passes through untouched, so a save never re-expands", () => {
  const first = normalizeDesignArtifact(JSON.stringify(SIGN_IN), "sign-in");
  const second = normalizeDesignArtifact(first, "sign-in");
  assert.equal(second, first, "re-storing a stored document must be a fixed point");

  // And an edited document keeps its revision rather than being reset to 1.
  const edited = { ...parseStoredDesignDocument(first), revision: 7 };
  const round = parseStoredDesignDocument(normalizeDesignArtifact(serializeDesignDocument(edited), "sign-in"));
  assert.equal(round.revision, 7);
});

test("a body that is neither form is refused with a reason", () => {
  assert.throws(() => normalizeDesignArtifact("not json", "x"), /must contain JSON/);
  assert.throws(() => normalizeDesignArtifact('{"hello":"world"}', "x"), DesignValidationError);
  assert.throws(() => normalizeDesignArtifact('{"nodes":[]}', "x"), DesignValidationError);
  // HTML in a design artifact is a model mistake worth catching loudly.
  assert.throws(() => normalizeDesignArtifact("<!doctype html><html></html>", "x"), /must contain JSON/);
});

test("an unknown node type is refused rather than silently dropped", () => {
  assert.throws(() => normalizeDesignArtifact(JSON.stringify({ nodes: [{ type: "webview" }] }), "x"), DesignValidationError);
});

test("a design a model authors can be opened, edited and re-saved", () => {
  // The full loop the product depends on: model → storage → editor → storage.
  const stored = normalizeDesignArtifact(JSON.stringify(SIGN_IN), "sign-in");
  const document = parseStoredDesignDocument(stored);

  const button = Object.values(document.nodes).find((n) => n.name === "Sign in button")!;
  assert.equal(button.cornerRadius, 8);

  // The editor would write the whole document back; that must normalize to
  // itself, not be re-expanded from scratch.
  const resaved = normalizeDesignArtifact(serializeDesignDocument(document), "sign-in");
  assert.equal(parseStoredDesignDocument(resaved).nodes[button.id].name, "Sign in button");
});
