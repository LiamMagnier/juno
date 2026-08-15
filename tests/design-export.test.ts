import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHandoffBundle,
  exportHtmlPrototype,
  exportPdf,
  exportReact,
  exportSvg,
  exportSwiftUI,
  findSymbol,
  pngRequest,
  symbolName,
} from "../src/lib/design/export";
import { collapseCornerRadius, superellipseExponent } from "../src/lib/design/render";
import { variantAxes, variantRootFor } from "../src/lib/design/instances";
import { layoutPage } from "../src/lib/design/layout";
import { parseStoredDesignDocument } from "../src/lib/design/migrations";
import { PAGE_ID, run, signInDocument, withTokens } from "./design-fixtures";
import type { DesignDocument } from "../src/lib/design/types";

/** The fixture plus a component, an instance, a prototype link and a spring —
 *  i.e. everything a handoff is supposed to carry. */
function richDocument(): DesignDocument {
  let doc = withTokens(signInDocument());
  doc = run(doc, [
    { op: "createComponent", nodeId: "button", componentId: "cmp1", name: "Primary button", description: "The main action." },
    { op: "bindVariable", nodeId: "button", property: "fills.0.color", variableId: "var-primary" },
    { op: "createInstance", componentId: "cmp1", parentId: "screen", pageId: PAGE_ID, instanceId: "inst1", x: 24, y: 640 },
    {
      op: "createInteraction",
      interaction: {
        id: "int1",
        sourceNodeId: "button",
        trigger: { type: "click" },
        action: { type: "navigate", targetNodeId: "screen" },
        transition: { kind: "slide", direction: "left", durationMs: 260, delayMs: 0, easing: { type: "ease-out" }, matchStableIds: true },
      },
    },
    {
      op: "createAnimation",
      animation: {
        id: "anim1",
        name: "Hover scale",
        durationMs: 220,
        loop: false,
        state: "hover",
        tracks: [
          {
            nodeId: "button",
            property: "scale",
            keyframes: [
              { time: 0, value: 1, easing: { type: "spring", stiffness: 320, damping: 22, mass: 1 } },
              { time: 220, value: 1.03, easing: { type: "spring", stiffness: 320, damping: 22, mass: 1 } },
            ],
          },
        ],
      },
    },
  ]).document;
  return doc;
}

// ---------------------------------------------------------------------------
// Vector and raster
// ---------------------------------------------------------------------------

test("SVG export matches what the canvas renders", () => {
  const doc = signInDocument();
  const result = exportSvg(doc, PAGE_ID);
  assert.equal(result.mimeType, "image/svg+xml");
  assert.ok(result.content.startsWith("<svg "));
  assert.ok(!result.content.includes("data-juno-node"), "an export carries no Juno internals");

  // A single frame exports at its own laid-out size.
  const button = exportSvg(doc, PAGE_ID, "button");
  const box = layoutPage(doc, PAGE_ID).get("button")!;
  assert.ok(button.content.includes(`width="${box.width}"`));
});

test("PNG export is described, not faked", () => {
  const request = pngRequest(signInDocument(), PAGE_ID, "button", 3);
  assert.ok(request.svg.startsWith("<svg "));
  assert.equal(request.scale, 3);
  assert.ok(request.fileName.endsWith(".png"));
  assert.ok(request.width > 0 && request.height > 0);
});

test("PDF export is a structurally valid document and reports what it flattened", () => {
  const result = exportPdf(richDocument(), PAGE_ID);
  assert.ok(result.content.startsWith("%PDF-1.4"));
  assert.ok(result.content.trimEnd().endsWith("%%EOF"));
  assert.match(result.content, /\/Type \/Catalog/);
  assert.match(result.content, /\/Type \/Page\b/);
  assert.match(result.content, /startxref\n\d+/);
  // Five objects plus the free entry.
  assert.match(result.content, /xref\n0 6\n/);
  // The card carries a gradient in the rich fixture only after it is set; here
  // the honest claim is simply that the mechanism reports rather than hides.
  assert.ok(Array.isArray(result.unsupported));
});

test("PDF escapes text that would otherwise break a literal string", () => {
  const doc = run(signInDocument(), [
    { op: "updateNode", nodeId: "buttonLabel", patch: { characters: "Sign (in) \\ now" } },
  ]).document;
  const result = exportPdf(doc, PAGE_ID);
  assert.ok(result.content.includes("Sign \\(in\\) \\\\ now"));
});

