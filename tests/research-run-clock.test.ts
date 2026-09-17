import test from "node:test";
import assert from "node:assert/strict";
import { workingElapsedMs } from "@/components/research/run-clock";
import type { ResearchEventDTO, ResearchState } from "@/lib/research/domain";

/*
 * The live research clock counts the time the run spent WORKING, not the time
 * since it was asked. A web run parks at two gates and at pause until a person
 * acts, and the console must not bill that idle time to the investigation.
 */

const T0 = Date.parse("2026-09-17T10:00:00.000Z");
const MIN = 60_000;

let seq = 0;
function changed(from: string, state: string, atMs: number): ResearchEventDTO {
  seq += 1;
  return { id: `e${seq}`, seq, kind: "state_changed", payload: { from, state }, createdAt: new Date(atMs).toISOString() };
}
function other(kind: ResearchEventDTO["kind"], atMs: number): ResearchEventDTO {
  seq += 1;
  return { id: `e${seq}`, seq, kind, payload: {}, createdAt: new Date(atMs).toISOString() };
}
const run = (state: ResearchState) => ({ state, createdAt: new Date(T0).toISOString() });

test("time parked at the plan gate is not counted", () => {
  const events = [
    changed("accepted", "planning", T0 + 1 * MIN),
    changed("planning", "awaiting_plan_confirmation", T0 + 2 * MIN),
    // Overnight at the gate.
    changed("awaiting_plan_confirmation", "investigating", T0 + 600 * MIN),
  ];
  const now = T0 + 604 * MIN;
  assert.equal(workingElapsedMs(events, run("investigating"), now), 1 * MIN + 4 * MIN);
});

test("a paused run's clock holds, and resumes where it left off", () => {
  const events = [
    changed("accepted", "planning", T0),
    changed("planning", "investigating", T0 + 1 * MIN),
    changed("investigating", "paused", T0 + 4 * MIN),
  ];
  // Paused for twenty minutes: the figure is the four worked, whatever `now` is.
  assert.equal(workingElapsedMs(events, run("paused"), T0 + 24 * MIN), 4 * MIN);
  const resumed = [...events, changed("paused", "investigating", T0 + 24 * MIN)];
  assert.equal(workingElapsedMs(resumed, run("investigating"), T0 + 25 * MIN), 5 * MIN);
});

test("the live tail follows the log, not the row, so a lagging page freezes rather than over-counts", () => {
  const events = [
    changed("accepted", "planning", T0),
    changed("planning", "awaiting_plan_confirmation", T0 + 2 * MIN),
  ];
  // The row already says investigating; the transition event has not arrived.
  assert.equal(workingElapsedMs(events, run("investigating"), T0 + 30 * MIN), 2 * MIN);
});

test("no transitions yet: a working run anchors on createdAt, a parked one shows nothing", () => {
  assert.equal(workingElapsedMs([], run("planning"), T0 + 90_000), 90_000);
  assert.equal(workingElapsedMs([other("query_issued", T0)], run("planning"), T0 + 90_000), 90_000);
  assert.equal(workingElapsedMs([], run("accepted"), T0 + 90_000), null);
  assert.equal(workingElapsedMs([], run("awaiting_plan_confirmation"), T0 + 90_000), null);
  assert.equal(workingElapsedMs([], { state: "planning", createdAt: null }, T0), null);
});

test("a clock skewed behind the server never goes negative", () => {
  const events = [changed("accepted", "planning", T0 + 5_000)];
  assert.equal(workingElapsedMs(events, run("planning"), T0), 0);
  assert.equal(workingElapsedMs([], run("planning"), T0 - 5_000), 0);
});

test("malformed transitions are skipped rather than trusted", () => {
  seq += 1;
  const bad: ResearchEventDTO = { id: "bad", seq, kind: "state_changed", payload: { state: 42 }, createdAt: "not a date" };
  const events = [bad, changed("accepted", "investigating", T0)];
  assert.equal(workingElapsedMs(events, run("investigating"), T0 + MIN), MIN);
});
