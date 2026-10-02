/**
 * The typed facts a turn starts with (SPEC §2.12), in order: model, effort,
 * context, connectors (with one `connector_unavailable` warning per failed
 * connector), tools (`timeline` only), then the context notices. Each row also
 * carries its legacy `kind`/`title`/`detail` (INV-7).
 *
 * Pure, so "Connected tools ready lists only ready connectors" (RC-3) is
 * tested without the route. WS0 lands the signature; WS4 implements it.
 */

import type { ClientFeatureSet } from "@/lib/chat/client-features";
import type { ClientActivityEvent } from "@/types/chat";
import type { RunFact, RunNotice } from "@/types/run";

export interface TurnStartFactsInput {
  features: ClientFeatureSet;
  model: Extract<RunFact, { key: "model" }>;
  effort: Extract<RunFact, { key: "effort" }> | null;
  context: Extract<RunFact, { key: "context" }>;
  /** Null when the turn asked for no connector. */
  connectors: Extract<RunFact, { key: "connectors" }> | null;
  tools: Extract<RunFact, { key: "tools" }>;
  /** `web_off_lockdown`, `private_tools_limited`, `tools_capped` when they apply. */
  notices: readonly RunNotice[];
}

export function turnStartFacts(_input: TurnStartFactsInput): ClientActivityEvent[] {
  throw new Error("not implemented: WS4");
}