/**
 * The cross-reference table has to be right in BYTES.
 *
 * `assemblePdf` measured its offsets with `String.length`, which counts UTF-16
 * code units — but the file is served as UTF-8, where any non-ASCII character is
 * two or more bytes. One accented letter, curly quote or em dash in a text layer
 * therefore shifted every subsequent object past its recorded offset, and the
 * xref pointed into the middle of an object. Readers either silently repair the
 * file or refuse it, and nothing in the export path noticed.
 */
test("the PDF cross-reference table points at real byte offsets, even with non-ASCII text", () => {
  const doc = run(signInDocument(), [
    // Every class of character that used to break it: an accent, an em dash, a
    // curly apostrophe and a symbol outside Latin-1.
    { op: "updateNode", nodeId: "buttonLabel", patch: { characters: "Café — l’été € ✓" } },
  ]).document;
  const result = exportPdf(doc, PAGE_ID);
  const bytes = new TextEncoder().encode(result.content);

  const startxref = Number(/startxref\n(\d+)/.exec(result.content)?.[1]);
  assert.ok(Number.isFinite(startxref), "the trailer must carry a startxref offset");

  const at = (offset: number, length: number) =>
    new TextDecoder("latin1").decode(bytes.slice(offset, offset + length));
  assert.equal(at(startxref, 4), "xref", "startxref must land on the xref keyword");

  // Each 10-digit entry after the free record must land on "<n> 0 obj".
  const table = /xref\n0 (\d+)\n0000000000 65535 f \n([\s\S]*?)trailer/.exec(result.content);
  assert.ok(table, "the xref table must be present");
  const offsets = [...table[2].matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
  assert.equal(offsets.length, Number(table[1]) - 1, "one entry per object");

  offsets.forEach((offset, index) => {
    const expected = `${index + 1} 0 obj`;
    assert.equal(
      at(offset, expected.length),
      expected,
      `object ${index + 1} must begin exactly at its recorded byte offset`
    );
  });
});

/**
 * A Type1 Helvetica literal string cannot carry UTF-8. Text is transcoded to
 * WinAnsi so the glyphs a reader draws are the glyphs that were authored, and
 * anything with no WinAnsi equivalent degrades visibly rather than corrupting
 * the stream.
 */
test("PDF text is WinAnsi, so the emitted file stays single-byte", () => {
  const doc = run(signInDocument(), [
    { op: "updateNode", nodeId: "buttonLabel", patch: { characters: "Café — l’été ✓" } },
  ]).document;
  const result = exportPdf(doc, PAGE_ID);
  for (let i = 0; i < result.content.length; i += 1) {
    assert.ok(
      result.content.charCodeAt(i) < 128,
      `every emitted character must be single-byte; found U+${result.content.charCodeAt(i).toString(16)} at ${i}`
    );
  }
});

/**
 * `cornerRadius` accepts a per-corner tuple and every drawing path collapsed it
 * with `Math.max(...)`, so a card rounded only at the top drew as four equal
 * corners everywhere it was rendered.
 */
test("a per-corner radius draws as four different corners, and a uniform one stays a rect", () => {
  const uniform = exportSvg(run(signInDocument(), [
    { op: "updateNode", nodeId: "card", patch: { cornerRadius: 12 } },
  ]).document, PAGE_ID);
  assert.match(uniform.content, /<rect[^>]*rx="12"/, "a uniform radius stays the cheaper <rect rx>");

  const perCorner = exportSvg(run(signInDocument(), [
    { op: "updateNode", nodeId: "card", patch: { cornerRadius: [16, 16, 0, 0] } },
  ]).document, PAGE_ID);
  const path = /<path d="(M[^"]*Z)"/.exec(perCorner.content);
  assert.ok(path, "a per-corner radius becomes a path");
  // Two arcs, not four: the two zero corners emit none.
  assert.equal((path[1].match(/a16 16/g) ?? []).length, 2, "only the rounded corners get an arc");
  assert.ok(!/a0 0/.test(path[1]), "square corners emit no arc at all");
});

/**
 * `Stroke.align` is in the schema and was drawn as `center` whatever it said, so
 * a 4pt inside stroke overflowed its own box by 2pt and `outside` was identical
 * to `inside`.
 */
