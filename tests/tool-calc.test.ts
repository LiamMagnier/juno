import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { CALC_MAX_DEPTH, CALC_MAX_INPUT_CHARS, CALC_MAX_LITERAL_CHARS, calculate, type CalcResult } from "@/lib/tools/calc";
import { calculateSpec } from "@/lib/tools/specs/calculate";
import type { ToolContext } from "@/lib/tools/types";

/*
 * `calculate` (SPEC §3.8.8): a recursive-descent evaluator over a fixed
 * grammar, with no `eval` and no `Function`, bounded in length, depth and
 * literal size, results rounded to 12 significant digits, and a fixed unit
 * table. Every failure names what caused it.
 */

function value(expression: string): number {
  const result = calculate(expression);
  assert.ok(result.ok, `${expression}: ${JSON.stringify(result)}`);
  return result.value;
}

function error(expression: string): Extract<CalcResult, { ok: false }>["error"] {
  const result = calculate(expression);
  assert.ok(!result.ok, `${expression} should fail`);
  return result.error;
}

test("no eval, no Function, no dynamic code anywhere in the evaluator", () => {
  const source = readFileSync(path.join(process.cwd(), "src/lib/tools/calc.ts"), "utf8");
  assert.doesNotMatch(source, /\beval\s*\(/);
  assert.doesNotMatch(source, /\bnew Function\b|\bFunction\s*\(/);
  assert.doesNotMatch(source, /^import /m, "self-contained: nothing to reach through");
  for (const probe of ["constructor", "process.exit(1)", "__proto__", "this", "globalThis", "a=1", "`1`", "[1]"]) {
    assert.equal(calculate(probe).ok, false, probe);
  }
});

test("the grammar: numbers, operators, parentheses, functions and constants", () => {
  assert.equal(value("1e3"), 1000);
  assert.equal(value("1.5e-3"), 0.0015);
  assert.equal(value("10/4"), 2.5);
  assert.equal(value("10 % 3"), 1);
  assert.equal(value("50%"), 0.5);
  assert.equal(value("sqrt(16) + abs(-3)"), 7);
  assert.equal(value("round(2.5)"), 3);
  assert.equal(value("floor(-2.5)"), -3);
  assert.equal(value("ceil(2.1)"), 3);
  assert.equal(value("min(4, 2)"), 2);
  assert.equal(value("max(1, 2, 3)"), 3);
  assert.equal(value("log(100)"), 2);
  assert.equal(value("ln(e)"), 1);
  assert.equal(value("exp(0)"), 1);
  assert.equal(value("sin(0) + cos(0) + tan(0)"), 1);
  assert.equal(value("pi"), 3.14159265359, "rounded to 12 significant digits");
});

test("precedence and associativity", () => {
  assert.equal(value("2 + 3 * 4"), 14);
  assert.equal(value("(2 + 3) * 4"), 20);
  assert.equal(value("2 ^ 3 ^ 2"), 512, "power is right-associative");
  assert.equal(value("-2 ^ 2"), -4, "unary minus binds looser than power");
  assert.equal(value("2 ^ -1"), 0.5);
  assert.equal(value("(((1)))"), 1);
});

test("the result reads as the spec's example, with the normalised expression", async () => {
  const result = calculate("(1+0.05)^10 * 2000");
  assert.ok(result.ok);
  assert.equal(result.expression, "(1+0.05)^10*2000");
  assert.equal(result.formatted, "3257.78925355");
  const outcome = await calculateSpec.execute({ expression: "(1+0.05)^10 * 2000" }, {} as ToolContext);
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.text, "= 3257.78925355 (expression: (1+0.05)^10*2000)");
  assert.deepEqual(outcome.figure, { kind: "value", value: "3257.78925355" });
});

test("unit conversion over a fixed table", () => {
  assert.equal(value("100 C to F"), 212);
  assert.equal(value("72 F to C"), 22.2222222222);
  assert.equal(value("5 km to mi"), 3.10685596119);
  assert.equal(value("1 h to s"), 3600);
  assert.equal(value("1 GB to MB"), 1000);
  assert.equal(value("60 mph to km/h"), 96.56064);
  const converted = calculate("5 km to mi");
  assert.ok(converted.ok && converted.unit === "mi");
  assert.deepEqual(error("5 km to kg"), { kind: "incompatible_units", from: "km", to: "kg" });
  assert.deepEqual(error("5 km to parsecs"), { kind: "unknown_unit", token: "parsecs" });
});

test("errors say which token caused them", () => {
  assert.deepEqual(error("1/0"), { kind: "division_by_zero", token: "/" });
  assert.deepEqual(error("foo(2)"), { kind: "unknown_name", token: "foo" });
  assert.deepEqual(error("sqrt(1, 2)"), { kind: "bad_arguments", token: "sqrt" });
  assert.deepEqual(error("sqrt(-1)"), { kind: "bad_arguments", token: "sqrt" });
  assert.deepEqual(error(")("), { kind: "unexpected", token: ")" });
  assert.deepEqual(error("2 3"), { kind: "unexpected", token: "3" });
  assert.deepEqual(error(""), { kind: "empty" });
  assert.deepEqual(error("   "), { kind: "empty" });
});

test("the limits: 500 characters, 64 levels, 64-character literals, and finite results", async () => {
  assert.equal(CALC_MAX_INPUT_CHARS, 500);
  assert.equal(CALC_MAX_DEPTH, 64);
  assert.equal(CALC_MAX_LITERAL_CHARS, 64);
  assert.deepEqual(error("1+".repeat(250) + "1"), { kind: "too_long" });
  assert.deepEqual(error(`${"(".repeat(65)}1${")".repeat(65)}`), { kind: "too_deep" });
  assert.equal(value(`${"(".repeat(60)}1${")".repeat(60)}`), 1);
  assert.equal(error("1".repeat(65)).kind, "literal_too_long");
  assert.equal(error("a".repeat(65)).kind, "literal_too_long");
  assert.equal(value("1".repeat(64).slice(0, 15)), 111111111111000, "12 significant digits");
  assert.deepEqual(error("1e308 * 10"), { kind: "not_finite" });
  assert.deepEqual(error("1e309"), { kind: "not_finite" });

  // The spec turns each into an instructive failure the model can act on.
  const outcome = await calculateSpec.execute({ expression: "1/0" }, {} as ToolContext);
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.error?.code, "invalid_args");
  assert.equal(outcome.text, 'Division by zero at "/". Nothing was calculated. Fix the expression and call calculate again.');
});
