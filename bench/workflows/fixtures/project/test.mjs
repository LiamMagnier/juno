import test from "node:test";
import assert from "node:assert/strict";
import { paidTotal, paginate } from "./ledger.mjs";

test("paidTotal sums paid invoices", () => {
  assert.equal(paidTotal([{ id: "a", status: "paid", amount: "10.00" }]), 10);
});

test("paginate splits rows", () => {
  assert.deepEqual(paginate([1, 2, 3], 2), [[1, 2], [3]]);
});
