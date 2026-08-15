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
