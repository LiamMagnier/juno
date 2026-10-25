// Held-out tests for coding-03 (never shown to the executor).
import test from "node:test";
import assert from "node:assert/strict";
import { parseCsvLine } from "./csv.mjs";

test("hidden: plain fields", () => {
  assert.deepEqual(parseCsvLine("I01,North,paid,125.50"), ["I01", "North", "paid", "125.50"]);
});

test("hidden: quoted field with a comma", () => {
  assert.deepEqual(parseCsvLine('I07,"Smith, Jones",paid,10'), ["I07", "Smith, Jones", "paid", "10"]);
});

test("hidden: escaped double quote", () => {
  assert.deepEqual(parseCsvLine('a,"say ""hi""",b'), ["a", 'say "hi"', "b"]);
});

test("hidden: empty fields are kept", () => {
  assert.deepEqual(parseCsvLine("a,,c,"), ["a", "", "c", ""]);
});

test("hidden: an unterminated quote is an error", () => {
  assert.throws(() => parseCsvLine('a,"open'), SyntaxError);
});
