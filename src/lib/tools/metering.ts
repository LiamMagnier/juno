/**
 * Juno's own tool fees (SPEC §3.9).
 *
 * A fee is third-party money Juno spends on the user's behalf — a search
 * engine's per-query price, a sandbox's wall time — as opposed to the model's
 * tokens. Each is written to the ledger as its own `kind: "chat"` row with
 * model `juno-tool:<id>` (DECISIONS §4c), and the budget guard reads the
 * running total so a tool-heavy turn stops before it overspends.
 *
 * WS0 lands the shell with its final signatures; WS1 implements it.
 */

import type { CanonicalToolId } from "@/types/run";

export class ToolFeeAccumulator {
  add(_tool: CanonicalToolId, _microUsd: number): void {
    throw new Error("not implemented: WS1");
  }

  /** Read by the budget guard (SPEC §4.7). */
  total(): number {
    throw new Error("not implemented: WS1");
  }

  rows(): Array<{ tool: CanonicalToolId; microUsd: number; calls: number }> {
    throw new Error("not implemented: WS1");
  }
}

/** Price of one engine call, in micro-USD (list prices 2026-09-23). */
export function enginePriceMicroUsd(_engine: "tavily" | "serper" | "brave" | "exa", _results: number): number {
  throw new Error("not implemented: WS1");
}

/** `run_code` sandbox time: env `RUN_CODE_MICRO_USD_PER_SECOND`, default 46 (E2B 2 vCPU + 4 GiB). */
export const RUN_CODE_MICRO_USD_PER_SECOND: number = (() => {
  const raw = Number(process.env.RUN_CODE_MICRO_USD_PER_SECOND);
  return Number.isFinite(raw) && raw > 0 ? raw : 46;
})();
