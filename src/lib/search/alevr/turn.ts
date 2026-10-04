/**
 * One chat turn's Alevr Search tools, bound to the turn (BRIEF §15).
 *
 * The registry specs (`web_search`, `search_news`, `web_fetch`,
 * `find_in_page`) read their per-turn state from the tool context: the
 * provenance ledger, the taint, the web limits, the source registry and the
 * private-text guard. The live chat path runs specs through the unified agent
 * toolset's broker (`openUnifiedAgentToolset` → `executeSpec`), whose context
 * carries none of those, so this binds them: each spec returned here is the
 * registry spec with the turn's state merged into its context, and with every
 * source its outcome names queued for the route to stream.
 *
 * The broker still authorises every call (risk `read`), the dispatcher still
 * validates, times and cancels it, and the same specs serve every provider —
 * which is the point.
 *
 * Free of `server-only`.
 */

import { SourceRegistry } from "@/lib/chat/source-registry";
import { roundBudgetFor } from "@/lib/llm/loop";
import { findInPageSpec } from "@/lib/tools/specs/find-in-page";
import { webFetchSpec } from "@/lib/tools/specs/web-fetch";
import { searchNewsSpec } from "@/lib/tools/specs/search-news";
import { webSearchSpec } from "@/lib/tools/specs/web-search";
import type { ToolContext, ToolOutcome, ToolSpec } from "@/lib/tools/types";
import { createTurnWebLimits, type UserWebCounters } from "@/lib/web/limits";
import { NO_PRIVATE_SPANS } from "@/lib/web/private-spans";
import { createLazyUrlLedger, type LedgerHistoryPort } from "@/lib/web/provenance";
import { TurnTaint } from "@/lib/web/taint";
import { setWebAuditSink, type WebAuditSink } from "@/lib/web/turn-state";
import type { LazyUrlLedger, PrivateSpanSet, TurnWebLimits } from "@/lib/web/types";
import type { ReasoningEffort } from "@/types/chat";
import type { ClientSource } from "@/types/chat";
import type { ChatSourceOrigin } from "@/types/run";
import { ToolFeeAccumulator } from "@/lib/tools/metering";
import type { CanonicalToolId } from "@/types/run";

/** The Alevr Search tool family, in offer order. */
export const ALEVR_SEARCH_TOOL_IDS = ["web_search", "search_news", "web_fetch", "find_in_page"] as const;

export interface AlevrSearchTurnInput {
  userId: string;
  conversationId: string | null;
  private: boolean;
  effort: ReasoningEffort | null | undefined;
  voice: boolean;
  /** The current message and any user text the route already holds, decrypted. */
  userTexts: readonly string[];
  /** URLs of a research report injected this turn. */
  researchSourceUrls?: readonly string[];
  privateSpans?: PrivateSpanSet;
  audit?: WebAuditSink | null;
  /** Seams for tests. */
  specs?: readonly ToolSpec[];
  history?: LedgerHistoryPort;
  userCounters?: UserWebCounters;
  /** Taint already observed before the first tool (attachments, a report…). */
  staticContent?: boolean;
}

export interface AlevrSearchTurn {
  specs: ToolSpec[];
  taint: TurnTaint;
  limits: TurnWebLimits;
  ledger: LazyUrlLedger;
  /** Sources the tools produced since the last drain, with their origin. */
  drainSources(): Array<{ sources: ClientSource[]; origin: ChatSourceOrigin }>;
  /**
   * The paid engine calls this turn made, for `recordToolFees`. Each search
   * outcome carries its fee; nothing used to collect it, so paid discovery
   * was never billed to the person who asked.
   */
  fees: ToolFeeAccumulator;
}

export function createAlevrSearchTurn(input: AlevrSearchTurnInput): AlevrSearchTurn {
  const limits = createTurnWebLimits({
    roundBudget: roundBudgetFor(input.effort, input.voice),
    userId: input.userId,
    ...(input.userCounters ? { userCounters: input.userCounters } : {}),
  });
  if (input.audit && !input.private) setWebAuditSink(limits, input.audit);
  const taint = new TurnTaint({ staticContent: !!input.staticContent });
  const ledger = createLazyUrlLedger({
    userId: input.userId,
    conversationId: input.conversationId,
    private: input.private,
    userTexts: input.userTexts,
    memoryTexts: [],
    attachmentTexts: [],
    toolNoteUrls: [],
    researchSourceUrls: input.researchSourceUrls ?? [],
    ...(input.history ? { history: input.history } : {}),
  });
  // The tools' own numbering. Citations are links on this path (numbered
  // citations need the rework's turn stream), so this registry only has to be
  // consistent within the turn; the route's accumulator persists the sources.
  const registry = new SourceRegistry();
  const pending: Array<{ sources: ClientSource[]; origin: ChatSourceOrigin }> = [];
  const fees = new ToolFeeAccumulator();

  const bind = (spec: ToolSpec): ToolSpec => ({
    ...spec,
    async execute(args, ctx: ToolContext): Promise<ToolOutcome> {
      const outcome = await spec.execute(args, {
        ...ctx,
        private: input.private,
        privateSpans: input.privateSpans ?? NO_PRIVATE_SPANS,
        citationsNumbered: false,
        sources: registry,
        ledger,
        taint,
        limits,
      });
      if (outcome.feeMicroUsd) fees.add(spec.id as CanonicalToolId, outcome.feeMicroUsd);
      if (outcome.status === "succeeded" && outcome.sources?.length) {
        const origin: ChatSourceOrigin = spec.id === "web_search" || spec.id === "search_news" ? "juno_search" : "juno_fetch";
        pending.push({ sources: outcome.sources, origin });
      }
      return outcome;
    },
  });

  const specs = (input.specs ?? [webSearchSpec, searchNewsSpec, webFetchSpec, findInPageSpec]).map(bind);
  return {
    specs,
    taint,
    limits,
    ledger,
    drainSources: () => pending.splice(0),
    fees,
  };
}
