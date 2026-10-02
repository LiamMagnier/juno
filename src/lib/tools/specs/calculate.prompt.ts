/*
 * What `calculate` tells the model (SPEC §3.8.8). English, in a `*.prompt.ts`
 * file so the i18n extractor never harvests it (INV-29). Every failure names
 * the token that caused it, so the next call can fix exactly that.
 */

import type { CalcError } from "@/lib/tools/calc";

export function resultText(formatted: string, expression: string, unit?: string): string {
  return `= ${formatted}${unit ? ` ${unit}` : ""} (expression: ${expression})`;
}

export function calcErrorText(error: CalcError): string {
  const reason = (() => {
    switch (error.kind) {
      case "too_long": return "The expression is longer than 500 characters.";
      case "empty": return "The expression is empty.";
      case "too_deep": return "The expression is nested more than 64 levels deep.";
      case "literal_too_long": return `The number or name "${error.token}" is longer than 64 characters.`;
      case "unexpected": return `Unexpected "${error.token}".`;
      case "expected": return `Expected ${error.token === ")" || error.token === "," ? `"${error.token}"` : error.token} here.`;
      case "unknown_name": return `"${error.token}" is not a supported name. Supported: sqrt, abs, round, floor, ceil, min, max, log, ln, exp, sin, cos, tan, pi, e.`;
      case "bad_arguments": return `"${error.token}" was given arguments it cannot take.`;
      case "division_by_zero": return `Division by zero at "${error.token}".`;
      case "not_finite": return "The result is not a finite number (it overflowed or is undefined).";
      case "unknown_unit": return `"${error.token}" is not a supported unit.`;
      case "incompatible_units": return `${error.from} cannot be converted to ${error.to}: they measure different things.`;
    }
  })();
  return `${reason} Nothing was calculated. Fix the expression and call calculate again.`;
}
