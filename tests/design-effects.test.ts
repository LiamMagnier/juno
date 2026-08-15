/**
 * The effect stack: the operations, their inverses, what the renderer draws,
 * and what each exporter says it cannot draw.
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
  invertTransaction,
  type DesignOperation,
} from "../src/lib/design/operations";
import { defaultEffect, parseDesignDocument, validateHierarchy } from "../src/lib/design/schema";
import { serializeDesignDocument } from "../src/lib/design/migrations";
import { renderNodeSvg, renderPageSvg } from "../src/lib/design/render";
import { exportHtmlPrototype, exportPdf, exportReact, exportSwiftUI } from "../src/lib/design/export";
import { PAGE_ID, run, signInDocument, transaction } from "./design-fixtures";
import type { DropShadowEffect, DesignDocument, Effect, GlassEffect, InnerShadowEffect, NoiseEffect, TextureEffect } from "../src/lib/design/types";

const DROP: DropShadowEffect = { type: "drop-shadow", color: { r: 0, g: 0, b: 0, a: 0.3 }, offsetX: 0, offsetY: 8, blur: 24, spread: -4 };
const RIM: InnerShadowEffect = { type: "inner-shadow", color: { r: 1, g: 1, b: 1, a: 0.6 }, offsetX: 0, offsetY: 1, blur: 1, spread: 0 };
const GRAIN: NoiseEffect = { type: "noise", opacity: 0.06, density: 0.9, seed: 42, monochrome: true, blend: "overlay" };
const TEXTURE: TextureEffect = {
  type: "texture",
  scale: 0.4,
  depth: 4,
  roughness: 2,
  seed: 11,
  color: { r: 1, g: 1, b: 1, a: 1 },
  opacity: 0.3,
  blend: "soft-light",
};
const GLASS: GlassEffect = defaultEffect("glass") as GlassEffect;

const setEffects = (nodeIds: string[], effects: Effect[]): DesignOperation => ({ op: "setEffects", nodeIds, effects });

// ---------------------------------------------------------------------------
// The operations
// ---------------------------------------------------------------------------

test("setEffects assigns the whole ordered stack", () => {
  const doc = run(signInDocument(), [setEffects(["button"], [GLASS, GRAIN, DROP])]).document;
  assert.deepEqual(doc.nodes["button"].effects, [GLASS, GRAIN, DROP]);

  // Order is a real property of the list, not a normalisation the model applies.
  const reordered = run(doc, [setEffects(["button"], [DROP, GRAIN, GLASS])]).document;
  assert.deepEqual(
    reordered.nodes["button"].effects.map((effect) => effect.type),
    ["drop-shadow", "noise", "glass"]
  );
});

test("setEffects round-trips across several layers, byte for byte", () => {
  const doc = signInDocument();
  const source = transaction([setEffects(["button", "email"], [GLASS, RIM, DROP])], {
    baseRevision: doc.revision,
    summary: "Glass",
  });
  const applied = applyTransaction(doc, source);
  assert.deepEqual(applied.touchedNodeIds.sort(), ["button", "email"]);
  assert.equal(applied.document.nodes["email"].effects.length, 3);

  const undone = applyTransaction(applied.document, invertTransaction(applied, source, "2026-01-01T00:01:00.000Z"));
  const strip = (d: DesignDocument) => serializeDesignDocument({ ...d, revision: 0, updatedAt: "" });
  assert.equal(strip(undone.document), strip(doc));
  assert.deepEqual(validateHierarchy(undone.document), []);
});

test("addEffect keeps each layer's own stack, and inverts to exactly that stack", () => {
  // The bug this operation exists to prevent: two layers with different stacks,
  // and one gesture that must add to both without flattening either.
  const doc = run(signInDocument(), [setEffects(["button"], [DROP]), setEffects(["email"], [GRAIN, RIM])]).document;

  const source = transaction([{ op: "addEffect", nodeIds: ["button", "email"], effect: GLASS }], {
    baseRevision: doc.revision,
    summary: "Add glass",
  });
  const applied = applyTransaction(doc, source);
  assert.deepEqual(
    applied.document.nodes["button"].effects.map((e) => e.type),
    ["drop-shadow", "glass"]
  );
  assert.deepEqual(
    applied.document.nodes["email"].effects.map((e) => e.type),
    ["noise", "inner-shadow", "glass"],
    "the other layer keeps the two effects it already had"
  );

  const undone = applyTransaction(applied.document, invertTransaction(applied, source, "2026-01-01T00:02:00.000Z"));
  assert.deepEqual(undone.document.nodes["button"].effects, [DROP]);
  assert.deepEqual(undone.document.nodes["email"].effects, [GRAIN, RIM]);
});

test("addEffect honours an index, and its summary names the effect", () => {
  const doc = run(signInDocument(), [setEffects(["button"], [DROP, GRAIN])]).document;
  const applied = run(doc, [{ op: "addEffect", nodeIds: ["button"], effect: RIM, index: 1 }]);
  assert.deepEqual(
    applied.document.nodes["button"].effects.map((e) => e.type),
    ["drop-shadow", "inner-shadow", "noise"]
  );
  assert.ok(applied.summaries.some((line) => /inner shadow/.test(line)));
});

test("the inverse holds a copy, not a view of the live node", () => {
  const doc = signInDocument();
  const first = run(doc, [setEffects(["button"], [DROP])]);
  // Edit again on top. If the first inverse had aliased the node's array it
  // would now describe the *second* state and undo would be a no-op.
  const second = run(first.document, [setEffects(["button"], [RIM])]);
  const back = applyTransaction(second.document, {
    ...transaction(first.inverse, { baseRevision: second.document.revision }),
    id: "undo-first",
  });
  assert.deepEqual(back.document.nodes["button"].effects, [], "undo must restore the empty list the node started with");
});

test("an effect edit on a locked layer is refused", () => {
  const doc = run(signInDocument(), [{ op: "updateNode", nodeId: "email", patch: { locked: true } }]).document;
  assert.throws(
    () => run(doc, [setEffects(["email"], [GLASS])]),
    (error: unknown) => error instanceof DesignOperationError && error.code === "locked"
  );
  assert.throws(
    () => run(doc, [{ op: "addEffect", nodeIds: ["email"], effect: GLASS }]),
    (error: unknown) => error instanceof DesignOperationError && error.code === "locked"
  );
});

test("a stack longer than the schema allows is refused rather than stored", () => {
  assert.throws(
    () => run(signInDocument(), [setEffects(["button"], Array.from({ length: 65 }, () => DROP))]),
    (error: unknown) => error instanceof DesignOperationError
  );
});

test("an effect nobody can render is refused at the door", () => {
  assert.throws(
    // A shader is the item Figma has and this model deliberately does not.
    () => run(signInDocument(), [setEffects(["button"], [{ type: "shader", source: "void main(){}" } as unknown as Effect])]),
    (error: unknown) => error instanceof DesignOperationError
  );
  assert.throws(
    () => run(signInDocument(), [setEffects(["button"], [{ ...GRAIN, density: 99 }])]),
    (error: unknown) => error instanceof DesignOperationError
  );
});

test("the stack survives a delete and comes back with the layer", () => {
  const doc = run(signInDocument(), [setEffects(["button"], [GRAIN, RIM])]).document;
  const source = transaction([{ op: "deleteNodes", nodeIds: ["button"] }], { baseRevision: doc.revision });
  const deleted = applyTransaction(doc, source);
  const restored = applyTransaction(deleted.document, invertTransaction(deleted, source, "2026-01-01T00:03:00.000Z"));
  assert.deepEqual(restored.document.nodes["button"].effects, [GRAIN, RIM]);
});

test("coalescing folds a drag of effects but never merges different targets", () => {
  const drag: DesignOperation[] = [
    setEffects(["button"], [{ type: "layer-blur", radius: 1 }]),
    setEffects(["button"], [{ type: "layer-blur", radius: 8 }]),
    setEffects(["button"], [{ type: "layer-blur", radius: 16 }]),
  ];
  assert.deepEqual(coalesceOperations(drag), [drag[2]]);

  // A different layer set is a different change; nothing may be dropped.
  const mixedTargets: DesignOperation[] = [
    setEffects(["email"], [{ type: "layer-blur", radius: 1 }]),
    setEffects(["button"], [{ type: "layer-blur", radius: 8 }]),
  ];
  assert.deepEqual(coalesceOperations(mixedTargets), mixedTargets);

  // An `addEffect` in between is relative to the stack it lands on, so the
  // assignment before it is load-bearing and must survive.
  const withAdd: DesignOperation[] = [
    setEffects(["button"], [DROP]),
    { op: "addEffect", nodeIds: ["button"], effect: GRAIN },
    setEffects(["button"], [DROP, GRAIN, RIM]),
  ];
  assert.deepEqual(coalesceOperations(withAdd), withAdd);
});

// ---------------------------------------------------------------------------
// Documents written before the stack existed
// ---------------------------------------------------------------------------

test("a document written before the effect stack folds into one ordered list", () => {
  const raw = JSON.parse(serializeDesignDocument(signInDocument())) as { nodes: Record<string, Record<string, unknown>> };
  // Exactly what a stored v1 document looks like: three separate fields and no
  // `effects` key anywhere.
  for (const node of Object.values(raw.nodes)) delete node.effects;
  raw.nodes["button"].shadows = [
    { type: "inner", color: { r: 1, g: 1, b: 1, a: 0.6 }, offsetX: 0, offsetY: 1, blur: 1, spread: 0 },
    { type: "drop", color: { r: 0, g: 0, b: 0, a: 0.3 }, offsetX: 0, offsetY: 8, blur: 24, spread: -4 },
  ];
  raw.nodes["button"].blur = { type: "background", radius: 24, saturation: 1.8 };
  raw.nodes["button"].noise = { opacity: 0.06, density: 0.9, seed: 42, monochrome: true, blend: "overlay" };

  const decoded = parseDesignDocument(raw);
  // The order the old renderer applied these fields in, so a folded document
  // draws exactly what it drew before rather than being silently redrawn.
  assert.deepEqual(
    decoded.nodes["button"].effects.map((effect) => effect.type),
    ["background-blur", "noise", "inner-shadow", "drop-shadow"]
  );
  assert.deepEqual(decoded.nodes["button"].effects[0], { type: "background-blur", radius: 24, saturation: 1.8 });
  assert.deepEqual(decoded.nodes["button"].effects[3], DROP);
  // The retired keys are gone from the decoded node, not carried alongside.
  assert.ok(!("shadows" in decoded.nodes["button"]));
  assert.ok(!("blur" in decoded.nodes["button"]));
  assert.ok(!("noise" in decoded.nodes["button"]));
  // And a layer that had none of the three still decodes to a total node.
  assert.deepEqual(decoded.nodes["email"].effects, []);
});

test("a document that already has effects is never re-folded", () => {
  const raw = JSON.parse(serializeDesignDocument(run(signInDocument(), [setEffects(["button"], [DROP])]).document)) as {
    nodes: Record<string, Record<string, unknown>>;
  };
  raw.nodes["button"].shadows = [{ type: "inner", color: { r: 0, g: 0, b: 0, a: 1 }, offsetX: 0, offsetY: 0, blur: 0, spread: 0 }];
  const decoded = parseDesignDocument(raw);
  assert.deepEqual(decoded.nodes["button"].effects, [DROP], "a stray legacy key must not append to a modern stack");
});

// ---------------------------------------------------------------------------
// The renderer
// ---------------------------------------------------------------------------

function renderWith(effects: Effect[]): string {
  return renderPageSvg(run(signInDocument(), [setEffects(["button"], effects)]).document, PAGE_ID).svg;
}

test("an inner shadow is drawn, not silently dropped", () => {
  const svg = renderWith([RIM]);
  assert.match(svg, /<feFlood flood-color="rgba\(255, 255, 255, 0\.6\)"/);
  // The crescent inside the shape and outside the offset silhouette — which is
  // what an inner shadow *is*.
  assert.match(svg, /<feComposite in="SourceAlpha" in2="[^"]+" operator="out"/);
});

test("shadow spread reaches the canvas as morphology on both kinds", () => {
  assert.match(renderWith([DROP]), /<feMorphology in="SourceAlpha" operator="erode" radius="4"/, "a negative drop spread shrinks the silhouette");
  assert.match(
    renderWith([{ ...RIM, spread: 3 }]),
    /<feMorphology in="SourceAlpha" operator="erode" radius="3"/,
    "a positive inner spread thickens the shadow"
  );
  assert.match(renderWith([{ ...DROP, spread: 6 }]), /<feMorphology in="SourceAlpha" operator="dilate" radius="6"/);
});

test("a layer blur blurs the layer and carries its saturation", () => {
  const svg = renderWith([{ type: "layer-blur", radius: 12, saturation: 0.5 }]);
  assert.match(svg, /<feGaussianBlur in="SourceGraphic" stdDeviation="6"/);
  assert.match(svg, /<feColorMatrix in="[^"]+" type="saturate" values="0\.5"/);
});

test("grain is turbulence with the seed the document stores", () => {
  const svg = renderWith([GRAIN]);
  assert.match(svg, /<feTurbulence type="fractalNoise" baseFrequency="0\.9" numOctaves="3" seed="42" stitchTiles="stitch"/);
  // Monochrome grain is desaturated turbulence, and its alpha is flattened so
  // it speckles the layer rather than punching holes through it.
  assert.match(svg, /type="saturate" values="0"/);
  assert.match(svg, /<feFuncA type="linear" slope="0" intercept="0\.06"\/>/);
  assert.match(svg, /<feBlend in="[^"]+" in2="[^"]+" mode="overlay"/);
});

test("texture is the same turbulence, lit as a relief", () => {
  const svg = renderWith([TEXTURE]);
  assert.match(svg, /<feTurbulence type="fractalNoise" baseFrequency="0\.4" numOctaves="2" seed="11"/);
  assert.match(svg, /<feDiffuseLighting in="[^"]+" surfaceScale="4" diffuseConstant="1" lighting-color="rgba\(255, 255, 255, 1\)"/);
  assert.match(svg, /<feDistantLight azimuth="225" elevation="55"\/>/);
  assert.match(svg, /mode="soft-light"/);
});

test("the effect list is applied in list order, both ways round", () => {
  // Grain then blur means the grain gets blurred; blur then grain does not. If
  // the renderer normalised the order, these two would be the same string —
  // which is precisely the expressiveness the unified list bought.
  const grainThenBlur = renderWith([GRAIN, { type: "layer-blur", radius: 6 }]);
  const blurThenGrain = renderWith([{ type: "layer-blur", radius: 6 }, GRAIN]);
  assert.notEqual(grainThenBlur, blurThenGrain);
  // Blur-first means the Gaussian reads the untouched layer.
  assert.match(blurThenGrain, /<feGaussianBlur in="SourceGraphic"/);
  assert.doesNotMatch(grainThenBlur, /<feGaussianBlur in="SourceGraphic"/);
});

test("a hidden effect contributes nothing at all", () => {
  const shown = renderWith([GRAIN]);
  const hidden = renderWith([{ ...GRAIN, visible: false }]);
  assert.match(shown, /feTurbulence/);
  assert.doesNotMatch(hidden, /feTurbulence/);
});

test("a background blur draws the backdrop it claims to blur", () => {
  const doc = run(signInDocument(), [setEffects(["button"], [{ type: "background-blur", radius: 24, saturation: 1.8 }])]).document;
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
  const doc = run(signInDocument(), [setEffects(["screen"], [{ type: "background-blur", radius: 24 }])]).document;
  // `renderNodeSvg` starts an empty page: the root has no backdrop to sample.
  const svg = renderNodeSvg(doc, "screen")!.svg;
  assert.doesNotMatch(svg, /clip-path="url\(#[^"]+\)"><g filter/);
});

test("glass draws all four of its parts, from primitives", () => {
  const doc = run(signInDocument(), [setEffects(["button"], [GLASS])]).document;
  const svg = renderPageSvg(doc, PAGE_ID, { includeNodeIds: true }).svg;

  // 1. the backdrop sample, blurred and saturated
  assert.match(svg, /<feGaussianBlur stdDeviation="12"\/><feColorMatrix type="saturate" values="1\.8"\/>/);
  // 2. the refracting rim: a magnified second copy behind a rim mask
  assert.match(svg, /<mask id="[^"]+" maskUnits="userSpaceOnUse"/);
  assert.match(svg, /scale\(1\.113\)/, "a quarter of the refraction, as magnification");
  // 3. the tint, painted on the layer's own silhouette
  assert.match(svg, /fill="rgba\(255, 255, 255, 0\.14\)"/);
  // 4. the rim light, stroked with a gradient that is bright one side and dark
  //    the other
  assert.match(svg, /stroke="url\(#[^"]+\)" stroke-width="1\.25"/);
  assert.match(svg, /<stop offset="0" stop-color="#fff" stop-opacity="0\.55"\/>/);
  assert.match(svg, /<stop offset="1" stop-color="#000" stop-opacity="0\.193"\/>/);

  // And none of it duplicates the hit-test attribute.
  assert.equal((svg.match(/data-juno-node="button"/g) ?? []).length, 1);
});

test("glass is one removable thing, not five scattered primitives", () => {
  // The whole point of the change: adding glass, then removing it, leaves the
  // layer exactly as it was — including its fill, which the old preset
  // overwrote with a gradient and could never give back.
  const doc = signInDocument();
  const before = serializeDesignDocument({ ...doc, revision: 0, updatedAt: "" });
  const withGlass = run(doc, [{ op: "addEffect", nodeIds: ["button"], effect: GLASS }]).document;
  assert.equal(withGlass.nodes["button"].effects.length, 1, "glass is a single entry in the stack");
  assert.deepEqual(withGlass.nodes["button"].fills, doc.nodes["button"].fills, "and it does not rewrite the layer's fill");

  const removed = run(withGlass, [setEffects(["button"], [])]).document;
  assert.equal(serializeDesignDocument({ ...removed, revision: 0, updatedAt: "" }), before);
});

test("glass with no refraction draws no rim band", () => {
  const svg = renderWith([{ ...GLASS, refraction: 0 }]);
  assert.doesNotMatch(svg, /<mask id=/);
});

test("rendering is deterministic", () => {
  const doc = run(signInDocument(), [setEffects(["button"], [GLASS, RIM, DROP, GRAIN, TEXTURE])]).document;
  assert.equal(renderPageSvg(doc, PAGE_ID).svg, renderPageSvg(doc, PAGE_ID).svg);
});

// ---------------------------------------------------------------------------
// The exporters
// ---------------------------------------------------------------------------

function glassDocument(): DesignDocument {
  return run(signInDocument(), [setEffects(["button"], [GLASS, GRAIN, DROP])]).document;
}

test("HTML carries the backdrop filter, the rim, the tint and the grain", () => {
  const html = exportHtmlPrototype(glassDocument(), PAGE_ID);
  assert.match(html.content, /backdrop-filter: blur\(24px\) saturate\(180%\)/);
  assert.match(html.content, /-webkit-backdrop-filter/, "Safari carried this behind the prefix for years");
  // The rim light, as the two inset shadows the canvas strokes as one gradient.
  assert.match(html.content, /inset 0px 1px 0 rgba\(255,255,255,0\.55\)/);
  assert.match(html.content, /inset 0px -1px 0 rgba\(0,0,0,0\.19\)/);
  // The drop shadow, still there, after the rim.
  assert.match(html.content, /0px 8px 24px -4px rgba\(0, 0, 0, 0\.3\)/);
  // The tint and the sheen, as background layers, with the grain over them.
  assert.match(html.content, /background-image: url\(&quot;data:image\/svg\+xml,.*feTurbulence/);
  assert.match(html.content, /linear-gradient\(0deg, rgba\(255,255,255,0\) 0%, rgba\(255,255,255,0\.15\) 100%\)/);
  assert.match(html.content, /background-blend-mode: overlay, normal, normal/);
  // The one part CSS cannot say is said out loud instead of being dropped.
  assert.ok(html.unsupported.some((line) => /refraction/.test(line)));
});

test("a layer blur and a background blur become different CSS declarations", () => {
  const doc = run(signInDocument(), [setEffects(["button"], [{ type: "layer-blur", radius: 6 }])]).document;
  const html = exportHtmlPrototype(doc, PAGE_ID).content;
  assert.match(html, /[^-]filter: blur\(6px\)/);
  assert.doesNotMatch(html, /backdrop-filter/);
});

test("texture exports as the same turbulence, lit, in a CSS background layer", () => {
  const doc = run(signInDocument(), [setEffects(["button"], [TEXTURE])]).document;
  const html = exportHtmlPrototype(doc, PAGE_ID).content;
  assert.match(html, /feDiffuseLighting/);
  assert.match(html, /background-blend-mode: soft-light/);
});

test("React emits the same styles as an object literal", () => {
  const react = exportReact(glassDocument(), PAGE_ID).content;
  assert.match(react, /backdropFilter: "blur\(24px\) saturate\(180%\)"/);
  assert.match(react, /boxShadow: "inset 0px 1px 0 rgba\(255,255,255,0\.55\)/);
  // Grain is the topmost background layer and the glass surface sits under it,
  // so the blend list has one entry per layer.
  assert.match(react, /backgroundBlendMode: "overlay, normal, normal"/);
});

test("SwiftUI degrades honestly: a material, a rim, and named gaps", () => {
  const swift = exportSwiftUI(run(signInDocument(), [setEffects(["button"], [GLASS, RIM, DROP, GRAIN, TEXTURE])]).document, PAGE_ID);
  assert.match(swift.content, /\.background\(\.thinMaterial\)/);
  assert.match(swift.content, /\.overlay\(Color\(\.sRGB[^)]*\)\.opacity\(0\.14\)\)/, "the tint is a real overlay");
  assert.match(swift.content, /\.overlay\(RoundedRectangle\(cornerRadius: [\d.]+, style: \.continuous\)\.strokeBorder\(LinearGradient/);
  assert.match(swift.content, /\.shadow\(color: Color\(\.sRGB/);
  // An inner shadow has no view modifier, so it is a comment in the file *and*
  // an entry in `unsupported` — never a silent omission.
  assert.match(swift.content, /\/\/ Juno: inner shadow/);
  assert.match(swift.content, /\/\/ Juno: .*grain/);
  assert.match(swift.content, /\/\/ Juno: texture/);
  assert.ok(swift.unsupported.some((line) => /inner shadow/.test(line)));
  assert.ok(swift.unsupported.some((line) => /grain/.test(line)));
  assert.ok(swift.unsupported.some((line) => /texture/.test(line)));
  assert.ok(swift.unsupported.some((line) => /glass/.test(line) && /24pt/.test(line)));
  assert.ok(swift.unsupported.some((line) => /refraction/.test(line)));
  assert.ok(swift.unsupported.some((line) => /spread/.test(line)));
});

test("PDF says what it did not draw, effect by effect", () => {
  const pdf = exportPdf(glassDocument(), PAGE_ID);
  assert.ok(pdf.unsupported.some((line) => /glass is not drawn in PDF/.test(line)));
  assert.ok(pdf.unsupported.some((line) => /noise is not drawn in PDF/.test(line)));
  assert.ok(pdf.unsupported.some((line) => /drop shadow is not drawn in PDF/.test(line)));
  assert.ok(pdf.content.startsWith("%PDF-1.4"), "and still produces a readable file");
});

test("text shadows lose what text-shadow cannot say, out loud", () => {
  const doc = run(signInDocument(), [setEffects(["title"], [RIM, { ...DROP, spread: 5 }])]).document;
  const html = exportHtmlPrototype(doc, PAGE_ID);
  assert.match(html.content, /text-shadow: 0px 8px 24px/);
  assert.ok(html.unsupported.some((line) => /inner shadow on a text layer/.test(line)));
  assert.ok(html.unsupported.some((line) => /no spread/.test(line)));
});

// ---------------------------------------------------------------------------
// Fills and strokes as lists
// ---------------------------------------------------------------------------

test("a layer can hold several fills, each with its own opacity and eye", () => {
  const doc = run(signInDocument(), [
    {
      op: "updateNode",
      nodeId: "button",
      patch: {
        fills: [
          { type: "solid", color: { r: 0, g: 0, b: 0, a: 1 } },
          { type: "solid", color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 0.4 },
          { type: "solid", color: { r: 1, g: 0, b: 0, a: 1 }, visible: false },
        ],
      },
    },
  ]).document;
  assert.equal(doc.nodes["button"].fills.length, 3);
  assert.equal(doc.nodes["button"].fills[1].opacity, 0.4);
  assert.equal(doc.nodes["button"].fills[2].visible, false);
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

test("a stroke list survives the operation layer and its inverse", () => {
  const doc = signInDocument();
  const strokes = [
    { paint: { type: "solid" as const, color: { r: 0, g: 0, b: 0, a: 1 } }, weight: 2, align: "inside" as const },
    { paint: { type: "solid" as const, color: { r: 1, g: 1, b: 1, a: 1 }, opacity: 0.5 }, weight: 1, align: "outside" as const },
  ];
  const source = transaction([{ op: "updateNode", nodeId: "button", patch: { strokes } }], { baseRevision: doc.revision });
  const applied = applyTransaction(doc, source);
  assert.deepEqual(applied.document.nodes["button"].strokes, strokes);

  const undone = applyTransaction(applied.document, invertTransaction(applied, source, "2026-01-01T00:04:00.000Z"));
  assert.deepEqual(undone.document.nodes["button"].strokes, doc.nodes["button"].strokes);
});

test("a second fill is drawn, not silently dropped, in SVG and in CSS", () => {
  const doc = run(signInDocument(), [
    {
      op: "updateNode",
      nodeId: "button",
      patch: {
        fills: [
          { type: "solid", color: { r: 0, g: 0, b: 0, a: 1 } },
          { type: "solid", color: { r: 1, g: 0, b: 0, a: 1 }, opacity: 0.5 },
        ],
      },
    },
  ]).document;

  // SVG: the base shape plus one silhouette per extra fill, inside one group so
  // an effect filter runs once rather than once per fill.
  const svg = renderPageSvg(doc, PAGE_ID).svg;
  assert.match(svg, /fill="rgba\(0, 0, 0, 1\)"/);
  assert.match(svg, /fill="rgba\(255, 0, 0, 1\)" fill-opacity="0\.5"/);

  // CSS: an extra solid becomes the degenerate gradient that is how you say
  // "a flat background layer".
  const html = exportHtmlPrototype(doc, PAGE_ID).content;
  assert.match(html, /background-image: linear-gradient\(rgba\(255, 0, 0, 1\), rgba\(255, 0, 0, 1\)\)/);

  // SwiftUI: an overlay carrying the paint's own opacity.
  const swift = exportSwiftUI(doc, PAGE_ID);
  assert.match(swift.content, /\.overlay\(Color\(\.sRGB, red: 1, green: 0, blue: 0, opacity: 1\)\.opacity\(0\.5\)\)/);

  // PDF cannot stack them and says which ones it dropped.
  assert.ok(exportPdf(doc, PAGE_ID).unsupported.some((line) => /stacked fill/.test(line)));
});

test("an effect over stacked fills is applied once, to the whole stack", () => {
  const fills = [
    { type: "solid" as const, color: { r: 0, g: 0, b: 0, a: 1 } },
    { type: "solid" as const, color: { r: 1, g: 1, b: 1, a: 1 } },
  ];
  const doc = run(signInDocument(), [
    { op: "updateNode", nodeId: "button", patch: { fills } },
    setEffects(["button"], [DROP]),
  ]).document;
  const svg = renderPageSvg(doc, PAGE_ID).svg;
  // One filter reference, on the group — not one per fill, which would cast the
  // same drop shadow twice.
  assert.equal((svg.match(/filter="url\(#jd\d+\)"/g) ?? []).length, 1);
  assert.match(svg, /<g filter="url\(#jd\d+\)">/);
});

/**
 * `backdropCopy` re-emits every painted chunk beneath a glass layer. Those
 * copies were themselves in the paint list, so the second glass card copied the
 * first card's copy as well as the original, and the third copied both —
 * multiplicative growth in the number of overlapping backdrop layers.
 *
 * Measured on this exact fixture before the fix: 1 layer 4,488 bytes, 4 layers
 * 93,903, 6 layers 812,695 — roughly 2.8x per added layer. After: 4,488 /
 * 18,135 / 30,459, i.e. linear.
 */
test("overlapping glass layers do not compound each other's backdrops", () => {
  const stack = (count: number) => {
    let doc = signInDocument();
    for (let i = 0; i < count; i += 1) {
      doc = run(doc, [
        {
          op: "createNode",
          parentId: null,
          pageId: PAGE_ID,
          node: {
            type: "rectangle",
            id: `glass${i}`,
            name: `Glass ${i}`,
            patch: {
              x: 10 + i * 4,
              y: 10 + i * 4,
              width: 300,
              height: 300,
              effects: [GLASS],
            },
          },
        },
      ]).document;
    }
    return renderPageSvg(doc, PAGE_ID).svg.length;
  };

  const one = stack(1);
  const four = stack(4);
  // Linear-ish growth. Compounding copies used to make this ratio explode; the
  // bound is deliberately loose so it tests the shape, not a byte count.
  assert.ok(
    four < one * 6,
    `four glass layers should not cost multiplicatively (1 layer ${one} bytes, 4 layers ${four})`
  );
});
