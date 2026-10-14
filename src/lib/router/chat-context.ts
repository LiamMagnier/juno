import {
  historyWindowStart, buildProjectContext, buildProjectReferenceFiles, type ProjectContextSource,
} from "@/lib/chat/context-assembly";
import {
  HISTORY_MIN_VERBATIM, HISTORY_TOKEN_TARGET, IMAGE_TOKEN_ESTIMATE, SUMMARY_MAX_CHARS,
  estimateMessageTokens, planTokenTrim, type WindowMessage,
} from "@/lib/chat/history-compaction";
import { attachmentTextBudget } from "@/lib/knowledge/document-text";
import { estimateTokens } from "./task-class";
import { DEFAULT_PACK } from "@/lib/knowledge/rank";

type RoutingAttachment = NonNullable<WindowMessage["attachments"]>[number] & {
  id?: string;
  size?: number;
  mimeType?: string | null;
};
type RoutingMessage = Omit<WindowMessage, "attachments"> & { attachments?: readonly RoutingAttachment[] };

function attachmentTokens(attachment: RoutingAttachment, charCap: number): number {
  if (attachment.kind === "IMAGE") return IMAGE_TOKEN_ESTIMATE;
  if (attachment.extractedText) return estimateTokens(attachment.extractedText.slice(0, charCap));
  // New uploads are parsed after selection. Reserve from bytes rather than
  // treating a not-yet-extracted document as an empty prompt. Compressed or
  // binary documents use an approximate expansion factor.
  const expansion = attachment.mimeType?.startsWith("text/") ? 1 : 4;
  return Math.ceil(Math.min(charCap, Math.max(0, attachment.size ?? 0) * expansion) / 4);
}

/** A bounded snapshot of the context Auto can know before selecting a provider. */
export interface AutoChatContext {
  /** Recent saved messages, oldest first, already decrypted and owner-scoped. */
  history?: readonly RoutingMessage[];
  totalMessages?: number;
  attachments?: readonly RoutingAttachment[];
  project?: ProjectContextSource | null;
  indexedProjectFileNames?: readonly string[];
  instructions?: string | null;
  /** Use the same deployment switch as the eventual history assembly. */
  compactionEnabled?: boolean;
  connectorCount?: number;
}

export interface AutoChatContextInput {
  message?: string | null;
  privateMode?: boolean;
  regenerate?: boolean;
  replacementUserContent?: string;
  preserveLastAssistant?: boolean;
}

/**
 * Estimate the window the turn will actually send, rather than the whole
 * transcript or only the newest question. No summarization or paid retrieval
 * runs here. The largest history budget is conservative across candidates;
 * protected recent turns remain in the estimate even when they exceed it.
 */
export function autoContextTokens(
  input: AutoChatContextInput,
  privateHistory: ReadonlyArray<{ content: string }>,
  context: AutoChatContext = {}
): number {
  return estimateAutoContext(input, privateHistory, context).contextTokens;
}

export function estimateAutoContext(
  input: AutoChatContextInput,
  privateHistory: ReadonlyArray<{ content: string }>,
  context: AutoChatContext = {}
): { contextTokens: number; hasImages: boolean } {
  let tokens = estimateTokens(context.instructions ?? "");
  if (input.privateMode) {
    // This history already includes the newest user turn and clarification.
    // Private mode never reads a saved conversation, files or a project.
    return {
      contextTokens: tokens + privateHistory.reduce((sum, message) => sum + estimateTokens(message.content), 0),
      hasImages: false,
    };
  }

  const messages = [...(context.history ?? [])];
  const total = context.totalMessages ?? messages.length;
  const appending = !input.regenerate && (!!input.message?.trim() || !!context.attachments?.length);
  const start = historyWindowStart(total + (appending ? 1 : 0));
  // The store loads the last HISTORY_LIMIT + HISTORY_STEP - 1 messages.
  // Account for the count window advancing when this user turn is saved.
  const window = messages.slice(Math.max(0, start - Math.max(0, total - messages.length)));
  if (appending) {
    window.push({ id: "pending-user-turn", role: "USER", content: input.message ?? "", attachments: context.attachments });
  } else if (input.regenerate) {
    let lastUser = window.length - 1;
    while (lastUser >= 0 && window[lastUser].role !== "USER") lastUser -= 1;
    if (lastUser >= 0) {
      window[lastUser] = {
        ...window[lastUser],
        content: input.replacementUserContent ?? window[lastUser].content,
        attachments: [...(window[lastUser].attachments ?? []), ...(context.attachments ?? [])],
      };
    }
  }
  // The old assistant remains stored until replacement succeeds, but is not
  // sent. Removing it before this conservative estimate can only retain more
  // of the earlier history than the final compaction does.
  if (input.regenerate && !input.preserveLastAssistant && window.at(-1)?.role === "ASSISTANT") window.pop();
  const compaction = context.compactionEnabled !== false;
  // A large window reaches the shared helper's maximum document budget.
  const attachmentCharCap = attachmentTextBudget(1_000_000);
  const drop = compaction ? planTokenTrim(window, { budgetTokens: HISTORY_TOKEN_TARGET, attachmentCharCap }) : 0;
  const messageTokens = window.map((message) => {
    let total = estimateTokens(message.content);
    for (const attachment of message.attachments ?? []) {
      total += attachmentTokens(attachment, attachmentCharCap);
    }
    return total;
  });
  const fullTokens = messageTokens.reduce((sum, count) => sum + count, 0);
  const retainedTokens = messageTokens.slice(drop).reduce((sum, count) => sum + count, 0);
  // Smaller candidates use smaller attachment caps and may retain additional
  // older turns. Reserve their possible history budget too. CJK-aware token
  // estimates can exceed the compactor's chars/4 estimate, so keep that ratio.
  const ratio = Math.max(1, ...window.map((message, index) =>
    messageTokens[index] / Math.max(1, estimateMessageTokens(message, attachmentCharCap))
  ));
  tokens += compaction
    ? Math.max(retainedTokens, Math.min(fullTokens, Math.ceil(HISTORY_TOKEN_TARGET * ratio)))
    : fullTokens;
  // Reserve the summary ceiling, including when this turn moves its boundary.
  if (compaction && (start + drop > 0 || window.length > HISTORY_MIN_VERBATIM)) tokens += Math.ceil(SUMMARY_MAX_CHARS / 4);
  tokens += estimateTokens(buildProjectContext(context.project ?? null));
  const indexedFileNames = context.indexedProjectFileNames ?? [];
  tokens += estimateTokens(buildProjectReferenceFiles(context.project ?? null, { indexedFileNames, passages: [] }));
  // Successful retrieval replaces indexed files with a bounded packed set;
  // corpus size must not become a hard context-window requirement. Reserve
  // CJK tokens and citation framing too. The downstream no-match/error
  // wholesale fallback remains an estimate limit, not a guaranteed fit.
  if (indexedFileNames.length > 0) {
    tokens += Math.ceil(DEFAULT_PACK.tokenBudget * 8 / 3) + 1_024;
  }
  // The task classifier reserves the base system/tools. Connector schemas
  // aren't loaded until after selection; include a separate bounded estimate.
  tokens += Math.max(0, context.connectorCount ?? 0) * 1_200;
  return {
    contextTokens: tokens,
    // Token trimming depends on the candidate's document cap. An image can
    // survive on a smaller-window candidate even if our largest-cap estimate
    // dropped its row, so vision is required across the entire count window.
    hasImages: window.some((message) => message.attachments?.some((attachment) => attachment.kind === "IMAGE")),
  };
}
