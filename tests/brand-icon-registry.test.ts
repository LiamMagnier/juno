import test from "node:test";
import assert from "node:assert/strict";
import { ORBIT_GLYPH, CODE_GLYPH } from "@/components/brand/brand-glyphs";
import { ICONS, resolveIconAt, type IconDrawing } from "@/components/ui/juno-icons/drawings";

/** Numbers in a path, scaled. */
const nums = (d: string, k = 1) => (d.match(/-?\d*\.?\d+/g) ?? []).map((n) => Number(n) * k);
const close = (a: number[], b: number[], tol: number) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= tol);
const pathsOf = (els: { tag: string; attrs: Record<string, string | number> }[]) => els.filter((e) => e.tag === "path").map((e) => String(e.attrs.d));

test("the registry's Orbit is the brand glyph: the 24 master exactly, the small cut the 16 master", () => {
  const regular = pathsOf(ICONS.orbit.elements);
  assert.deepEqual(regular, ORBIT_GLYPH[24].paths);
  const small = pathsOf(resolveIconAt("orbit", 16)!.elements);
  assert.equal(small.length, 2);
  small.forEach((d, i) => {
    // The 16 px master is drawn in px; the registry in 24-grid units (x 1.5). Points and radii scale;
    // the arc's tilt (-24 degrees) and its two flags do not.
    const a = nums(d);
    const b = nums(ORBIT_GLYPH[16].paths[i], 1.5);
    const raw = nums(ORBIT_GLYPH[16].paths[i]);
    for (const j of [4, 5, 6]) b[j] = raw[j];
    assert.ok(close(a, b, 0.002), `${d} vs ${ORBIT_GLYPH[16].paths[i]}`);
  });
});

test("Orbit has no selected form and no motion; Chat fills when selected", () => {
  const orbit: IconDrawing = ICONS.orbit;
  assert.equal(orbit.on, undefined);
  assert.equal(orbit.fill, undefined);
  assert.equal(orbit.hover, undefined);
  assert.deepEqual(ICONS.chat.on, { kind: "fill" });
});

test("the registry's Code is brackets with an inset cursor, not </>", () => {
  const ds = JSON.stringify(ICONS.code.elements);
  assert.ok(!ds.includes("13.5 5.25"), "the </> slash is gone");
  assert.equal(CODE_GLYPH[24].paths.length, 3);
  // Two bracket groups and the cursor, at 24 and in the small cut.
  assert.equal(ICONS.code.elements.length, 3);
  assert.equal(resolveIconAt("code", 16)!.elements.length, 3);
});
