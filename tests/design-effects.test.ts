/**
 * Effects: the operation, its inverse, what the renderer draws, and what each
 * exporter says it cannot draw.
 *
 * The renderer assertions look for filter primitives rather than whole strings
 * on purpose. Byte-comparing SVG would fail on every cosmetic change and tell
 * us nothing about whether an inner shadow is actually being drawn; asserting
 * that the chain contains the `operator="out"` composite that *is* an inner
 * shadow says the thing worth saying.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  applyTransaction,
  coalesceOperations,
  DesignOperationError,
  effectPresetOperations,
  invertTransaction,
  type DesignOperation,
} from "../src/lib/design/operations";
import { parseDesignDocument, validateHierarchy } from "../src/lib/design/schema";
import { serializeDesignDocument } from "../src/lib/design/migrations";
import { renderNodeSvg, renderPageSvg } from "../src/lib/design/render";
import { exportHtmlPrototype, exportPdf, exportReact, exportSwiftUI } from "../src/lib/design/export";
import { PAGE_ID, run, signInDocument, transaction } from "./design-fixtures";
import type { Blur, DesignDocument, Noise, Shadow } from "../src/lib/design/types";

const DROP: Shadow = { type: "drop", color: { r: 0, g: 0, b: 0, a: 0.3 }, offsetX: 0, offsetY: 8, blur: 24, spread: -4 };
const RIM: Shadow = { type: "inner", color: { r: 1, g: 1, b: 1, a: 0.6 }, offsetX: 0, offsetY: 1, blur: 1, spread: 0 };
const GLASS: Blur = { type: "background", radius: 24, saturation: 1.8 };
const GRAIN: Noise = { opacity: 0.06, density: 0.9, seed: 42, monochrome: true, blend: "overlay" };

// ---------------------------------------------------------------------------
// The operation
// ---------------------------------------------------------------------------

test("setEffects writes only the fields it names, and inverts each of them", () => {
  const doc = run(signInDocument(), [{ op: "setEffects", nodeIds: ["button"], shadows: [DROP], blur: GLASS, noise: GRAIN }]).document;
  assert.deepEqual(doc.nodes["button"].shadows, [DROP]);
  assert.deepEqual(doc.nodes["button"].blur, GLASS);
  assert.deepEqual(doc.nodes["button"].noise, GRAIN);

  // A later operation naming only the blur must leave the shadows and grain be.
  const narrowed = run(doc, [{ op: "setEffects", nodeIds: ["button"], blur: { type: "layer", radius: 4 } }]).document;
  assert.deepEqual(narrowed.nodes["button"].blur, { type: "layer", radius: 4 });
  assert.deepEqual(narrowed.nodes["button"].shadows, [DROP], "shadows must not move");
  assert.deepEqual(narrowed.nodes["button"].noise, GRAIN, "grain must not move");
});

test("setEffects round-trips across several layers, byte for byte", () => {
  const doc = signInDocument();
  const operations: DesignOperation[] = [
    { op: "setEffects", nodeIds: ["button", "email"], shadows: [RIM, DROP], blur: GLASS, noise: GRAIN },
  ];
  const source = transaction(operations, { baseRevision: doc.revision, summary: "Glass" });
  const applied = applyTransaction(doc, source);
  assert.deepEqual(applied.touchedNodeIds.sort(), ["button", "email"]);
  assert.equal(applied.document.nodes["email"].shadows.length, 2);

  const undone = applyTransaction(applied.document, invertTransaction(applied, source, "2026-01-01T00:01:00.000Z"));
  const strip = (d: DesignDocument) => serializeDesignDocument({ ...d, revision: 0, updatedAt: "" });
  assert.equal(strip(undone.document), strip(doc));
  assert.deepEqual(validateHierarchy(undone.document), []);
});

test("the inverse holds a copy, not a view of the live node", () => {
  const doc = signInDocument();
  const first = run(doc, [{ op: "setEffects", nodeIds: ["button"], shadows: [DROP] }]);
  // Edit again on top. If the first inverse had aliased the node's array it
  // would now describe the *second* state and undo would be a no-op.
  const second = run(first.document, [{ op: "setEffects", nodeIds: ["button"], shadows: [RIM] }]);
  const back = applyTransaction(second.document, {
    ...transaction(first.inverse, { baseRevision: second.document.revision }),
    id: "undo-first",
  });
  assert.deepEqual(back.document.nodes["button"].shadows, [], "undo must restore the empty list the node started with");
});

test("setEffects refuses an empty change and a locked layer", () => {
  const doc = run(signInDocument(), [{ op: "updateNode", nodeId: "email", patch: { locked: true } }]).document;
  assert.throws(
    () => run(doc, [{ op: "setEffects", nodeIds: ["button"] }]),
    (error: unknown) => error instanceof DesignOperationError && /at least one/.test(error.message)
  );
  assert.throws(
    () => run(doc, [{ op: "setEffects", nodeIds: ["email"], blur: GLASS }]),
    (error: unknown) => error instanceof DesignOperationError && error.code === "locked"
  );
});

test("a shadow list longer than the schema allows is refused rather than stored", () => {
  const doc = signInDocument();
  const tooMany = Array.from({ length: 33 }, () => DROP);
  assert.throws(
    () => run(doc, [{ op: "setEffects", nodeIds: ["button"], shadows: tooMany }]),
    (error: unknown) => error instanceof DesignOperationError
  );
});

test("grain survives a delete and comes back with the layer", () => {
  const doc = run(signInDocument(), [{ op: "setEffects", nodeIds: ["button"], noise: GRAIN, shadows: [RIM] }]).document;
  const source = transaction([{ op: "deleteNodes", nodeIds: ["button"] }], { baseRevision: doc.revision });
  const deleted = applyTransaction(doc, source);
  const restored = applyTransaction(deleted.document, invertTransaction(deleted, source, "2026-01-01T00:02:00.000Z"));
  assert.deepEqual(restored.document.nodes["button"].noise, GRAIN);
  assert.deepEqual(restored.document.nodes["button"].shadows, [RIM]);
});

test("a stored document written before grain existed still decodes, with no grain", () => {
  const raw = JSON.parse(serializeDesignDocument(signInDocument())) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  for (const node of Object.values(raw.nodes)) delete node.noise;
  const decoded = parseDesignDocument(raw);
  assert.equal(decoded.nodes["button"].noise, null, "a missing key decodes as no grain, not as undefined");
});

test("coalescing folds a drag of effects but never merges different targets", () => {
  const drag: DesignOperation[] = [
    { op: "setEffects", nodeIds: ["button"], blur: { type: "layer", radius: 1 } },
    { op: "setEffects", nodeIds: ["button"], blur: { type: "layer", radius: 8 } },
    { op: "setEffects", nodeIds: ["button"], blur: { type: "layer", radius: 16 } },
  ];
  assert.deepEqual(coalesceOperations(drag), [drag[2]]);

  // A different layer set is a different change; nothing may be dropped.
  const mixedTargets: DesignOperation[] = [
    { op: "setEffects", nodeIds: ["email"], blur: { type: "layer", radius: 1 } },
    { op: "setEffects", nodeIds: ["button"], blur: { type: "layer", radius: 8 } },
  ];
  assert.deepEqual(coalesceOperations(mixedTargets), mixedTargets);

  // An earlier operation that also wrote the shadows is still load-bearing:
  // the later one does not restate them.
  const widerEarlier: DesignOperation[] = [
    { op: "setEffects", nodeIds: ["button"], blur: { type: "layer", radius: 1 }, shadows: [DROP] },
    { op: "setEffects", nodeIds: ["button"], blur: { type: "layer", radius: 8 } },
  ];
  assert.deepEqual(coalesceOperations(widerEarlier), widerEarlier);
});

// ---------------------------------------------------------------------------
// The liquid-glass preset
// ---------------------------------------------------------------------------

test("liquid glass expands to primitives, in one transaction, and inverts", () => {
  const doc = signInDocument();
  const operations = effectPresetOperations(["button"], "liquid-glass");
  assert.ok(operations.every((op) => op.op === "setEffects" || op.op === "updateNode"), "no preset-only operation may reach the document");

  const source = transaction(operations, { baseRevision: doc.revision, summary: "Apply liquid glass" });
  const applied = applyTransaction(doc, source);
  const button = applied.document.nodes["button"];

  assert.equal(button.blur?.type, "background");
  assert.ok((button.blur?.saturation ?? 1) > 1, "a glass panel lifts the saturation of what it samples");
  assert.ok(button.shadows.some((s) => s.type === "inner"), "the rim light is an inner shadow");
  assert.ok(button.shadows.some((s) => s.type === "drop"), "the panel is lifted by a drop shadow");
  assert.equal(button.fills[0]?.type, "linear-gradient");
  assert.ok(button.noise && button.noise.opacity > 0);
  // The shape is the caller's; a preset that rounded it would be a preset that
  // damaged the layer it decorated.
  assert.equal(button.cornerRadius, doc.nodes["button"].cornerRadius);

  const undone = applyTransaction(applied.document, invertTransaction(applied, source, "2026-01-01T00:03:00.000Z"));
  const strip = (d: DesignDocument) => serializeDesignDocument({ ...d, revision: 0, updatedAt: "" });
  assert.equal(strip(undone.document), strip(doc));
});

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

function renderWith(effects: { shadows?: Shadow[]; blur?: Blur | null; noise?: Noise | null }): string {
  const doc = run(signInDocument(), [{ op: "setEffects", nodeIds: ["button"], ...effects }]).document;
  return renderPageSvg(doc, PAGE_ID).svg;
}

test("an inner shadow is drawn, not silently dropped", () => {
  const svg = renderWith({ shadows: [RIM] });
  assert.match(svg, /<feFlood flood-color="rgba\(255, 255, 255, 0\.6\)"/);
  // The crescent inside the shape and outside the offset silhouette — which is
  // what an inner shadow *is*.
  assert.match(svg, /<feComposite in="SourceAlpha" in2="[^"]+" operator="out"/);
});

test("shadow spread reaches the canvas as morphology on both kinds", () => {
  const drop = renderWith({ shadows: [DROP] });
  assert.match(drop, /<feMorphology in="SourceAlpha" operator="erode" radius="4"/, "a negative drop spread shrinks the silhouette");

  const inner = renderWith({ shadows: [{ ...RIM, spread: 3 }] });
  assert.match(inner, /<feMorphology in="SourceAlpha" operator="erode" radius="3"/, "a positive inner spread thickens the shadow");

  const grown = renderWith({ shadows: [{ ...DROP, spread: 6 }] });
  assert.match(grown, /<feMorphology in="SourceAlpha" operator="dilate" radius="6"/);
});

test("a layer blur blurs the layer and carries its saturation", () => {
  const svg = renderWith({ blur: { type: "layer", radius: 12, saturation: 0.5 } });
  assert.match(svg, /<feGaussianBlur in="SourceGraphic" stdDeviation="6"/);
  assert.match(svg, /<feColorMatrix in="[^"]+" type="saturate" values="0\.5"/);
});

test("grain is turbulence with the seed the document stores", () => {
  const svg = renderWith({ noise: GRAIN });
  assert.match(svg, /<feTurbulence type="fractalNoise" baseFrequency="0\.9" numOctaves="3" seed="42" stitchTiles="stitch"/);
  // Monochrome grain is desaturated turbulence, and its alpha is flattened so
  // it speckles the layer rather than punching holes through it.
  assert.match(svg, /type="saturate" values="0"/);
  assert.match(svg, /<feFuncA type="linear" slope="0" intercept="0\.06"\/>/);
  assert.match(svg, /<feBlend in="[^"]+" in2="[^"]+" mode="overlay"/);
});

test("a background blur draws the backdrop it claims to blur", () => {
  const doc = run(signInDocument(), [{ op: "setEffects", nodeIds: ["button"], blur: GLASS }]).document;
  const svg = renderPageSvg(doc, PAGE_ID, { includeNodeIds: true }).svg;

  // A clipped, blurred, saturated copy of what was already painted.
  assert.match(svg, /<g clip-path="url\(#[^"]+\)"><g filter="url\(#[^"]+\)">/);
  assert.match(svg, /<feColorMatrix type="saturate" values="1\.8"\/>/);
  // The layer itself must NOT be blurred — that is the bug a background blur
  // routed through `filter` produces.
  assert.doesNotMatch(svg, /<feGaussianBlur in="SourceGraphic"/);

  // The copy is stripped of node ids, or the editor's hit test would find a
  // ghost of a layer painted somewhere else.
  const emailHits = svg.match(/data-juno-node="email"/g) ?? [];
  assert.equal(emailHits.length, 1, "the backdrop copy must not duplicate a node id");
});

test("a background blur over nothing draws nothing extra", () => {
  const doc = run(signInDocument(), [{ op: "setEffects", nodeIds: ["screen"], blur: GLASS }]).document;
  // `renderNodeSvg` starts an empty page: the root has no backdrop to sample.
  const svg = renderNodeSvg(doc, "screen")!.svg;
  assert.doesNotMatch(svg, /clip-path="url\(#[^"]+\)"><g filter/);
});

test("gradient stops keep their alpha and their position", () => {
  const doc = run(signInDocument(), [
    {
      op: "updateNode",
      nodeId: "button",
      patch: {
        fills: [
          {
            type: "linear-gradient",
            stops: [
              { position: 0, color: { r: 1, g: 1, b: 1, a: 0.22 } },
              { position: 0.7, color: { r: 0, g: 0, b: 0, a: 1 } },
            ],
            from: { x: 0, y: 0 },
            to: { x: 1, y: 1 },
          },
        ],
      },
    },
  ]).document;
  const svg = renderPageSvg(doc, PAGE_ID).svg;
  // Alpha rides `stop-opacity`; `stop-color` is a <color> and several
  // rasterisers clamp an rgba() there to opaque.
  assert.match(svg, /<stop offset="0" stop-color="#ffffff" stop-opacity="0\.22"\/>/);
  assert.match(svg, /<stop offset="0\.7" stop-color="#000000"\/>/);
  assert.match(svg, /<linearGradient id="[^"]+" x1="0" y1="0" x2="1" y2="1">/);
});

test("rendering is deterministic", () => {
  const doc = run(signInDocument(), [{ op: "setEffects", nodeIds: ["button"], shadows: [RIM, DROP], blur: GLASS, noise: GRAIN }]).document;
  assert.equal(renderPageSvg(doc, PAGE_ID).svg, renderPageSvg(doc, PAGE_ID).svg);
});

// ---------------------------------------------------------------------------
// The exporters
// ---------------------------------------------------------------------------

function glassDocument(): DesignDocument {
  return applyTransaction(
    signInDocument(),
    transaction(effectPresetOperations(["button"], "liquid-glass"), { baseRevision: 1, summary: "Glass" })
  ).document;
}

test("HTML carries the backdrop filter, the inset shadow and the grain", () => {
  const html = exportHtmlPrototype(glassDocument(), PAGE_ID).content;
  assert.match(html, /backdrop-filter: blur\(24px\) saturate\(180%\)/);
  assert.match(html, /-webkit-backdrop-filter/, "Safari carried this behind the prefix for years");
  assert.match(html, /box-shadow: inset 0px 1px 1px 0px/);
  assert.match(html, /background-image: url\(&quot;data:image\/svg\+xml,.*feTurbulence/);
  assert.match(html, /background-blend-mode: overlay/);
  assert.match(html, /linear-gradient\(180deg, rgba\(255, 255, 255, 0\.22\) 0%/);
});

test("a layer blur and a background blur become different CSS declarations", () => {
  const doc = run(signInDocument(), [{ op: "setEffects", nodeIds: ["button"], blur: { type: "layer", radius: 6 } }]).document;
  const html = exportHtmlPrototype(doc, PAGE_ID).content;
  assert.match(html, /[^-]filter: blur\(6px\)/);
  assert.doesNotMatch(html, /backdrop-filter/);
});

test("React emits the same styles as an object literal", () => {
  const react = exportReact(glassDocument(), PAGE_ID).content;
  assert.match(react, /backdropFilter: "blur\(24px\) saturate\(180%\)"/);
  assert.match(react, /boxShadow: "inset 0px 1px 1px 0px/);
  // Grain is the topmost background layer and the gradient sits under it, so
  // the blend list has one entry per layer.
  assert.match(react, /backgroundBlendMode: "overlay, normal"/);
});

test("SwiftUI degrades honestly: a material, a real gradient, and named gaps", () => {
  const swift = exportSwiftUI(glassDocument(), PAGE_ID);
  assert.match(swift.content, /\.background\(\.thinMaterial\)/);
  assert.match(swift.content, /LinearGradient\(stops: \[\.init\(color: Color\(\.sRGB/);
  assert.match(swift.content, /\.shadow\(color: Color\(\.sRGB/);
  // An inner shadow has no view modifier, so it is a comment in the file *and*
  // an entry in `unsupported` — never a silent omission.
  assert.match(swift.content, /\/\/ Juno: inner shadow/);
  assert.match(swift.content, /\/\/ Juno: .*grain/);
  assert.ok(swift.unsupported.some((line) => /inner shadow/.test(line)));
  assert.ok(swift.unsupported.some((line) => /grain/.test(line)));
  assert.ok(swift.unsupported.some((line) => /background blur/.test(line) && /24pt/.test(line)));
  assert.ok(swift.unsupported.some((line) => /spread/.test(line)));
});

test("PDF says what it did not draw", () => {
  const pdf = exportPdf(glassDocument(), PAGE_ID);
  assert.ok(pdf.unsupported.some((line) => /shadows are not drawn in PDF/.test(line)));
  assert.ok(pdf.unsupported.some((line) => /background blur is not drawn in PDF/.test(line)));
  assert.ok(pdf.unsupported.some((line) => /grain is not drawn in PDF/.test(line)));
  assert.ok(pdf.content.startsWith("%PDF-1.4"), "and still produces a readable file");
});

test("text shadows lose what text-shadow cannot say, out loud", () => {
  const doc = run(signInDocument(), [{ op: "setEffects", nodeIds: ["title"], shadows: [RIM, { ...DROP, spread: 5 }] }]).document;
  const html = exportHtmlPrototype(doc, PAGE_ID);
  assert.match(html.content, /text-shadow: 0px 8px 24px/);
  assert.ok(html.unsupported.some((line) => /inner shadow on a text layer/.test(line)));
  assert.ok(html.unsupported.some((line) => /no spread/.test(line)));
});
