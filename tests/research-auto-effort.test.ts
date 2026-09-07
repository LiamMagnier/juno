import test from "node:test";
import assert from "node:assert/strict";
import { researchEffortFor } from "@/lib/research/auto-effort";

/*
 * The depth a research run gets is derived from the model and thinking effort
 * a person already chose. These pin the corners the product promises: a
 * frontier model at max thinking is the deepest run, a small model with
 * thinking off is a quick pass, and the middle is a real gradient rather than
 * two states.
 */

test("a frontier model at max thinking runs at the max tier", () => {
  assert.equal(researchEffortFor({ cost: 3, reasoningEffort: "max" }), "max");
  assert.equal(researchEffortFor({ cost: 3, reasoningEffort: "xhigh" }), "max");
  assert.equal(researchEffortFor({ cost: 3, reasoningEffort: "high", proMode: true }), "max");
});

test("a mid model at high thinking is deep; at medium it is standard", () => {
  assert.equal(researchEffortFor({ cost: 2, reasoningEffort: "high" }), "deep");
  assert.equal(researchEffortFor({ cost: 2, reasoningEffort: "medium" }), "standard");
  assert.equal(researchEffortFor({ cost: 3, reasoningEffort: "low" }), "standard");
});

test("a small model with thinking off is a quick pass", () => {
  assert.equal(researchEffortFor({ cost: 1, reasoningEffort: "low" }), "quick");
  assert.equal(researchEffortFor({ cost: 1, reasoningEffort: "minimal" }), "quick");
});

test("no effort control and auto mode land in the middle, never the floor", () => {
  assert.equal(researchEffortFor({ cost: 2, reasoningEffort: null }), "standard");
  assert.equal(researchEffortFor({ cost: null, reasoningEffort: "high" }), "deep");
  assert.equal(researchEffortFor({}), "standard");
});
