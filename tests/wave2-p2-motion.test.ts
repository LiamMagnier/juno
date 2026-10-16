import assert from "node:assert/strict";
import test from "node:test";

import { SPRING, TIMING_TOKENS } from "@/lib/design/tokens.generated";
import { TIMING } from "@/lib/interaction";
import { STAGGER_MAX, settle, spring, staggerDelay } from "@/lib/motion";
import {
  DISMISS_FRACTION,
  DISMISS_VELOCITY,
  EDGE_ZONE_PX,
  INTENT_SLOP_PX,
  OPEN_FRACTION,
  OPEN_VELOCITY,
  RUBBER_BAND_C,
  RUBBER_BAND_LIMIT_PX,
  SETTLE_MAX_MS,
  SETTLE_MIN_MS,
  rubberBand,
  settleMs,
} from "@/lib/sheet-gesture";

/* P2-web-foundations (1), (2), (5): the motion presets, the timing table and the gesture constants. */

test("settle duration is clamped to 140–300 and shortens as velocity rises", () => {
  const remaining = 300;
  const speeds = [0, 0.05, 0.5, 1, 1.5, 2, 3, 10];
  const durations = speeds.map((v) => settle(remaining, v).ms);
  for (const ms of durations) assert.ok(ms >= 140 && ms <= 300, `${ms} outside 140–300`);
  assert.equal(durations[0], 300, "a release with no speed takes the maximum");
  assert.equal(durations[durations.length - 1], 140, "a hard flick takes the minimum");
  for (let i = 1; i < durations.length; i++) assert.ok(durations[i] <= durations[i - 1], `not monotone at ${speeds[i]}`);
  // Strictly shorter somewhere in the middle of the range: remaining / v.
  assert.equal(settle(remaining, 1.5).ms, 200);
  assert.equal(settle(-remaining, -1.5).ms, 200, "sign does not matter");
  const { duration, ease } = settle(remaining, 1.5);
  assert.equal(duration, 0.2, "framer takes seconds");
  assert.deepEqual(ease, [0.32, 0.72, 0, 1], "--ease-drawer");
});

test("sheet-gesture constants equal the wave-1 values", () => {
  assert.equal(INTENT_SLOP_PX, 8);
  assert.equal(DISMISS_VELOCITY, 0.5);
  assert.equal(DISMISS_FRACTION, 0.3);
  assert.equal(OPEN_VELOCITY, 0.3);
  assert.equal(OPEN_FRACTION, 0.4);
  assert.equal(EDGE_ZONE_PX, 24);
  assert.equal(RUBBER_BAND_LIMIT_PX, 64);
  assert.equal(RUBBER_BAND_C, 0.55);
  assert.equal(SETTLE_MIN_MS, 140);
  assert.equal(SETTLE_MAX_MS, 300);
  // The rubber band is (1 − 1/(x·0.55/64 + 1))·64 and never passes 64.
  assert.equal(rubberBand(0), 0);
  assert.ok(Math.abs(rubberBand(64) - (1 - 1 / (0.55 + 1)) * 64) < 1e-9);
  assert.ok(rubberBand(10_000) < 64);
  assert.ok(rubberBand(-100) < 0);
  assert.equal(settleMs(300, 0), 300);
});

test("spring presets read the generated springs (bounce 0.05 on standard, interactive retired)", () => {
  assert.deepEqual(spring.snap, { type: "spring", visualDuration: 0.18, bounce: 0 });
  assert.deepEqual(spring.standard, { type: "spring", visualDuration: 0.22, bounce: 0.05 });
  assert.deepEqual(spring.layout, { type: "spring", visualDuration: 0.36, bounce: 0 });
  assert.deepEqual(spring.emphasized, { type: "spring", visualDuration: 0.36, bounce: 0.1 });
  assert.deepEqual(spring.reward, { type: "spring", visualDuration: 0.36, bounce: 0.18 });
  assert.deepEqual(spring.articulate, { type: "spring", visualDuration: 0.22, bounce: 0.15 });
  assert.equal("interactive" in spring, false, "spring.interactive is retired (D28)");
  for (const name of Object.keys(SPRING) as Array<keyof typeof SPRING>) {
    assert.equal(spring[name].visualDuration, SPRING[name].visualDuration, name);
    assert.equal(spring[name].bounce, SPRING[name].bounce, name);
  }
});

test("TIMING mirrors the §4.2 named families", () => {
  const expected = {
    show: 200,
    tooltip: 500,
    tooltipSkip: 300,
    hairline: 300,
    actionRow: 180,
    greeting: 60,
    insertFlush: 300,
    phase: 600,
    skeleton: 400,
    check: 120,
    reasoning: 1000,
    arm: 500,
    needsYouMax: 2000,
    insertMax: 10_000,
    composerIdle: 2000,
    finishCheckMinWatched: 10_000,
    settledHapticMin: 3000,
  };
  for (const [key, value] of Object.entries(expected)) assert.equal(TIMING[key as keyof typeof TIMING], value, key);
  assert.equal(TIMING.show, TIMING_TOKENS.delay.show);
  assert.equal(TIMING.arm, TIMING_TOKENS.hold.arm);
});

test("CSS stagger caps at four items (D17)", () => {
  assert.equal(STAGGER_MAX, 4);
  assert.deepEqual(staggerDelay(0, "tight"), { animationDelay: "0ms" });
  assert.deepEqual(staggerDelay(3, "tight"), { animationDelay: "90ms" });
  assert.deepEqual(staggerDelay(9, "tight"), { animationDelay: "90ms" }, "later items paint with the fourth");
  assert.deepEqual(staggerDelay(2, "base"), { animationDelay: "90ms" });
  assert.deepEqual(staggerDelay(1, "loose", 100), { animationDelay: "160ms" });
});
