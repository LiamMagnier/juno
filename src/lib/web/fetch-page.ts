/**
 * `web_fetch`'s backend: one page or PDF as clean text, behind the provenance
 * check, the SSRF guard on every redirect hop and the turn's limits (SPEC §6.1).
 *
 * WS0 lands the signature; WS2 implements the pipeline.
 */

import type { ToolOutcome } from "@/lib/tools/types";
import type { TurnTaint } from "@/lib/web/taint";
import type { LazyUrlLedger, TurnWebLimits } from "@/lib/web/types";

export interface FetchPageInput {
  url: string;
  offset?: number;
  maxChars?: number;
}

export async function fetchPageForChat(
  _input: FetchPageInput,
  _ctx: {
    ledger: LazyUrlLedger;
    taint: TurnTaint;
    limits: TurnWebLimits;
    signal: AbortSignal;
    private: boolean;
  },
): Promise<ToolOutcome> {
  throw new Error("not implemented: WS2");
}
