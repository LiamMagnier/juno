/**
 * Chat's `web_search` backend: one primary keyed engine (the first configured
 * of Tavily, Serper, Brave, Exa) and one fallback only when it fails. No
 * keyless engines in chat (DECISIONS §4c, SPEC §6.3).
 *
 * WS0 lands the signatures; WS2 implements them. The engine calls themselves
 * are injected, so this file stays free of `server-only`.
 */

import type { ChatSearchResult, EngineReport, PrivateSpanSet, TurnWebLimits } from "@/lib/web/types";

export async function chatWebSearch(
  _input: { query: string; count?: number; recency?: string },
  _ctx: { signal: AbortSignal; private: boolean; privateSpans: PrivateSpanSet; limits: TurnWebLimits },
): Promise<{
  results: ChatSearchResult[];
  engine: string | null;
  engines: EngineReport[];
  feeMicroUsd: number;
  degraded: boolean;
}> {
  throw new Error("not implemented: WS2");
}

/** True when any of Tavily, Serper, Brave or Exa has a key. `/api/app` and the entitlements read it. */
export function keyedSearchEngineConfigured(): boolean {
  throw new Error("not implemented: WS2");
}
