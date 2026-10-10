import "server-only";
import { nativeSearchPolicy, planTurnSearch } from "@/lib/search/alevr/policy";
import { chatSearchAvailable } from "@/lib/web/search";
import type { Plan } from "@prisma/client";
import { PLANS } from "@/lib/plans";
import { isWebSearchConfigured } from "@/lib/web-search";
import { resolveFastMode } from "@/lib/pricing";
import { supportsProMode } from "@/lib/model-metrics";
import { workspacePermits, type WorkspaceConfig } from "@/lib/projects/workspace-config";
import type { ModelInfo } from "@/lib/models";
import type { ChatRequestBody } from "@/lib/chat/request";

/*
 * Pipeline stage — resolveCapabilities: what this turn may do, decided from
 * the plan, the model, the deployment and the project assistant — never from
 * the request alone. Deterministic: no model output reaches these flags.
 */
export function resolveCapabilities({
  input,
  plan,
  modelInfo,
  workspaceConfig,
}: {
  input: ChatRequestBody;
  plan: Plan;
  modelInfo: ModelInfo;
  workspaceConfig: WorkspaceConfig;
}) {
  // Deep research: Tavily plan → search → read before synthesis. It replaces
  // native web search for this turn — the researched corpus IS the live web
  // data — so the two are never both active. Voice turns stay conversational.
  const researchRequested = !!input.deepResearch && !input.voiceMode
    && workspacePermits(workspaceConfig, "deepResearch");
  const researchActive = researchRequested && PLANS[plan].webSearch && isWebSearchConfigured();
  // Web search (BRIEF §15): Alevr Search's provider-neutral tools on every
  // tool-capable model when a backend is configured (`useAlevrSearch`); the
  // provider's own search (Gemini grounding, Claude web_search, Grok Live
  // Search…) only as the fallback, or beside it when the operator asks
  // (`ALEVR_SEARCH_PROVIDER_NATIVE`). `src/lib/search/alevr/policy.ts`.
  const webRequested = !researchActive && !!input.webSearch && PLANS[plan].webSearch
    && workspacePermits(workspaceConfig, "webSearch");
  const searchPlan = planTurnSearch({
    webRequested,
    model: modelInfo,
    alevrAvailable: chatSearchAvailable(),
    voice: !!input.voiceMode,
    private: false,
    policy: nativeSearchPolicy(),
  });
  const useWebSearch = searchPlan.native;
  const useAlevrSearch = searchPlan.alevr;
  const useFastMode = resolveFastMode(modelInfo, input);
  const useProMode = !!input.proMode && supportsProMode(modelInfo);

  // Canvas is the model's decision, not the user's: no Juno web client sends
  // `canvasEnabled` any more, and absent means on. What can still switch it off
  // is policy, not preference — a voice turn (artifacts cannot be spoken), the
  // private branch (which hardcodes canvasOn: false earlier in this file
  // because artifacts are persisted rows), an assistant whose allowedTools
  // exclude "canvas", and a legacy native build that explicitly sends false.
  const canvasOn = !input.voiceMode && (input.canvasEnabled ?? true)
    && workspacePermits(workspaceConfig, "canvas");
  return { researchRequested, researchActive, useWebSearch, useAlevrSearch, useFastMode, useProMode, canvasOn };
}

export type TurnCapabilities = ReturnType<typeof resolveCapabilities>;

/**
 * Whether anything Juno did not author is in this turn's context.
 *
 * Read twice downstream: it switches on the untrusted-content rule in the
 * system prompt, and a turn that carried untrusted content must not be
 * allowed to write durable memory.
 */
export function turnCarriesUntrustedContent(signals: {
  connectors: number;
  useWebSearch: boolean;
  /** Alevr Search hands the model pages strangers wrote (INV-34). */
  useAlevrSearch: boolean;
  researchActive: boolean;
  projectKnowledge: boolean;
  attachmentKnowledge: boolean;
  projectReferenceFiles: boolean;
  historyCarriesAttachmentText: boolean;
  untrustedSkill: boolean;
  documentTool: boolean;
  historyHasToolNotes: boolean;
  contextTokensUntrusted: boolean;
  /** The client named a folder on the Mac for this turn. */
  localFolder?: boolean;
}): boolean {
  // Any of these can put text Juno did not author into context: a connector
  // tool result, provider-side web search, a fetched research page, a project
  // file, a retrieved passage, or an attachment's extracted text. (Deep
  // research also carries the rule in its own system append, since that corpus
  // is assembled separately.)
  return (
    signals.connectors > 0 ||
    signals.useWebSearch ||
    signals.useAlevrSearch ||
    signals.researchActive ||
    signals.projectKnowledge ||
    signals.attachmentKnowledge ||
    signals.projectReferenceFiles ||
    signals.historyCarriesAttachmentText ||
    // An imported skill's instructions are a stranger's text inside the
    // envelope. Without the rule that reads the markers they are markers and
    // nothing else, and the turn would stay eligible to write durable memory
    // from text Juno did not author.
    signals.untrustedSkill ||
    // `read_document` writes the same envelope from inside a tool round, so
    // the rule that reads the markers has to be on whenever the tool is — a
    // document whose text never made it onto the attachment row reaches the
    // model only through the tool, and would otherwise arrive marked but
    // ungoverned.
    signals.documentTool ||
    // Notes of earlier tool calls ride the envelope too (history-notes.ts).
    signals.historyHasToolNotes ||
    // A chat excerpt, an artifact or a project's documents the message named.
    signals.contextTokensUntrusted ||
    // The Mac's folder tools read files and command output into the turn,
    // inside the envelope (src/lib/chat/local-folder-tools.ts).
    !!signals.localFolder
  );
}
