/**
 * `calculate` (SPEC §3.8.8): exact arithmetic and unit conversion, evaluated by
 * `tools/calc.ts` with no code execution.
 *
 * Models are fluent and wrong at arithmetic in the same breath: compound
 * growth, percentages of percentages and unit conversions come out plausible
 * and off by a digit. A calculator the model reaches for is cheaper than the
 * sandbox and needs no network, so it is attached everywhere tools are,
 * private chats and lockdown included.
 */

import { calculate } from "@/lib/tools/calc";
import { calcErrorText, resultText } from "@/lib/tools/specs/calculate.prompt";
import { failed, oneLine, succeeded } from "@/lib/tools/specs/shared";
import { defineTool } from "@/lib/tools/types";

export interface CalculateArgs extends Record<string, unknown> {
  expression?: unknown;
}

export const calculateSpec = defineTool<CalculateArgs>({
  id: "calculate",
  title: "Calculate",
  description:
    "Evaluates an arithmetic expression exactly and returns the result, with no code execution. Use it for any calculation whose result matters — sums, percentages, compound growth, unit conversions — instead of computing in your head. Do not use it for data in files (use run_code when available). Supported: numbers, + - * / ^ %, parentheses, sqrt, abs, round, floor, ceil, min, max, log, ln, exp, sin, cos, tan, pi, e, and unit conversion written as \"5 km to mi\". It returns the result and the normalised expression.",
  input: {
    type: "object",
    properties: {
      expression: {
        type: "string",
        description: "The expression, e.g. (1+0.05)^10 * 2000 or 72 F to C. Required.",
      },
    },
    required: ["expression"],
  },
  risk: "read",
  parallelSafe: true,
  timeoutMs: 1_000,
  icon: "calculator",
  broker: "none",
  dedupe: true,
  present(args) {
    return { expression: oneLine(args.expression, 120) };
  },
  async execute(args) {
    const result = calculate(typeof args.expression === "string" ? args.expression : "");
    if (!result.ok) return failed("invalid_args", calcErrorText(result.error));
    return succeeded(resultText(result.formatted, result.expression, result.unit), {
      figure: { kind: "value", value: result.unit ? `${result.formatted} ${result.unit}` : result.formatted },
    });
  },
});
