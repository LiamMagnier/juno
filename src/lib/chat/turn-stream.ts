/**
 * The one place a turn's `LlmEvent`s become SSE frames and activity rows
 * (SPEC §2.10). Both of the route's paths — saved and private — call it, so
 * the frame grammar a client receives is decided here and gated here by what
 * the client declared (INV-1, INV-27).
 *
 * WS0 lands the signature; WS4 implements the event → frame table.
 */

import type { ClientActionApproval } from "@/lib/action-approval";
import type { SseSender } from "@/lib/chat-stream";
import type { ClientFeatureSet } from "@/lib/chat/client-features";
import type { SourceRegistry } from "@/lib/chat/source-registry";
import type { GenerationAccumulator } from "@/lib/chat/stream-accumulator";
import type { TurnTaint } from "@/lib/web/taint";
import type { LazyUrlLedger } from "@/lib/web/types";
import type { ClientActivityEvent } from "@/types/chat";
import type { LlmEvent } from "@/types/llm";

export interface TurnStreamOptions {
  sender: SseSender;
  features: ClientFeatureSet;
  acc: GenerationAccumulator;
  sources: SourceRegistry;
  /** The turn's provenance ledger; null when no web tool is attached. */
  ledger: LazyUrlLedger | null;
  taint: TurnTaint;
  /** false under lockdown. */
  toolDetailEnabled: boolean;
  /** Calls in `running` or `awaiting_approval`: the route pauses the stall watchdog while > 0 (INV-33). */
  onToolActivityChange(active: number): void;
  /** Sends the approval frame (the route owns it). */
  onApproval(approval: ClientActionApproval): void;
  /** Budget guard enforce + soft finalize. */
  onUsage(ev: Extract<LlmEvent, { type: "usage" }>): void;
  /** A provider search finished (server_tool result); counts against the turn's search cap. */
  onProviderSearch(): void;
  /** Suppresses text frames, as artifact-edit turns do today. */
  artifactEdit: boolean;
}

export class TurnStream {
  constructor(_opts: TurnStreamOptions) {}

  /** Applies one LlmEvent: updates acc, sends frames, returns nothing. Never throws on bad input. */
  apply(_ev: LlmEvent): void {
    throw new Error("not implemented: WS4");
  }

  /** Called once after the provider stream ends (or aborts): closes open calls as cancelled,
   *  emits the final commentary split and returns what persists. */
  finish(_reason: "completed" | "aborted"): { answer: string; activity: ClientActivityEvent[] } {
    throw new Error("not implemented: WS4");
  }
}
