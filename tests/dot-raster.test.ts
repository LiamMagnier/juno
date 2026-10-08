import test from "node:test";
import assert from "node:assert/strict";
import { Raster, type Palette } from "../src/components/home/dot-engine";

const PALETTE: Palette = { ink: [0, 0, 0], presence: [45, 73, 201], sub: [100, 100, 100], strength: 1, glow: 0.4, floor: 0.4, size: 1, axis: 1, font: "monospace" };

/** A 2D context that only counts the dots it is asked to draw. */
function countingContext() {
  const ctx = { dots: 0, blooms: 0, globalAlpha: 1, fillStyle: "", beginPath() {}, moveTo() {}, fill() {}, arc() { ctx.dots++; }, drawImage() { ctx.blooms++; } };
  return ctx;
}

function frame(r: Raster, blue = false) {
  r.clear();
  for (let x = 2; x < 200; x += 4) r.plot(x, 50, 0.6, blue);
  const ctx = countingContext();
  r.draw(ctx as unknown as CanvasRenderingContext2D, PALETTE, null);
  return ctx.dots;
}

test("a refresh at the same grid size keeps drawing every dot (the blank-until-reload bug)", () => {
  const r = new Raster();
  r.resize(200, 100, 3.9);
  const first = frame(r);
  assert.ok(first > 40, `expected a full row of dots, got ${first}`);
  // A theme / accent / font-size change on <html> re-reads CSS and re-sizes the raster to the same grid.
  r.resize(200, 100, 3.9);
  assert.equal(frame(r), first);
  r.resize(200, 100, 3.9);
  assert.equal(frame(r, true), first, "presence dots survive too");
});

test("a resize that reallocates and one that does not both start from an empty grid", () => {
  const r = new Raster();
  r.resize(200, 100, 3.9);
  frame(r);
  r.resize(400, 100, 3.9);
  assert.equal(r.n, 0);
  assert.ok(r.lum.every((v) => v === 0));
  frame(r);
  r.resize(400, 100, 3.9);
  assert.ok(r.lum.every((v) => v === 0), "no stale brightness left behind");
});

test("a zero-sized box still yields a valid one-cell grid", () => {
  const r = new Raster();
  r.resize(0, 0, 3.9);
  assert.equal(r.gw, 1);
  assert.equal(r.gh, 1);
});
