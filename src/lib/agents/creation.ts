/** Atomic, account-scoped creation. The caller resolves plan and connector grants. */
import { randomUUID } from "node:crypto";
import type { Prisma, Agent } from "@prisma/client";
import type { CreateAgentInput } from "./domain";
import { MAX_AGENTS_PER_ACCOUNT } from "./domain";
import { normalizeAgentAvatar } from "./avatar";
import { encryptField } from "../field-crypto";

export async function createAgentTransaction(tx: Prisma.TransactionClient, userId: string,
  input: CreateAgentInput, connectorIds: string[], projectId: string | null, defaultModel: string
): Promise<Agent | null> {
  // Serialize hires for this account, including cap checks and retries.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${userId}))`;
  const clientRequestId = input.creationKey ? `agent:start:${input.creationKey}` : null;
  if (clientRequestId) {
    const previous = await tx.conversation.findFirst({ where: { userId, clientRequestId }, select: { agentId: true } });
    if (previous?.agentId) {
      const agent = await tx.agent.findFirst({ where: { id: previous.agentId, userId, deletedAt: null } });
      if (!agent) throw new Error("agent_creation_retired");
      return agent;
    }
  }
  const count = await tx.agent.count({ where: { userId, deletedAt: null } });
  if (count >= MAX_AGENTS_PER_ACCOUNT) return null;
  const id = `ag_${randomUUID()}`;
  const agent = await tx.agent.create({ data: {
    id, userId, name: input.name, role: input.role,
    avatar: { ...normalizeAgentAvatar(input.avatar ?? null, id) },
    style: input.style, instructions: input.instructions, model: input.model ?? null,
    reasoningEffort: input.reasoningEffort ?? null, approvalMode: input.approvalMode,
    connectorIds, projectId, proactive: input.proactive, notify: input.notify,
    template: input.template ?? null, sortOrder: count,
  } });
  const conversation = await tx.conversation.create({ data: {
    userId, clientRequestId, agentId: id, title: agent.name, titleSource: "manual",
    kind: "chat", projectId, model: agent.model ?? defaultModel, activeConnectors: connectorIds,
  } });
  await tx.agentEvent.create({ data: {
    userId, agentId: id, kind: "hired", title: `${agent.name} joined`,
    detail: input.starterMessage ? { starterMessage: encryptField(input.starterMessage) } : {},
  } });
  if (input.firstGoal) {
    await tx.agentGoal.create({ data: { userId, agentId: id, title: input.firstGoal, cadence: "weekly" } });
    await tx.agentEvent.create({ data: { userId, agentId: id, kind: "goal_set", title: `New goal: ${input.firstGoal}` } });
  }
  return tx.agent.update({ where: { id, userId }, data: { conversationId: conversation.id } });
}
