import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stopGeneration, type StopGenerationDeps } from "@/lib/chat/stop-generation";

/*
 * POST /api/chat/cancel's decision (src/lib/chat/stop-generation.ts): abort
 * here when this process holds the turn, otherwise record the Stop durably,
 * and only say `cancelled: true` when a terminal frame is really on its way.
 */

const ref = { userId: "u1", generationId: "gen-1" };

function deps(overrides: Partial<StopGenerationDeps> = {}) {
  const calls: string[] = [];
  const base: StopGenerationDeps = {
    cancelLocal: () => {
      calls.push("local");
      return false;
    },
    recordCancel: async () => {
      calls.push("record");
    },
    flagReceipt: async () => {
      calls.push("receipt");
      return false;
    },
    isLive: async () => {
      calls.push("live");
      return false;
    },
  };
  return { calls, deps: { ...base, ...overrides } as StopGenerationDeps };
}

test("held here: aborted at once, nothing written", async () => {
  const { calls, deps: d } = deps({ cancelLocal: () => true });
  assert.deepEqual(await stopGeneration(ref, d), { cancelled: true, delivery: "local" });
  assert.deepEqual(calls, [], "the common case costs no database write");
});

test("held by another process: recorded durably, and the live lease makes it `cancelled`", async () => {
  const { calls, deps: d } = deps({ isLive: async () => true });
  assert.deepEqual(await stopGeneration(ref, d), { cancelled: true, delivery: "remote" });
  assert.deepEqual(calls.sort(), ["local", "receipt", "record"].sort());
});

test("a running receipt took the flag: some process polls it, so `cancelled`", async () => {
  const { deps: d } = deps({ flagReceipt: async () => true });
  assert.deepEqual(await stopGeneration(ref, d), { cancelled: true, delivery: "remote" });
});

test("recorded but no holder yet: `queued` — the client stops reading, the server still stops the turn if it appears", async () => {
  const { calls, deps: d } = deps();
  assert.deepEqual(await stopGeneration(ref, d), { cancelled: false, delivery: "queued" });
  assert.ok(calls.includes("record"));
});

test("nothing could be recorded: `none`, never a throw", async () => {
  const errors: string[] = [];
  const { deps: d } = deps({
    recordCancel: async () => {
      throw new Error("db down");
    },
    flagReceipt: async () => {
      throw new Error("db down");
    },
    onError: (stage) => errors.push(stage),
  });
  assert.deepEqual(await stopGeneration(ref, d), { cancelled: false, delivery: "none" });
  assert.deepEqual(errors.sort(), ["receipt", "record"]);
});

test("a liveness read that fails is not a claim that the turn is running", async () => {
  const { deps: d } = deps({
    isLive: async () => {
      throw new Error("timeout");
    },
  });
  assert.deepEqual(await stopGeneration(ref, d), { cancelled: false, delivery: "queued" });
});

test("the cancel route is wired to the cross-process Stop, not to the per-process map alone", () => {
  const route = readFileSync(new URL("../src/app/api/chat/cancel/route.ts", import.meta.url), "utf8");
  assert.match(route, /stopGeneration\(/);
  assert.match(route, /await recordGenerationCancel\(ref\)/);
  assert.match(route, /rateLimit\(\{ key: `chat-cancel:\$\{user\.id\}`/, "durable Stops are bounded per account");
  assert.match(route, /flagReceipt: requestChatCancel/);
  assert.match(route, /cancelled: result\.cancelled, delivery: result\.delivery/);
  const resume = readFileSync(new URL("../src/app/api/chat/stream/[generationId]/route.ts", import.meta.url), "utf8");
  assert.match(resume, /isGenerationLive\(id, user\.id\)/, "the resume route asks other processes before calling a turn over");
});
