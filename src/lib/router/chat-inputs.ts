import "server-only";

/**
 * The chat route's side of the router: the facts about a request and an
 * account that the pure decision in `decide.ts` takes as inputs.
 */

import type { Plan } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptMessageText } from "@/lib/message-crypto";
import { HISTORY_LIMIT, HISTORY_STEP } from "@/lib/chat/context-assembly";
import { historyCompactionEnabled } from "@/lib/chat/history-summary-store";
import { loadProjectLineage } from "@/lib/projects/project-tree-server";
import { workspacePermits, type WorkspaceConfig } from "@/lib/projects/workspace-config";
import type { ChatRequestBody } from "@/lib/chat/request";
import { formatClarificationModelMessage } from "@/lib/clarification-wizard";
import { formatPreflightClarificationModelMessage } from "@/lib/preflight-clarification";
import { RETRIEVABLE_STATES } from "@/lib/knowledge/lexical-query";
import { classifyPromptComplexity } from "@/lib/auto-model";
import type { EffectiveBudget } from "@/lib/spend-ceiling";
import { checkBudget, checkUsageWindows, type BillingPeriod } from "@/lib/spend";
import { parsePaidTierAttestation } from "@/lib/router/data-policy";
import { classifyTask, type TaskClass } from "@/lib/router/task-class";
import { autoContextTokens, estimateAutoContext } from "./chat-context";

export { autoContextTokens } from "./chat-context";

/**
 * Providers whose deployment keys the owner attests are on a paid,
 * no-training tier (`AUTO_ROUTER_PAID_TIER_PROVIDERS=google,mistral`).
 */
export function autoPaidTierProviders(): ReadonlySet<string> {
  return parsePaidTierAttestation(process.env.AUTO_ROUTER_PAID_TIER_PROVIDERS);
}

/**
 * Room left for this turn: the smaller of the monthly remainder and the
 * binding usage window, after open holds. Null when neither bounds it, or
 * when the read fails — a failed budget read must not make Auto refuse; the
 * admission gates downstream still run.
 */
export async function autoBudgetRoom(
  userId: string,
  plan: Plan,
  period: BillingPeriod | null,
  budget: EffectiveBudget
): Promise<number | null> {
  try {
    const [month, windows] = await Promise.all([
      checkBudget(userId, plan, period, budget),
      checkUsageWindows(userId, plan, period, budget),
    ]);
    const rooms = [month.remainingMicroUsd, windows.remainingMicroUsd].filter((n): n is number => n != null);
    return rooms.length ? Math.max(0, Math.min(...rooms)) : null;
  } catch {
    return null;
  }
}

/**
 * Read-only routing context, before any generation or admission write. Every
 * saved row is scoped to the authenticated owner. Reads are bounded to the
 * count window; no transcript-wide scan, embedding call or summary generation.
 */