test("stroke alignment is drawn, not just stored", () => {
  const stroked = (align: "inside" | "center" | "outside") =>
    exportSvg(run(signInDocument(), [
      {
        op: "updateNode",
        nodeId: "card",
        patch: { strokes: [{ paint: { type: "solid", color: { r: 0, g: 0, b: 0, a: 1 } }, weight: 4, align }] },
      },
    ]).document, PAGE_ID).content;

  const centre = stroked("center");
  assert.match(centre, /stroke-width="4"/, "a centred stroke is drawn at its own weight");
  assert.ok(!/clip-path="url\(#/.test(centre) || !/stroke-width="8"/.test(centre));

  const inside = stroked("inside");
  assert.match(inside, /stroke-width="8"/, "inside is drawn double and then halved");
  assert.match(inside, /clip-path="url\(#/, "…by clipping it to the shape");

  const outside = stroked("outside");
  assert.match(outside, /<mask id=/, "outside is drawn double and masked");
  assert.match(outside, /mask="url\(#/);
  assert.notEqual(inside, outside, "inside and outside must not render identically");
});

/**
 * `emit` switched on `interaction.action.type` and never read
 * `interaction.trigger`, so a hover, a key, a delay and a scroll-into-view all
 * exported as the same global click handler.
 */
test("the HTML prototype binds the trigger that was authored", () => {
  const withTrigger = (trigger: Record<string, unknown>) =>
    exportHtmlPrototype(run(signInDocument(), [
      {
        op: "createInteraction",
        interaction: {
          id: "i1",
          sourceNodeId: "button",
          trigger: trigger as never,
          action: { type: "navigate", targetNodeId: "screen" },
          transition: { kind: "instant", direction: "left", durationMs: 0, delayMs: 0, easing: { type: "linear" }, matchStableIds: false },
        },
      },
    ]).document, PAGE_ID);

  const hover = withTrigger({ type: "hover" });
  assert.match(hover.content, /data-trigger="hover"/);
  assert.match(hover.content, /addEventListener\('mouseenter'/);

  const delayed = withTrigger({ type: "delay", ms: 2000 });
  assert.match(delayed.content, /data-trigger="delay"/);
  assert.match(delayed.content, /data-trigger-ms="2000"/);
  assert.match(delayed.content, /setTimeout/);

  const keyed = withTrigger({ type: "key", key: "Enter" });
  assert.match(keyed.content, /data-trigger-key="Enter"/);
  assert.match(keyed.content, /addEventListener\('keydown'/);

  const scroll = withTrigger({ type: "scroll-into-view" });
  assert.match(scroll.content, /IntersectionObserver/);

  // A trigger with no honest HTML equivalent is reported rather than downgraded.
  const dragged = withTrigger({ type: "drag" });
  assert.ok(dragged.unsupported.some((line) => /drag trigger/.test(line)));
});

// ---------------------------------------------------------------------------
// HTML prototype
// ---------------------------------------------------------------------------

test("the HTML prototype is standalone, inert and carries node ids", () => {
  const result = exportHtmlPrototype(richDocument(), PAGE_ID);
  assert.ok(result.content.startsWith("<!doctype html>"));
  assert.ok(result.content.includes('data-juno-node="button"'));
  assert.ok(!/src="https?:/.test(result.content), "no remote resources");
  assert.ok(!result.content.includes("eval("), "nothing evaluates");
  // The navigate interaction became data, and one small script reads it.
  assert.ok(result.content.includes('data-navigate="screen"'));
  assert.ok(result.content.includes("roots[i].hidden"));
});

test("the prototype escapes user text rather than re-admitting it as markup", () => {
  const doc = run(signInDocument(), [
    { op: "updateNode", nodeId: "buttonLabel", patch: { characters: "<img src=x onerror=alert(1)>" } },
  ]).document;
  const result = exportHtmlPrototype(doc, PAGE_ID);
  assert.ok(!result.content.includes("<img src=x"), "user text must never become markup");
  assert.ok(result.content.includes("&lt;img src=x"));
});

// ---------------------------------------------------------------------------
// Code generation and the mapping
// ---------------------------------------------------------------------------

test("React output compiles-shaped components and preserves every node id", () => {
  const doc = richDocument();
  const result = exportReact(doc, PAGE_ID);

  assert.ok(result.content.includes("export function SignIn()"));
  // A plain JSX string attribute, which is what `JSON.stringify` on an id gives.
  assert.ok(result.content.includes('data-juno-node="button"'));
  assert.ok(result.content.includes('data-juno-node="buttonLabel"'));

  // Every node on the page has a mapping.
  const mapped = new Set(result.mappings.map((m) => m.nodeId));
  for (const id of Object.keys(doc.nodes)) assert.ok(mapped.has(id), `${id} has no React mapping`);
});

test("SwiftUI output carries each node id as an accessibility identifier", () => {
  const doc = richDocument();
  const result = exportSwiftUI(doc, PAGE_ID);

  assert.ok(result.content.includes("import SwiftUI"));
  assert.ok(result.content.includes("struct SignInView: View"));
  assert.ok(result.content.includes('.accessibilityIdentifier("button")'));
  assert.ok(result.content.includes('.accessibilityIdentifier("buttonLabel")'));
  assert.ok(result.content.includes("Text(\"Sign in\")"));

  const mapped = new Set(result.mappings.map((m) => m.nodeId));
  for (const id of Object.keys(doc.nodes)) assert.ok(mapped.has(id), `${id} has no SwiftUI mapping`);
});

test("generated symbol names are safe and unique", () => {
  const taken = new Set<string>();
  const make = (name: string) => symbolName({ name } as never, taken);
  assert.equal(make("Sign in button"), "SignInButton");
  assert.equal(make("Sign in button"), "SignInButton2", "a repeat gets a distinct symbol");
  assert.equal(make("123 start"), "N123Start", "an identifier may not start with a digit");
  assert.equal(make("!!!"), "Node");
});

test("generators state what they could not express", () => {
  const doc = richDocument();
  const react = exportReact(doc, PAGE_ID);
  const swift = exportSwiftUI(doc, PAGE_ID);
  assert.ok(react.unsupported.some((u) => /interaction/i.test(u)));
  assert.ok(react.unsupported.some((u) => /[Mm]otion/.test(u)));
  assert.ok(swift.unsupported.some((u) => /[Aa]uto layout/.test(u)));
});

// ---------------------------------------------------------------------------
// The handoff bundle — acceptance scenario 7
// ---------------------------------------------------------------------------

test("a handoff carries scene structure, not only screenshots", () => {
  const doc = richDocument();
  const bundle = buildHandoffBundle(doc, PAGE_ID, "2026-01-01T00:00:00.000Z");

  // The scene document itself, round-trippable.
  assert.equal(bundle.document.id, doc.id);
  assert.doesNotThrow(() => parseStoredDesignDocument(JSON.stringify(bundle.document)));

  // Tokens, by name and mode.
  const theme = bundle.tokens.collections.find((c) => c.name === "Theme")!;
  assert.deepEqual(theme.modes, ["Light", "Dark"]);
  assert.ok(theme.tokens.some((t) => t.name === "primary"));

  // Component metadata, including which nodes instantiate it.
  const component = bundle.components.find((c) => c.id === "cmp1")!;
  assert.equal(component.name, "Primary button");
  assert.deepEqual(component.instanceNodeIds, ["inst1"]);

  // The interaction graph, as something a reader can follow.
  assert.equal(bundle.interactionGraph.length, 1);
  assert.equal(bundle.interactionGraph[0].from.name, "Sign in button");
  assert.equal(bundle.interactionGraph[0].to?.nodeId, "screen");
  assert.equal(bundle.interactionGraph[0].transition.kind, "slide");
  assert.equal(bundle.interactionGraph[0].transition.matchStableIds, true);

  // The animation spec, with easing spelled out.
  assert.equal(bundle.animations.length, 1);
  assert.equal(bundle.animations[0].state, "hover");
  assert.equal(bundle.animations[0].tracks[0].nodeName, "Sign in button");
  assert.match(bundle.animations[0].tracks[0].keyframes[0].easing, /^spring\(/);

  // Reference images, alongside the structure rather than instead of it.
  assert.ok(bundle.referenceImages.length >= 1);
  assert.ok(bundle.referenceImages[0].svg.startsWith("<svg "));

  // And the layout facts the flattened output could not carry.
  assert.ok(bundle.layoutNotes.some((n) => n.nodeId === "card" && n.autoLayout));
});

test("the handoff maps every node to a code symbol in each target", () => {
  const doc = richDocument();
  const bundle = buildHandoffBundle(doc, PAGE_ID, "2026-01-01T00:00:00.000Z");

  for (const target of ["react", "swiftui", "html"] as const) {
    const mapped = new Set(bundle.codeMappings[target].map((m) => m.nodeId));
    for (const id of Object.keys(doc.nodes)) {
      assert.ok(mapped.has(id), `${id} has no ${target} mapping`);
    }
  }
});

test("a selected node resolves to the symbol that produced it", () => {
  const doc = richDocument();
  const bundle = buildHandoffBundle(doc, PAGE_ID, "2026-01-01T00:00:00.000Z");

  // This is the property scenario 7 rests on: a later "increase this button's
  // radius" knows the file and symbol to edit instead of regenerating.
  const react = findSymbol(bundle, "button", "react")!;
  assert.ok(react.file.endsWith(".tsx"));
  assert.match(react.symbol, /data-juno-node="button"/);
  assert.ok(react.line > 0);

  const swift = findSymbol(bundle, "button", "swiftui")!;
  assert.ok(swift.file.endsWith(".swift"));
  assert.match(swift.symbol, /accessibilityIdentifier\("button"\)/);

  const html = findSymbol(bundle, "button", "html")!;
  assert.equal(html.symbol, "#button");

  assert.equal(findSymbol(bundle, "no-such-node", "react"), null);
});

test("a mapping's reported line really contains its symbol", () => {
  const doc = richDocument();
  const bundle = buildHandoffBundle(doc, PAGE_ID, "2026-01-01T00:00:00.000Z");

  // Top-level frames map to a declaration; the line must point at it, or a
  // targeted edit would open the wrong place.
  const root = bundle.codeMappings.react.find((m) => m.nodeId === "screen")!;
  const line = bundle.generated.react.split("\n")[root.line - 1];
  assert.ok(line.includes(`export function ${root.symbol}(`), `line ${root.line} is "${line}"`);

  const swiftRoot = bundle.codeMappings.swiftui.find((m) => m.nodeId === "screen")!;
  const swiftLine = bundle.generated.swiftui.split("\n")[swiftRoot.line - 1];
  assert.ok(swiftLine.includes(`struct ${swiftRoot.symbol}: View`), `line ${swiftRoot.line} is "${swiftLine}"`);
});

test("the handoff is deterministic", () => {
  const doc = richDocument();
  const a = buildHandoffBundle(doc, PAGE_ID, "2026-01-01T00:00:00.000Z");
  const b = buildHandoffBundle(doc, PAGE_ID, "2026-01-01T00:00:00.000Z");
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test("the bundle records everything the generators dropped", () => {
  const bundle = buildHandoffBundle(richDocument(), PAGE_ID, "2026-01-01T00:00:00.000Z");
  assert.ok(bundle.unsupported.length > 0, "a document with motion and layout has caveats worth stating");
  assert.ok(bundle.unsupported.every((u) => typeof u === "string" && u.length > 0));
});

// ---------------------------------------------------------------------------
// Corners
// ---------------------------------------------------------------------------

/**
 * `collapseCornerRadius` is what every corner write in the inspector goes
 * through, so it decides two things no snapshot would catch: whether a document
 * quietly grows from the scalar form to the four-element form the first time
 * anyone touches a radius, and what a typed negative becomes.
 */
test("collapseCornerRadius keeps the narrowest shape that says the same thing", () => {
  assert.equal(collapseCornerRadius([8, 8, 8, 8]), 8, "a uniform tuple is a scalar");
  assert.equal(collapseCornerRadius([0, 0, 0, 0]), 0);
  assert.deepEqual(collapseCornerRadius([8, 8, 0, 0]), [8, 8, 0, 0], "a genuinely per-corner radius stays a tuple");
});

test("collapseCornerRadius clamps a negative rather than rejecting it", () => {
  // The schema's floor is 0, so an unclamped -4 would be refused by the
  // transaction — a worse answer to "I typed -4" than the 0 the shape would
  // have drawn anyway.
  assert.equal(collapseCornerRadius([-4, -4, -4, -4]), 0);
  assert.deepEqual(collapseCornerRadius([-4, 8, 8, 8]), [0, 8, 8, 8]);
});

/**
 * The exponent is the whole claim corner smoothing makes: that sliding it
 * changes how the curve meets the edge and *not* how round the corner looks. If
 * this drifts, a designer who smooths a 12pt corner gets a corner that is no
 * longer 12pt and no field on screen says so.
 */
test("corner smoothing holds the corner's closest approach to the vertex", () => {
  for (const smoothing of [0, 0.25, 0.6, 1]) {
    const n = superellipseExponent(smoothing);
    const run = 1 * (1 + smoothing);
    // The 45° point of the superellipse, as a distance from the vertex.
    const offset = run * (1 - Math.pow(2, -1 / n));
    assert.ok(
      Math.abs(offset * Math.SQRT2 - (Math.SQRT2 - 1)) < 1e-9,
      `smoothing ${smoothing} moved the corner to ${offset * Math.SQRT2}`
    );
  }
  assert.ok(Math.abs(superellipseExponent(0) - 2) < 1e-9, "no smoothing is exactly the circle");
});

test("an unsmoothed document renders exactly the markup it always did", () => {
  const plain = signInDocument();
  const zeroed = run(plain, [{ op: "updateNode", nodeId: "card", patch: { cornerSmoothing: 0 } }]).document;
  assert.equal(exportSvg(zeroed, PAGE_ID).content, exportSvg(plain, PAGE_ID).content);
});

test("smoothing replaces the rounded rect with a curve the browser cannot fake", () => {
  const smoothed = run(signInDocument(), [{ op: "updateNode", nodeId: "card", patch: { cornerSmoothing: 1 } }]).document;
  const svg = exportSvg(smoothed, PAGE_ID).content;
  // The card was a `<rect rx="16">`; a squircle has no `rx` that can say it.
  assert.doesNotMatch(svg, /rx="16"/);
  assert.match(svg, /<path d="M\d/);

  // CSS has no portable form for it, so the prototype says so rather than
  // shipping a corner that is subtly rounder than the artboard.
  const html = exportHtmlPrototype(smoothed, PAGE_ID);
  assert.ok(html.unsupported.some((line) => /corner smoothing/.test(line) && /Card/.test(line)));
});

test("SwiftUI names the corner substitutions it makes instead of taking them silently", () => {
  const doc = run(signInDocument(), [
    { op: "updateNode", nodeId: "card", patch: { cornerRadius: [16, 16, 0, 0] } },
  ]).document;
  const swift = exportSwiftUI(doc, PAGE_ID);
  assert.ok(
    swift.unsupported.some((line) => /Card/.test(line) && /one radius/.test(line) && /16\/16\/0\/0/.test(line)),
    "a per-corner tuple collapsed to one radius is a loss worth stating"
  );
  // `.continuous` is Apple's squircle and the document's corners are arcs.
  assert.ok(swift.unsupported.some((line) => /circular corner/.test(line) && /\.continuous/.test(line)));
});

test("PDF admits it drew the corners square", () => {
  // `re` is the only rectangle PDF has. The card is rounded on the canvas and in
  // every other export; a PDF that quietly squares it is the one output a
  // designer cannot tell apart from the real thing at a glance.
  const result = exportPdf(signInDocument(), PAGE_ID);
  assert.ok(result.unsupported.some((line) => /Card/.test(line) && /corner radius/.test(line)));
});

// ---------------------------------------------------------------------------
// Instances and variants
//
// These belong beside the operation tests rather than here; they live in this
// file because it is the one test file the pass that wrote them was allowed to
// touch. Move them to `design-instances.test.ts` when something else is being
// changed nearby.
// ---------------------------------------------------------------------------

/** The sign-in button, promoted to a component with a second variant that has a
 *  visibly different subtree — a label and a badge rather than just a label. */
function variantDocument(): DesignDocument {
  let doc = signInDocument();
  doc = run(doc, [
    { op: "createComponent", nodeId: "button", componentId: "cmp1", name: "Button", description: "" },
    {
      op: "createNode",
      parentId: "screen",
      pageId: PAGE_ID,
      node: { type: "frame", id: "buttonLarge", name: "Button/large", patch: { x: 400, y: 0, width: 320, height: 64 } },
    },
    {
      op: "createNode",
      parentId: "buttonLarge",
      pageId: PAGE_ID,
      node: { type: "text", id: "buttonLargeLabel", name: "Label", patch: { characters: "Sign in now" } },
    },
    {
      op: "createNode",
      parentId: "buttonLarge",
      pageId: PAGE_ID,
      node: { type: "ellipse", id: "buttonLargeBadge", name: "Badge", patch: { width: 8, height: 8 } },
    },
    { op: "createVariant", componentId: "cmp1", nodeId: "button", variantProperties: { size: "small" } },
    { op: "createVariant", componentId: "cmp1", nodeId: "buttonLarge", variantProperties: { size: "large" } },
  ]).document;
  return doc;
}

test("the variant axes a component offers come from the variants that exist", () => {
  const doc = variantDocument();
  assert.deepEqual(variantAxes(doc.components.cmp1), [{ name: "size", values: ["large", "small"] }]);
  // A component with no variant set offers no switches — rather than one axis
  // with an empty value, which is what splitting the "" key would produce.
  const plain = run(signInDocument(), [
    { op: "createComponent", nodeId: "card", componentId: "cmp2", name: "Card", description: "" },
  ]).document;
  assert.deepEqual(variantAxes(plain.components.cmp2), []);
});

test("an unknown variant resolves to nothing rather than to the default", () => {
  const doc = variantDocument();
  assert.equal(variantRootFor(doc, doc.components.cmp1, { size: "jumbo" }), null);
  // An empty selection is the component's own root: that is what an instance
  // placed before any variant existed is showing.
  assert.equal(variantRootFor(doc, doc.components.cmp1, {})?.id, "button");
  assert.equal(variantRootFor(doc, doc.components.cmp1, { size: "large" })?.id, "buttonLarge");
});

test("selecting a variant replaces what the instance draws, not just what it says", () => {
  const doc = run(variantDocument(), [
    { op: "createInstance", componentId: "cmp1", parentId: null, pageId: PAGE_ID, instanceId: "inst1", x: 0, y: 900 },
  ]).document;
  const before = doc.nodes.inst1;
  assert.ok("children" in before && before.children.length === 1, "the default variant has one child");

  const swapped = run(doc, [
    { op: "setInstanceVariant", instanceNodeId: "inst1", variantProperties: { size: "large" } },
  ]).document;
  const after = swapped.nodes.inst1;
  assert.ok("children" in after);
  assert.equal(after.children.length, 2, "the large variant's label and badge both arrived");
  assert.deepEqual(
    after.children.map((id) => swapped.nodes[id].type),
    ["text", "ellipse"]
  );
  assert.deepEqual((after as { variantProperties: Record<string, string> }).variantProperties, { size: "large" });

  // The instance keeps the place the designer put it. A swap is a change of
  // contents, not a relayout.
  assert.equal(after.x, before.x);
  assert.equal(after.y, before.y);

  // The old subtree is gone rather than orphaned in `nodes`.
  const orphan = Object.values(swapped.nodes).find((n) => n.parentId === null && n.id !== "inst1" && !swapped.pages[0].children.includes(n.id));
  assert.equal(orphan, undefined);
});

test("undoing a variant swap restores the subtree that was on screen", () => {
  const doc = run(variantDocument(), [
    { op: "createInstance", componentId: "cmp1", parentId: null, pageId: PAGE_ID, instanceId: "inst1", x: 0, y: 900 },
  ]).document;
  // An edit made *inside* the instance — the editor allows it, an instance being
  // an ordinary container — is the thing a re-derived subtree would silently
  // lose, which is why the inverse rebuilds rather than swapping back.
  const edited = run(doc, [
    { op: "updateNode", nodeId: (doc.nodes.inst1 as { children: string[] }).children[0], patch: { name: "Hand-edited" } },
  ]).document;

  const result = run(edited, [{ op: "setInstanceVariant", instanceNodeId: "inst1", variantProperties: { size: "large" } }]);
  const undone = run(result.document, result.inverse).document;

  const restored = undone.nodes.inst1 as { children: string[]; variantProperties: Record<string, string> };
  assert.equal(restored.children.length, 1);
  assert.equal(undone.nodes[restored.children[0]].name, "Hand-edited");
  assert.deepEqual(restored.variantProperties, {});
});

test("a variant the component does not have is refused, not approximated", () => {
  const doc = run(variantDocument(), [
    { op: "createInstance", componentId: "cmp1", parentId: null, pageId: PAGE_ID, instanceId: "inst1", x: 0, y: 900 },
  ]).document;
  assert.throws(
    () => run(doc, [{ op: "setInstanceVariant", instanceNodeId: "inst1", variantProperties: { size: "jumbo" } }]),
    /no variant/i
  );
  assert.throws(
    () => run(doc, [{ op: "setInstanceVariant", instanceNodeId: "card", variantProperties: { size: "large" } }]),
    /not an instance/i
  );
});
