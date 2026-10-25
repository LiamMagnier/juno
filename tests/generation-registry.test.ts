import test from "node:test";
import assert from "node:assert/strict";
import { createGenerationRegistry, GENERATION_REGISTRY_MAX_AGE_MS } from "@/lib/chat/generation-registry";
import { resolveTerminalState } from "@/lib/chat/terminal-state";

/*
 * The in-process generation registry (src/lib/chat/generation-registry.ts):
 * one abort cause per generation, the first one wins, and an entry lives until
 * its own unregister — so the route's terminal state never depends on the
 * order two aborts arrived in or on unrelated traffic.
 */

const quiet = { info: () => {} };
const entry = (userId = "u1") => ({ userId, controller: new AbortController(), model: "m" });
const output = { hasText: true, hasReasoning: false, artifactEdit: false };

function terminalFor(registry: ReturnType<typeof createGenerationRegistry>, id: string) {
  return resolveTerminalState(
    {
      stalled: false,
      budgetHalted: false,
      userStopped: registry.wasStopped(id),
      shutdown: registry.wasAbortedForShutdown(id),
      leaseLost: false,
      error: new DOMException("aborted", "AbortError"),
    },
    output
  );
}

test("a Stop is a user stop: partial kept, charge kept", () => {
  const registry = createGenerationRegistry({ logger: quiet });
  const e = entry();
  registry.register("g1", e);
  assert.equal(registry.cancel("g1", "u1"), true);
  assert.equal(e.controller.signal.aborted, true);
  const terminal = terminalFor(registry, "g1");
  assert.equal(terminal.finishReason, "user_stopped");
  assert.equal(terminal.persistsPartial, true);
  assert.equal(terminal.refunds, false);
});

test("Stop then drain: the Stop stands, and the drain does not count it", () => {
  const registry = createGenerationRegistry({ logger: quiet });
  registry.register("g1", entry());
  registry.cancel("g1", "u1");
  assert.equal(registry.abortAllForShutdown(), 0);
  assert.equal(registry.wasStopped("g1"), true);
  assert.equal(registry.wasAbortedForShutdown("g1"), false);
  assert.equal(terminalFor(registry, "g1").finishReason, "user_stopped");
});

test("drain then Stop: the drain stands (refunded), the late Stop is acknowledged without rewriting it", () => {
  const registry = createGenerationRegistry({ logger: quiet });
  registry.register("g1", entry());
  assert.equal(registry.abortAllForShutdown(), 1);
  assert.equal(registry.cancel("g1", "u1"), true, "the generation is ending; a terminal frame is coming");
  assert.equal(registry.wasStopped("g1"), false);
  assert.equal(registry.wasAbortedForShutdown("g1"), true);
  const terminal = terminalFor(registry, "g1");
  assert.equal(terminal.finishReason, "error");
  assert.equal(terminal.refunds, true);
});

test("a controller aborted directly (stall watchdog, lost lease) keeps no user cause", () => {
  const registry = createGenerationRegistry({ logger: quiet });
  const e = entry();
  registry.register("g1", e);
  e.controller.abort();
  assert.equal(registry.cancel("g1", "u1"), true);
  assert.equal(registry.wasStopped("g1"), false);
  assert.equal(registry.abortAllForShutdown(), 0);
});

test("ownership: another user's Stop does nothing", () => {
  const registry = createGenerationRegistry({ logger: quiet });
  const e = entry("owner");
  registry.register("g1", e);
  assert.equal(registry.cancel("g1", "intruder"), false);
  assert.equal(e.controller.signal.aborted, false);
  assert.equal(registry.cancel("missing", "owner"), false);
  assert.equal(registry.isHeldFor("g1", "owner"), true);
  assert.equal(registry.isHeldFor("g1", "intruder"), false);
});

test("a stopped generation keeps its cause until its own unregister, whatever else registers", () => {
  const registry = createGenerationRegistry({ logger: quiet });
  const unregister = registry.register("g1", entry());
  registry.cancel("g1", "u1");
  // Other traffic in the same process. The old registry swept aborted
  // entries here and the tearing-down turn lost its `stopped` mark.
  for (let i = 0; i < 5; i += 1) registry.register(`other-${i}`, entry(`u${i}`));
  assert.equal(registry.wasStopped("g1"), true);
  assert.equal(registry.isActive("g1"), true, "still tearing down: still active for the resume route and the drain");
  assert.equal(registry.count(), 6);
  unregister();
  assert.equal(registry.isActive("g1"), false);
  assert.equal(registry.count(), 5);
});

test("a late unregister never removes a later registration of the same id", () => {
  const registry = createGenerationRegistry({ logger: quiet });
  const first = registry.register("g1", entry());
  const second = entry();
  registry.register("g1", second);
  first();
  assert.equal(registry.isActive("g1"), true);
  assert.equal(registry.cancel("g1", "u1"), true);
  assert.equal(second.controller.signal.aborted, true);
});

test("held(): what the pump sees — aborted marked, private turns unleased", () => {
  const registry = createGenerationRegistry({ logger: quiet });
  registry.register("saved", entry());
  registry.register("private", { ...entry(), private: true });
  registry.register("stopped", entry());
  registry.cancel("stopped", "u1");
  const held = Object.fromEntries(registry.held().map((h) => [h.generationId, h]));
  assert.deepEqual(held.saved, { generationId: "saved", userId: "u1", aborted: false, leased: true });
  assert.deepEqual(held.private, { generationId: "private", userId: "u1", aborted: false, leased: false });
  assert.equal(held.stopped.aborted, true);
});

test("an entry whose unregister never ran is dropped after the max age, and its lease released", () => {
  let now = 0;
  const released: string[] = [];
  const registry = createGenerationRegistry({
    now: () => now,
    logger: quiet,
    onUnregister: (ref, leased) => released.push(`${ref.generationId}:${leased}`),
  });
  registry.register("leaked", entry());
  now = GENERATION_REGISTRY_MAX_AGE_MS + 1;
  registry.register("fresh", entry());
  assert.equal(registry.isActive("leaked"), false);
  assert.deepEqual(released, ["leaked:true"]);
});

test("activeForConversation is ownership-checked and picks the newest", () => {
  let now = 0;
  const registry = createGenerationRegistry({ now: () => now, logger: quiet });
  registry.register("older", { ...entry(), conversationId: "c1" });
  now = 10;
  registry.register("newer", { ...entry(), conversationId: "c1" });
  registry.register("theirs", { ...entry("u2"), conversationId: "c1" });
  assert.equal(registry.activeForConversation("c1", "u1"), "newer");
  assert.equal(registry.activeForConversation("c1", "u3"), null);
});
