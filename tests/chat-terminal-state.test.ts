import test from "node:test";
import assert from "node:assert/strict";
import {
  INTERNAL_ERROR_FAILURE_CODE,
  LEASE_EXPIRED_FAILURE_CODE,
  PERSISTENCE_FAILED_FAILURE_CODE,
  resolveTerminalState,
  terminalFailureCode,
  terminalFinishReason,
  type PartialOutput,
  type TerminalSignals,
} from "@/lib/chat/terminal-state";

/*
 * Characterisation tests for the one terminal-state model.
 *
 * A chat turn could end in five places in the route, each recomputing the
 * finish reason, the receipt's failure code and the refund decision from
 * scratch. These pin the combined rules so the five sites can share one.
 */

const signals = (overrides: Partial<TerminalSignals> = {}): TerminalSignals => ({
  stalled: false,
  budgetHalted: false,
  userStopped: false,
  leaseLost: false,
  error: new Error("boom"),
  ...overrides,
});

const output = (overrides: Partial<PartialOutput> = {}): PartialOutput => ({
  hasText: false,
  hasReasoning: false,
  artifactEdit: false,
  ...overrides,
});

test("a stall is classified before any stop, so a wedged provider is not recorded as a user Stop", () => {
  // The watchdog aborts the controller, which makes the SDK throw its own
  // user-abort error. Checking `stalled` first is the only thing separating
  // "the model went silent" from "the user pressed Stop".
  const state = resolveTerminalState(
    signals({ stalled: true, error: new Error("Request was aborted") }),
    output({ hasText: true })
  );
  assert.equal(state.finishReason, "error");
  assert.equal(state.persistsPartial, false);
  assert.equal(state.refunds, true);
});

test("a budget halt is a stop, not a failure", () => {
  // The user was told, the partial answer is kept, and they are billed for
  // what was produced — exactly like pressing Stop.
  const state = resolveTerminalState(signals({ budgetHalted: true }), output({ hasText: true }));
  assert.equal(state.finishReason, "user_stopped");
  assert.equal(state.persistsPartial, true);
  assert.equal(state.refunds, false);
});

test("an explicit user stop with output keeps both the answer and the charge", () => {
  const state = resolveTerminalState(signals({ userStopped: true }), output({ hasText: true }));
  assert.equal(state.finishReason, "user_stopped");
  assert.equal(state.persistsPartial, true);
  assert.equal(state.refunds, false);
});

test("an explicit user stop with nothing produced still keeps the charge", () => {
  // Nothing to save, but the request was made and the work was started. The
  // refund exists for failures, not for changing your mind.
  const state = resolveTerminalState(signals({ userStopped: true }), output());
  assert.equal(state.persistsPartial, false);
  assert.equal(state.refunds, false);
  assert.equal(state.failureCode, "GENERATION_STOPPED_BEFORE_OUTPUT");
});

test("a dropped connection saves what arrived", () => {
  const state = resolveTerminalState(
    signals({ error: new Error("fetch failed: ECONNRESET") }),
    output({ hasText: true })
  );
  assert.equal(state.finishReason, "network_error");
  assert.equal(state.persistsPartial, true);
  assert.equal(state.refunds, false);
});

test("a dropped connection with nothing to show is refunded", () => {
  const state = resolveTerminalState(signals({ error: new Error("ETIMEDOUT") }), output());
  assert.equal(state.persistsPartial, false);
  assert.equal(state.refunds, true);
});

test("reasoning alone is enough to save a partial", () => {
  const state = resolveTerminalState(signals({ userStopped: true }), output({ hasReasoning: true }));
  assert.equal(state.persistsPartial, true);
});

test("a canvas edit never persists a partial, however it ended", () => {
  // Its output is a patch protocol. Half a patch applied to the user's
  // artifact is worse than no answer at all.
  const stopped = resolveTerminalState(
    signals({ userStopped: true }),
    output({ hasText: true, artifactEdit: true })
  );
  const dropped = resolveTerminalState(
    signals({ error: new Error("socket hang up") }),
    output({ hasText: true, artifactEdit: true })
  );
  assert.equal(stopped.persistsPartial, false);
  assert.equal(dropped.persistsPartial, false);
  // Still not refunded when the user stopped it themselves.
  assert.equal(stopped.refunds, false);
  assert.equal(dropped.refunds, true);
});

test("a plain provider failure is refunded and never saved", () => {
  const state = resolveTerminalState(signals(), output({ hasText: true }));
  assert.equal(state.finishReason, "error");
  assert.equal(state.persistsPartial, false);
  assert.equal(state.refunds, true);
  assert.equal(state.failureCode, "GENERATION_FAILED");
});

test("a context-window overflow is classified from the provider's message", () => {
  const state = resolveTerminalState(
    signals({ error: new Error("maximum context length exceeded") }),
    output()
  );
  assert.equal(state.finishReason, "model_context_window_exceeded");
  assert.equal(state.failureCode, "GENERATION_CONTEXT_LIMIT");
});

test("a lost lease outranks every other explanation", () => {
  // The row this process meant to write is already owned by someone else, so
  // whatever else went wrong is not the thing worth recording.
  const state = resolveTerminalState(signals({ leaseLost: true }), output());
  assert.equal(state.failureCode, LEASE_EXPIRED_FAILURE_CODE);
  assert.equal(terminalFailureCode(true, PERSISTENCE_FAILED_FAILURE_CODE), LEASE_EXPIRED_FAILURE_CODE);
  assert.equal(terminalFailureCode(true, INTERNAL_ERROR_FAILURE_CODE), LEASE_EXPIRED_FAILURE_CODE);
});

test("without a lost lease the caller's own fallback code is used", () => {
  assert.equal(
    terminalFailureCode(false, PERSISTENCE_FAILED_FAILURE_CODE),
    PERSISTENCE_FAILED_FAILURE_CODE
  );
});

test("classification alone is available without the rest of the decision", () => {
  assert.equal(terminalFinishReason(signals({ stalled: true })), "error");
  assert.equal(terminalFinishReason(signals({ budgetHalted: true })), "user_stopped");
  assert.equal(terminalFinishReason(signals({ error: new Error("nope") })), "error");
});

test("a saved partial is never also refunded", () => {
  // The two are exclusive by construction: keeping the answer and giving the
  // message back would let a stopped turn be free and permanent.
  for (const s of [signals({ userStopped: true }), signals({ error: new Error("ECONNRESET") })]) {
    const state = resolveTerminalState(s, output({ hasText: true }));
    assert.equal(state.persistsPartial && state.refunds, false);
  }
});
