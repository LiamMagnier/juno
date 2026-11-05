import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { SPRING } from "../src/lib/design/tokens.generated";
import { spring as webSpring } from "../src/lib/motion";
import { SPRING_REST_DELTA, parseBlocks, declsFor, project, springPosition, springTwin, withSpringTwins } from "../scripts/generate-design-tokens";

/**
 * P1 acceptance, spring twins (spec §4.4): each spring is defined once as
 * { visualDuration, bounce } and its CSS linear() twin is generated from it.
 */

const css = readFileSync(resolve(process.cwd(), "src/app/globals.css"), "utf8");
const root = declsFor(parseBlocks(css), ":root");

/** A CSS linear() easing (evenly spaced stops) evaluated at progress p in [0, 1]. */
function evalLinear(linear: string, p: number): number {
  const m = /^linear\(([^)]*)\)$/.exec(linear.trim());
  assert.ok(m, `not a linear() easing: ${linear}`);
  const points = m[1].split(",").map((v) => Number(v.trim()));
  const n = points.length - 1;
  const at = Math.min(n - 1, Math.floor(p * n));
  return points[at] + (points[at + 1] - points[at]) * (p * n - at);
}

const SPEC = {
  snap: [0.18, 0],
  standard: [0.22, 0.05],
  layout: [0.36, 0],
  emphasized: [0.36, 0.1],
  reward: [0.36, 0.18],
  articulate: [0.22, 0.15],
} as const;

test("each spring is declared once with the spec's { visualDuration, bounce }", () => {
  for (const [name, [vd, bounce]] of Object.entries(SPEC)) {
    assert.equal(root.get(`spring-${name}-params`), `${vd} ${bounce}`, name);
    assert.deepEqual([SPRING[name as keyof typeof SPRING].visualDuration, SPRING[name as keyof typeof SPRING].bounce], [vd, bounce]);
  }
});

test("the actual web presets consume the generated CSS and Swift spring parameters", () => {
  for (const name of Object.keys(SPRING) as Array<keyof typeof SPRING>) {
    assert.deepEqual(webSpring[name], {
      type: "spring", visualDuration: SPRING[name].visualDuration, bounce: SPRING[name].bounce,
    }, `${name} must not substitute total duration for visual duration`);
  }
});

test("the generated --spring-standard twin matches a spring(0.22, 0.05) sample to within 0.01 at 16 points", () => {
  const linear = root.get("spring-standard")!;
  const settle = Number(/^(\d+)ms$/.exec(root.get("spring-standard-dur")!)![1]);
  const x = springPosition(0.22, 0.05);
  for (let k = 0; k <= 16; k += 1) {
    const p = k / 16;
    const expected = x((p * settle) / 1000);
    const actual = evalLinear(linear, p);
    assert.ok(Math.abs(actual - expected) <= 0.01, `t=${k}/16: twin ${actual.toFixed(4)} vs spring ${expected.toFixed(4)}`);
  }
  // The spec's expectation for its settle time (generator output is authoritative).
  assert.ok(settle >= 250 && settle <= 280, `standard settles in ${settle}ms`);
});

test("--spring-reward overshoots by at most 1.5%", () => {
  const linear = root.get("spring-reward")!;
  const points = /^linear\(([^)]*)\)$/.exec(linear)![1].split(",").map(Number);
  assert.ok(Math.max(...points) - 1 <= 0.015, `twin overshoot ${(Math.max(...points) - 1) * 100}%`);
  const x = springPosition(0.36, 0.18);
  let peak = 0;
  for (let t = 0; t < 2; t += 0.001) peak = Math.max(peak, x(t));
  assert.ok(peak - 1 <= 0.015 && peak - 1 > 0.005, `physics overshoot ${((peak - 1) * 100).toFixed(2)}% (spec: about 1.1%)`);
});

test("every twin in globals.css is the generator's, so the CSS curve and the spring cannot drift", () => {
  const { springs } = project(css);
  assert.equal(withSpringTwins(css, springs), css, "globals.css spring twins are stale: run npm run design:tokens");
  for (const s of springs) {
    assert.equal(root.get(`spring-${s.id}`), s.linear);
    assert.equal(root.get(`spring-${s.id}-dur`), `${s.settleMs}ms`);
    // The settle time is the moment the spring stays within the rest delta.
    const x = springPosition(s.visualDuration, s.bounce);
    assert.ok(Math.abs(1 - x(s.settleMs / 1000)) <= SPRING_REST_DELTA + 1e-6);
  }
});

test("editing a spring's params without regenerating is caught", () => {
  const edited = css.replace("--spring-standard-params: 0.22 0.05;", "--spring-standard-params: 0.3 0.05;");
  assert.notEqual(withSpringTwins(edited, project(edited).springs), edited);
});

test("the twin generator is deterministic and ends at rest", () => {
  const a = springTwin(0.22, 0.05);
  const b = springTwin(0.22, 0.05);
  assert.deepEqual(a, b);
  assert.equal(a.points[0], 0);
  assert.equal(a.points[a.points.length - 1], 1);
});

test("retired springs are gone, and reduced motion flattens every spring to out-soft at the base rung", () => {
  // D28 / REA T12: `--spring-pop` moved to --spring-reward, `--stagger-fav` to --stagger-row.
  for (const name of ["spring-pop", "spring-pop-dur", "stagger-fav"]) assert.equal(root.get(name), undefined, `--${name} is still declared`);
  const reduced = declsFor(parseBlocks(css), ":root", "@media (prefers-reduced-motion: reduce)");
  for (const name of Object.keys(SPEC)) {
    assert.equal(reduced.get(`spring-${name}`), "var(--ease-out-soft)", name);
    assert.equal(reduced.get(`spring-${name}-dur`), "var(--dur-base)", name);
  }
});
