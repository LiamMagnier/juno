/**
 * The client run model: one message's activity, reasoning and sources turned
 * into the ordered view the run block and the Activity panel render (SPEC §7.2).
 *
 * Typed messages (any event carries `seq`) are read from their records; older
 * messages go through the legacy adapter (INV-20). WS0 lands the signature;
 * WS5 implements it.
 */

import type { ClientMessage } from "@/types/chat";
import type { RunView } from "@/lib/run/types";

export type { RunItem, RunView } from "@/lib/run/types";

export function buildRunView(
  _message: Pick<ClientMessage, "activity" | "reasoning" | "reasoningParts" | "sources" | "content">,
  _now?: number,
): RunView {
  throw new Error("not implemented: WS5");
}
