import test from "node:test";
import assert from "node:assert/strict";
import { galaxyAngle, galaxyField, mulberry32, GALAXY_COUNT, GALAXY_OMEGA0 } from "../src/components/brand/galaxy-field";

test("mulberry32 matches its reference sequence (native ports check against this)", () => {
  const r = mulberry32(0xa1e7);
  const first = [r(), r(), r()].map((n) => n.toFixed(8));
  // Pinned so a change to the generator (which would change the galaxy on one platform only) fails here.
  assert.deepEqual(first, ["0.45009571", "0.61337260", "0.02546202"]);
});

test("the field is deterministic and shaped as specified", () => {
  const a = galaxyField();
  const b = galaxyField();
  assert.deepEqual(a, b);
  assert.equal(a.particles.length, GALAXY_COUNT);
  assert.equal(a.core.length, 6);
  const dust = a.particles.filter((p) => p.dust).length / GALAXY_COUNT;
  assert.ok(dust > 0.08 && dust < 0.3, `dust share ${dust}`);
  const accents = a.particles.filter((p) => p.accent).length;
  assert.ok(accents >= 5 && accents <= 10, `accent stars ${accents}`);
  for (const p of a.particles) {
    assert.ok(p.alpha >= 0 && p.alpha <= 1);
    assert.ok(p.r > 0 && p.r < 1.3);
  }
  for (const c of a.core) assert.ok(c.r < 0.06);
});

test("rotation: inner stars turn faster at the start (against the winding, so arms trail), and the winding is bounded", () => {
  const dt = 0.001;
  const inner = (galaxyAngle(0, 0.1, 0) - galaxyAngle(0, 0.1, dt)) / dt;
  const rim = (galaxyAngle(0, 1, 0) - galaxyAngle(0, 1, dt)) / dt;
  assert.ok(Math.abs(inner - GALAXY_OMEGA0 * (0.35 + 0.65 * 0.9)) < 1e-3);
  assert.ok(Math.abs(rim - GALAXY_OMEGA0 * 0.35) < 1e-3);
  // After ten minutes the inner/rim offset is still within a quarter-ish turn: no ring collapse.
  const t = 600;
  const offset = galaxyAngle(0, 0.1, t) - galaxyAngle(0, 1, t);
  assert.ok(Math.abs(offset) < 1.5, `offset ${offset}`);
});
