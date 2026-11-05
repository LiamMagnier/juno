// Held-out tests for coding-01 (never shown to the executor).
import test from "node:test";
import assert from "node:assert/strict";
import { paidTotal } from "./ledger.mjs";

test("hidden: only paid rows count", () => {
  assert.equal(paidTotal([
    { id: "a", status: "paid", amount: "10.00" },
    { id: "b", status: "unpaid", amount: "99.00" },
    { id: "c", status: "cancelled", amount: "5.00" },
  ]), 10);
});

test("hidden: a duplicated id counts once", () => {
  assert.equal(paidTotal([
    { id: "a", status: "paid", amount: "200.00" },
    { id: "a", status: "paid", amount: "200.00" },
    { id: "b", status: "paid", amount: "64.50" },
  ]), 264.5);
});

test("hidden: cents are exact", () => {
  assert.equal(paidTotal([
    { id: "a", status: "paid", amount: "0.10" },
    { id: "b", status: "paid", amount: "0.20" },
  ]), 0.3);
});

test("hidden: the Meridian invoices", () => {
  const rows = [
    ["I01", "paid", "125.50"], ["I02", "paid", "200.00"], ["I03", "unpaid", "80.25"],
    ["I04", "cancelled", "45.00"], ["I05", "paid", "64.50"], ["I02", "paid", "200.00"], ["I06", "unpaid", "30.75"],
  ].map(([id, status, amount]) => ({ id, status, amount }));
  assert.equal(paidTotal(rows), 390);
});

test("hidden: empty input is zero", () => {
  assert.equal(paidTotal([]), 0);
});
