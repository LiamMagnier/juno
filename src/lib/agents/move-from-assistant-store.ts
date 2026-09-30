import "server-only";

import { prisma } from "@/lib/prisma";
import { getAssistantById } from "@/lib/assistants";
import { canUseModel } from "@/lib/plans";
import { getUserPlan } from "@/lib/usage";
import { createAgentSchema } from "@/lib/agents/domain";
import {
  createAgentForUser,
  findAgent,
  recordAgentEvent,
  serializeAgents,
  type AgentActor,
  type AgentResult,
} from "@/lib/agents/store";
import { memberFromAssistant, moveCreationKey } from "@/lib/agents/move-from-assistant";
import type { ClientAgent } from "@/lib/agents/types";

/**
 * Moves one assistant to the crew (src/lib/agents/move-from-assistant.ts has
 * the mapping and the reasons). Idempotent: an assistant already moved answers
 * with the member it became, and a double press creates one member.
 */
export async function moveAssistantToCrew(user: AgentActor, assistantId: string): Promise<AgentResult<ClientAgent>> {
  const assistant = await getAssistantById(assistantId, user.id);
  if (!assistant) return { status: 404, body: { error: "not_found", message: "That assistant no longer exists." } };

  const row = await prisma.workSkill.findFirst({
    where: { id: assistantId, userId: user.id, kind: "assistant", deletedAt: null },
    select: { movedToAgentId: true },
  });
  if (row?.movedToAgentId) {
    const existing = await findAgent(user.id, row.movedToAgentId);
    if (existing) {
      const [serialized] = await serializeAgents(user.id, [existing]);
      return { status: 200, body: { agent: serialized, assistantId, replay: true }, value: serialized };
    }
  }

  const member = memberFromAssistant(assistant);
  // A model the plan does not include is left out rather than refusing the
  // move: the member then answers on the account's default, as a chat does.
  const model = member.model && canUseModel(await getUserPlan(user.id), member.model) ? member.model : null;
  const project = member.projectId
    ? await prisma.project.findFirst({ where: { id: member.projectId, userId: user.id }, select: { id: true } })
    : null;

  // Keyed on the assistant and on the member it last became, so a move after
  // that member was retired makes a new one instead of replaying the retired.
  const previousMember = row?.movedToAgentId ?? null;
  const input = createAgentSchema.safeParse({
    creationKey: moveCreationKey(user.id, previousMember ? `${assistantId}:${previousMember}` : assistantId),
    name: member.name,
    role: member.role,
    instructions: member.instructions,
    model,
    reasoningEffort: member.reasoningEffort,
    approvalMode: "balanced",
    connectorIds: member.connectorIds,
    projectId: project?.id ?? null,
    proactive: false,
    notify: "results",
  });
  if (!input.success) {
    return { status: 400, body: { error: "invalid_input", message: "That assistant could not be moved as it is." } };
  }
  const created = await createAgentForUser(user, input.data);
  if (created.status !== 201 || !created.value) return { status: created.status, body: created.body };
  const agent = created.value;

  // The provenance, and the assistant marked moved. Conditional on it not
  // having been moved by a racing request in between.
  await prisma.agent.updateMany({
    where: { id: agent.id, userId: user.id, sourceAssistantId: null },
    data: { sourceAssistantId: assistantId },
  });
  const marked = await prisma.workSkill.updateMany({
    where: { id: assistantId, userId: user.id, kind: "assistant", movedToAgentId: previousMember },
    data: { movedToAgentId: agent.id, movedAt: new Date() },
  });

  if (marked.count === 1) {
    if (member.ideas.length > 0) {
      await prisma.agentIdea.createMany({
        data: member.ideas.map((idea) => ({
          userId: user.id,
          agentId: agent.id,
          title: idea.title,
          prompt: idea.prompt,
          detail: "From the assistant's starter prompts.",
        })),
      });
    }
    await recordAgentEvent({
      userId: user.id,
      agentId: agent.id,
      kind: "moved_from_assistant",
      title: `Moved from Assistants: ${assistant.name}`,
      detail: {
        assistantId,
        ideas: member.ideas.length,
        instructionsCut: member.instructionsCut,
        modelDropped: Boolean(member.model && !model),
      },
    });
  }

  const fresh = await findAgent(user.id, agent.id);
  const serialized = fresh ? (await serializeAgents(user.id, [fresh]))[0] ?? agent : agent;
  return { status: 201, body: { agent: serialized, assistantId }, value: serialized };
}