export async function autoRoutingContext({
  userId, input, privateHistory, workspaceConfig,
  selectedKnowledgeFileIds, instructions, preserveLastAssistant,
}: {
  userId: string;
  input: ChatRequestBody;
  privateHistory: ReadonlyArray<{ content: string }>;
  workspaceConfig: WorkspaceConfig;
  selectedKnowledgeFileIds?: string[];
  instructions?: string | null;
  preserveLastAssistant?: boolean;
}): Promise<{ contextTokens: number; hasImages: boolean }> {
  if (input.privateMode) {
    return { contextTokens: autoContextTokens(input, privateHistory, { instructions }), hasImages: false };
  }
  const conversation = input.conversationId
    ? await prisma.conversation.findFirst({
        where: { id: input.conversationId, userId },
        select: { id: true, projectId: true, activeConnectors: true, _count: { select: { messages: true } } },
      })
    : null;
  const attachmentIds = [...new Set([
    ...(input.attachmentIds ?? []),
    ...(input.context ?? []).filter((token) => token.kind === "file").map((token) => token.id),
  ])];
  const [history, attachments, lineage] = await Promise.all([
    conversation ? prisma.message.findMany({
      where: { conversationId: conversation.id, conversation: { userId } },
      orderBy: { createdAt: "desc" },
      take: HISTORY_LIMIT + HISTORY_STEP - 1,
      select: {
        id: true, role: true, content: true,
        attachments: {
          where: { userId, deletedAt: null },
          select: { id: true, kind: true, extractedText: true, size: true, mimeType: true },
        },
      },
    }) : Promise.resolve([]),
    attachmentIds.length ? prisma.attachment.findMany({
      where: { id: { in: attachmentIds }, userId, deletedAt: null },
      select: { id: true, kind: true, extractedText: true, size: true, mimeType: true },
    }) : Promise.resolve([]),
    (conversation?.projectId ?? (!input.conversationId ? input.projectId : null))
      ? loadProjectLineage(userId, (conversation?.projectId ?? input.projectId)!) : Promise.resolve(null),
  ]);
  const latestUser = history.find((message) => message.role === "USER");
  const usedIds = new Set(input.regenerate ? latestUser?.attachments.map((attachment) => attachment.id) : []);
  const replacementUserContent = input.preflightClarification
    ? formatPreflightClarificationModelMessage(input.preflightClarification)
    : input.clarification ? formatClarificationModelMessage(input.clarification) : undefined;
  const project = lineage?.merged;
  const projectFiles = (selectedKnowledgeFileIds === undefined
    ? project?.files
    : project?.files.filter((file) => selectedKnowledgeFileIds.includes(file.id))) ?? [];
  // Mirror resolveProjectContext's retrieval source, including the attachment
  // retriever's 20-file bound. Other indexed files still ride wholesale.
  const retrievalAttachmentIds = selectedKnowledgeFileIds
    ?? ((lineage?.depth ?? 1) > 1 ? project?.files.map((file) => file.id) : undefined);
  const indexedDocuments = project && retrievalAttachmentIds?.length !== 0 ? await prisma.knowledgeDocument.findMany({
    where: {
      userId, deletedAt: null, supersededById: null, state: { in: RETRIEVABLE_STATES },
      ...(retrievalAttachmentIds !== undefined
        ? { attachmentId: { in: [...new Set(retrievalAttachmentIds)].slice(0, 20) } }
        : { projectId: (conversation?.projectId ?? input.projectId)! }),
    },
    select: { fileName: true }, take: 200,
  }) : [];
  const connectorIds = workspacePermits(workspaceConfig, "connectors")
    ? [...new Set([
        ...(input.connectors ?? conversation?.activeConnectors ?? []),
        ...(input.context ?? []).filter((token) => token.kind === "app").map((token) => token.id),
      ])].filter((id) => workspaceConfig.allowedConnectorIds === undefined || workspaceConfig.allowedConnectorIds.includes(id))
    : [];
  return estimateAutoContext(
    {
      ...input,
      message: replacementUserContent ?? input.message,
      replacementUserContent,
      preserveLastAssistant: preserveLastAssistant || !!input.crossReply,
    },
    [],
    {
      history: history.reverse().map((message) => ({ ...message, content: decryptMessageText(message.content) })),
      totalMessages: conversation?._count.messages,
      attachments: attachments.filter((attachment) => !usedIds.has(attachment.id)),
      project: project ? {
        ...project,
        name: workspaceConfig.personaName ?? project.name,
        instructions: workspaceConfig.instructionsOverride ?? project.instructions,
        files: projectFiles,
      } : null,
      indexedProjectFileNames: indexedDocuments.map((document) => document.fileName),
      instructions,
      compactionEnabled: historyCompactionEnabled(),
      connectorCount: connectorIds.length,
    }
  );
}

/** The task class for a turn Auto did not route, so hand-routed turns are evidence too. */
export function classifyTaskForTelemetry(message: string): TaskClass {
  return classifyTask({ message, complexity: classifyPromptComplexity(message) }).taskClass;
}
