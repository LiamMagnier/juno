// Held-out tests for coding-02 (never shown to the executor).
import test from "node:test";
import assert from "node:assert/strict";
import { paginate } from "./ledger.mjs";

test("hidden: exact multiple has no empty trailing page", () => {
  assert.deepEqual(paginate([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
});

test("hidden: empty input gives no pages", () => {
  assert.deepEqual(paginate([], 3), []);
});

test("hidden: remainder page kept", () => {
  assert.deepEqual(paginate([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test("hidden: zero, negative and non-integer sizes are rejected promptly", () => {
  for (const size of [0, -1, 1.5, Number.NaN]) {
    assert.throws(() => paginate([1, 2], size), RangeError, `size ${size}`);
  }
});
