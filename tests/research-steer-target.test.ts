import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { guideModeAvailable, guideModeKey, readGuideMode, steerTarget, writeGuideMode, type StorageLike } from "@/components/research/steer";

/*
 * Where a composer message goes while a run works (SPEC §9.7, DECISIONS R6):
 * an explicit "Ask Juno | Guide the research" mode, Ask by default and
 * remembered per run for the tab, so a follow-up question typed during a run
 * never silently becomes guidance (research-UI bug 1). Guide sends
 * `/steer { guidance }` and never the chat.
 */

const root = path.resolve(__dirname, "..");

test("the steering rule keeps server-only out of its static graph", () => {
  const source = readFileSync(path.join(root, "src/components/research/steer.ts"), "utf8");
  assert.doesNotMatch(source, /^import "server-only";/m);
  assert.doesNotMatch(source, /^import (?!type )[^;]*"@\/lib\/(prisma|db|research\/(claims|engine|run))"/m);
});

const run = (state: string) => ({ id: "run 1", state });

test("the switch shows while the run works or is paused, never at a gate or once it is over", () => {
  for (const state of ["investigating", "reviewing", "synthesizing", "validating_citations", "paused"]) {
    assert.equal(guideModeAvailable(run(state)), true, state);
  }
  for (const state of ["accepted", "planning", "clarifying", "awaiting_clarification", "awaiting_plan_confirmation", "completed", "partially_completed", "failed", "cancelled"]) {
    assert.equal(guideModeAvailable(run(state)), false, state);
  }
  assert.equal(guideModeAvailable(null), false);
  assert.equal(guideModeAvailable(undefined), false);
});

test("Ask is an ordinary chat turn, whatever the run is doing", () => {
  assert.deepEqual(steerTarget("ask", run("investigating"), "What about cost?"), { kind: "chat" });
  assert.deepEqual(steerTarget("ask", null, "hi"), { kind: "chat" });
});

test("Guide sends trimmed guidance to the run's steer route, never to the chat", () => {
  assert.deepEqual(steerTarget("guide", run("investigating"), "  Focus on Nordic field trials  "), {
    kind: "research",
    runId: "run 1",
    url: "/api/research/run%201/steer",
    body: { guidance: "Focus on Nordic field trials" },
  });
  // Paused: it applies on resume.
  assert.equal(steerTarget("guide", run("paused"), "x").kind, "research");
});

test("a Guide mode left over from a run that stopped working falls back to the chat", () => {
  for (const state of ["awaiting_plan_confirmation", "completed", "cancelled"]) {
    assert.deepEqual(steerTarget("guide", run(state), "x"), { kind: "chat" }, state);
  }
  assert.deepEqual(steerTarget("guide", null, "x"), { kind: "chat" });
});

function memory(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}

test("the default is Ask, remembered per run in session storage", () => {
  const storage = memory();
  assert.equal(readGuideMode(storage, "r1"), "ask");
  writeGuideMode(storage, "r1", "guide");
  assert.equal(storage.map.get(guideModeKey("r1")), "guide");
  assert.equal(guideModeKey("r1"), "juno:research-mode:r1");
  assert.equal(readGuideMode(storage, "r1"), "guide");
  // Another run starts on Ask.
  assert.equal(readGuideMode(storage, "r2"), "ask");
  // Back to Ask forgets the choice rather than storing "ask".
  writeGuideMode(storage, "r1", "ask");
  assert.equal(storage.map.has(guideModeKey("r1")), false);
  assert.equal(readGuideMode(storage, "r1"), "ask");
});

test("storage that refuses (a private window) never breaks sending: Ask", () => {
  const refusing: StorageLike = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.equal(readGuideMode(refusing, "r1"), "ask");
  assert.doesNotThrow(() => writeGuideMode(refusing, "r1", "guide"));
  assert.equal(readGuideMode(null, "r1"), "ask");
});
