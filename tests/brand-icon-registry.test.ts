import test from "node:test";
import assert from "node:assert/strict";
import { CODE_GLYPH } from "@/components/brand/brand-glyphs";
import { ICONS, type IconDrawing } from "@/components/ui/juno-icons/drawings";


test("the registry's Orbit is a centre with two satellites on an open orbit (redrawn 2026-10-02)", () => {
  const els = ICONS.orbit.elements;
  assert.equal(els.filter((e) => e.tag === "path").length, 2, "two orbit arcs");
  assert.equal(els.filter((e) => e.tag === "circle").length, 3, "the centre and two satellites");
});

test("Orbit has no selected form and no motion; Chat fills when selected", () => {
  const orbit: IconDrawing = ICONS.orbit;
  assert.equal(orbit.on, undefined);
  assert.equal(orbit.fill, undefined);
  assert.equal(orbit.hover, undefined);
  assert.deepEqual(ICONS.chat.on, { kind: "fill" });
});

test("the registry's Code is angle brackets around a slash (redrawn 2026-10-02)", () => {
  // Two bracket groups (they step apart on hover) and the slash.
  assert.equal(ICONS.code.elements.length, 3);
  assert.equal(ICONS.code.elements.filter((e) => e.tag === "g").length, 2);
  assert.equal(CODE_GLYPH[24].paths.length, 3);
});
