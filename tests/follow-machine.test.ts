import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  answerBed, followsEnd, nextFollowState, startedTurn,
  FOLLOW_EVENTS, FOLLOW_STATES, PIN_INSET,
  type AnswerBedInput, type FollowEvent, type FollowRow, type FollowState,
} from "@/lib/chat/follow-machine";

/*
 * Reading-first follow (audit G18). The machine is held to the shared fixture
 * that JunoFollowMachineTests.swift also runs, so web, macOS and iOS move (and
 * refuse to move) the transcript for the same reasons.
 */

const fixture = JSON.parse(readFileSync(path.join(process.cwd(), "contracts/chat/follow-machine.fixtures.json"), "utf8")) as {
  states: FollowState[];
  events: FollowEvent[];
  transitions: Array<{ from: FollowState; event: FollowEvent; to: FollowState }>;
  follows: Record<FollowState, boolean>;
  bed: Array<{ name: string; input: AnswerBedInput; expect: { height: number; anchorTop: number; overflow: boolean } }>;
  startedTurn: Array<{ name: string; previous: string[]; rows: FollowRow[]; expect: string | null }>;
};

test("the fixture names exactly the machine's states and events", () => {
  assert.deepEqual(fixture.states, [...FOLLOW_STATES]);
  assert.deepEqual(fixture.events, [...FOLLOW_EVENTS]);
});

test("every state against every event matches the shared table", () => {
  const seen = new Set<string>();
  for (const { from, event, to } of fixture.transitions) {
    assert.equal(nextFollowState(from, event), to, `${from} + ${event}`);
    seen.add(`${from}|${event}`);
  }
  assert.equal(seen.size, FOLLOW_STATES.length * FOLLOW_EVENTS.length, "the table covers the whole matrix");
});

test("only following and placed move the viewport toward the end", () => {
  for (const state of FOLLOW_STATES) assert.equal(followsEnd(state), fixture.follows[state], state);
});

test("answer bed geometry matches the shared cases", () => {
  for (const { name, input, expect } of fixture.bed) assert.deepEqual(answerBed(input), expect, name);
});

test("turn detection matches the shared cases", () => {
  for (const { name, previous, rows, expect } of fixture.startedTurn) assert.equal(startedTurn(new Set(previous), rows), expect, name);
});

test("the bed keeps the scroll range still while the answer fills it", () => {
  // As the answer grows by d, the bed shrinks by d: content + bed is constant
  // until the answer meets the bottom of the viewport.
  const base = { viewportHeight: 700, turnTop: 3000, turnHeight: 64 };
  let total: number | null = null;
  for (let end = 3100; end <= 3000 + 700 - PIN_INSET; end += 37) {
    const bed = answerBed({ ...base, contentEnd: end });
    assert.equal(bed.overflow, false);
    total ??= end + bed.height;
    assert.ok(Math.abs(end + bed.height - total) <= 1, `scroll range moved at ${end}`);
  }
});

test("a send pins, overflow holds, the reader's return re-follows", () => {
  let state: FollowState = "following";
  const run = (...events: FollowEvent[]) => { for (const event of events) state = nextFollowState(state, event); return state; };
  assert.equal(run("turn-start"), "placed");
  assert.equal(followsEnd(state), true, "placing scrolls to the end, which is the pin");
  assert.equal(run("near-end"), "placed", "the bed makes the pin the end; resting there changes nothing");
  assert.equal(run("overflow"), "reading");
  assert.equal(followsEnd(state), false, "an answer past the fold never pulls the viewport");
  assert.equal(run("settle"), "reading");
  assert.equal(run("near-end"), "following");
  assert.equal(run("select"), "free");
  assert.equal(run("jump"), "following");
});
