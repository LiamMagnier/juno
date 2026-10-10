import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { refreshResearchFactsWith, type MessageRunClock } from "@/lib/research/message-time";
import { activeWorkingMs } from "@/lib/research/view";
import type { ClientActivityEvent } from "@/types/chat";

/*
 * Messages written before the clock fix stored wall clock in their research
 * fact ("Researched for 30h 27m" for a fifteen-minute run). The stored figure
 * is never shown: the serializer recalculates it from the run, and hides it
 * when the run is gone.
 */

const STORED_30H = 30 * 3_600_000 + 27 * 60_000;
const MIN = 60_000;
const T0 = new Date("2026-10-09T08:00:00.000Z");
const at = (m: number) => new Date(T0.getTime() + m * MIN);

function message(runId: string): ClientActivityEvent[] {
  return [
    { id: "a1", kind: "search", title: "Searching", createdAt: T0.toISOString() } as ClientActivityEvent,
    {
      id: "a2",
      kind: "search",
      title: "Research report",
      createdAt: T0.toISOString(),
      fact: { key: "research", runId, title: "Plans", workedMs: STORED_30H, cited: 45, read: 50, pages: 50, leadModel: "claude-fable", state: "completed" },
    } as ClientActivityEvent,
  ];
}

const RUN: MessageRunClock = {
  id: "run-1",
  userId: "u1",
  createdAt: T0,
  startedAt: T0,
  finishedAt: at(30 * 60 + 16),
  state: "completed",
  plan: {},
};

const factOf = (events: ClientActivityEvent[] | undefined) => events?.find((event) => event.fact?.key === "research")?.fact;

test("a stored 30h figure is replaced by the run's working time", async () => {
  // 12 minutes of work, a night nobody drove the run, 4 more minutes.
  const events = [
    { at: at(0), state: "investigating" },
    { at: at(12) },
    { at: at(12 + 30 * 60), state: "synthesizing" },
    { at: at(30 * 60 + 16), state: "completed" },
  ];
  const refreshed = await refreshResearchFactsWith(message("run-1"), "conv-1", {
    lookup: async (runId, conversationId) => (runId === "run-1" && conversationId === "conv-1" ? RUN : null),
    workingMs: async (run) => activeWorkingMs({ startedAt: run.startedAt ?? run.createdAt, end: run.finishedAt ?? new Date(), events }),
  });
  const fact = factOf(refreshed);
  assert.equal(fact?.key, "research");
  assert.ok(fact && fact.key === "research" && fact.workedMs < 30 * MIN, `got ${fact && fact.key === "research" ? fact.workedMs / MIN : "?"} min`);
  assert.notEqual(fact && fact.key === "research" ? fact.workedMs : null, STORED_30H);
  // Everything else about the message is untouched.
  assert.equal(refreshed?.length, 2);
  assert.equal(refreshed?.[0].title, "Searching");
});

test("a run that cannot be found hides the time instead of showing the stored one", async () => {
  const refreshed = await refreshResearchFactsWith(message("gone"), "conv-1", {
    lookup: async () => null,
    workingMs: async () => {
      throw new Error("not called");
    },
  });
  const fact = factOf(refreshed);
  assert.equal(fact && fact.key === "research" ? fact.workedMs : null, 0);
});

test("a message with no research fact is passed through untouched", async () => {
  const plain = [{ id: "a1", kind: "search", title: "Searching", createdAt: T0.toISOString() } as ClientActivityEvent];
  let looked = false;
  const out = await refreshResearchFactsWith(plain, "conv-1", {
    lookup: async () => {
      looked = true;
      return null;
    },
    workingMs: async () => 0,
  });
  assert.equal(out, plain);
  assert.equal(looked, false);
});

test("the serializer, the web line and the native line all honour it", () => {
  const serializers = readFileSync("src/lib/serializers.ts", "utf8");
  assert.match(serializers, /activity: await refreshResearchFacts\(serializeActivity\(msg\.activity\), msg\.conversationId\)/);
  const summary = readFileSync("src/lib/run/summary.ts", "utf8");
  assert.match(summary, /if \(!\(research\.workedMs > 0\)\) return \[only\("researched"\)\]/);
  const native = readFileSync("native/Packages/JunoNativeKit/Sources/JunoChatKit/NativeRunPresentation.swift", "utf8");
  assert.match(native, /guard research\.workedMs > 0 else \{ return NativeRunPhrase\("Researched"\) \}/);
});
