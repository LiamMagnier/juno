/**
 * Emit the cross-platform design fixture the Swift round-trip test reads.
 *
 * The fixture is produced by the WEBSITE's operation layer on purpose: the Swift
 * test then proves that a document this app actually writes decodes and
 * re-encodes byte-identically on the Mac. A hand-written Swift fixture would
 * only prove Swift agrees with itself.
 *
 *   npx tsx scripts/emit-design-fixture.ts
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { run, signInDocument, withTokens, PAGE_ID } from "../tests/design-fixtures";
import { serializeDesignDocument } from "../src/lib/design/migrations";

let doc = withTokens(signInDocument());

// Exercise every shape the Swift model has to carry: a component and instance,
// a bound variable, a gradient, a stroke and shadow, a prototype interaction, a
// spring animation, an inline comment, and an image asset.
doc = run(doc, [
  { op: "createComponent", nodeId: "button", componentId: "cmp-primary", name: "Primary button", description: "The main action." },
  { op: "setComponentProperty", componentId: "cmp-primary", property: { name: "Label", type: "text", defaultValue: "Sign in", targetNodeId: "buttonLabel", targetField: "characters" } },
  { op: "createInstance", componentId: "cmp-primary", parentId: "screen", pageId: PAGE_ID, instanceId: "inst-secondary", x: 24, y: 640 },
  { op: "bindVariable", nodeId: "button", property: "fills.0.color", variableId: "var-primary" },
  {
    op: "updateNode",
    nodeId: "card",
    patch: {
      fills: [
        {
          type: "linear-gradient",
          stops: [
            { position: 0, color: { r: 1, g: 1, b: 1, a: 1 } },
            { position: 1, color: { r: 0.95, g: 0.96, b: 1, a: 1 } },
          ],
          from: { x: 0, y: 0 },
          to: { x: 0, y: 1 },
        },
      ],
      strokes: [{ paint: { type: "solid", color: { r: 0.85, g: 0.86, b: 0.9, a: 1 } }, weight: 1, align: "inside", dash: [4, 2] }],
      effects: [{ type: "drop-shadow", color: { r: 0, g: 0, b: 0, a: 0.12 }, offsetX: 0, offsetY: 8, blur: 24, spread: -4 }],
      cornerRadius: [16, 16, 8, 8],
      limits: { minWidth: 240, maxWidth: 480 },
    },
  },
  {
    op: "createInteraction",
    interaction: {
      id: "int-signin",
      sourceNodeId: "button",
      trigger: { type: "click" },
      action: { type: "navigate", targetNodeId: "screen" },
      transition: { kind: "slide", direction: "left", durationMs: 260, delayMs: 0, easing: { type: "ease-out" }, matchStableIds: true },
    },
  },
  {
    op: "createAnimation",
    animation: {
      id: "anim-hover",
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
        {
          nodeId: "card",
          property: "fillColor",
          keyframes: [{ time: 0, value: { r: 1, g: 1, b: 1, a: 1 }, easing: { type: "cubic-bezier", x1: 0.2, y1: 0, x2: 0, y2: 1 } }],
        },
      ],
    },
  },
]).document;

// Assets, comments and a mode switch are document-level and set directly — the
// operation vocabulary intentionally has no "attach arbitrary asset" verb.
doc = {
  ...doc,
  assets: {
    "asset-logo": {
      id: "asset-logo",
      kind: "image",
      url: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=",
      width: 48,
      height: 48,
      mimeType: "image/svg+xml",
    },
  },
  comments: [
    {
      id: "cmt-1",
      nodeId: "button",
      pageId: PAGE_ID,
      x: 24,
      y: 420,
      body: "Make the radius a little softer — and keep the token.",
      authorId: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      resolvedAt: null,
      transactionId: null,
    },
  ],
};

const output = resolve(
  process.cwd(),
  "native/Packages/JunoNativeKit/Tests/JunoDesignKitTests/Fixtures/sign-in.juno.design.json"
);
writeFileSync(output, `${serializeDesignDocument(doc)}\n`);
console.log(`[design-fixture] wrote ${output} (${Object.keys(doc.nodes).length} nodes)`);
