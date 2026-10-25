import "server-only";
import { prisma } from "@/lib/db";
import { decryptField } from "@/lib/field-crypto";
import { agentDispatchTarget } from "@/lib/agents/domain";
import { AGENT_CONTEXT_COMMAND_KINDS, agentRelayContext, type AgentRunPersona } from "@/lib/agents/relay-context";

export { MAX_AGENT_RELAY_CONTEXT_CHARS, agentRelayContext, type AgentRunPersona } from "@/lib/agents/relay-context";

/**
 * Who a crew member's task runs as: its name, role, brief, style, active goals
 * and the notes it keeps.
 *
 * One builder for both executors. The cloud runner (scripts/work-runner.ts)
 * puts the identity in the opening context and the notes inside its untrusted
 * envelope. A run on the person's Mac gets the same text as `agentContext` on
 * the start or resume command, built when the Mac claims the command
 * (`claimedCommandAgentContext`, below, called by
 * GET /api/work/hosts/[id]/commands) and never stored on the command row:
 * the notes are encrypted at rest, and a plaintext copy in `WorkCommand.payload`
 * would outlive "Forget this" for as long as the row lives.
 */

/** Reads and composes the persona, or null when the agent is gone. */
export async function loadAgentRunPersona(input: { userId: string; agentId: string }): Promise<AgentRunPersona | null> {
  const [agent, goals, notes] = await Promise.all([
    prisma.agent.findFirst({
      where: { id: input.agentId, userId: input.userId, deletedAt: null },
      select: { name: true, role: true, style: true, instructions: true },
    }),
    prisma.agentGoal.findMany({
      where: { userId: input.userId, agentId: input.agentId, status: "active" },
      orderBy: { createdAt: "asc" },
      take: 8,
      select: { title: true },
    }),
    // `deletedAt: null`: "Forget this" is a soft delete, and a note the
    // person asked the agent to forget must not reach its runs either.
    prisma.agentNote.findMany({
      where: { userId: input.userId, agentId: input.agentId, deletedAt: null },
      orderBy: { updatedAt: "desc" },
      take: 24,
      select: { content: true },
    }),
  ]);
  if (!agent) return null;

  const whoParts: string[] = [`## Who you are working as`, `You are ${agent.name}${agent.role ? ` (${agent.role})` : ""}.`];
  if (agent.instructions.trim()) {
    whoParts.push(`Brief:\n${agent.instructions.trim()}`);
  }
  if (agent.style.trim()) {
    whoParts.push(`Style: ${agent.style.trim()}`);
  }
  if (goals.length > 0) {
    whoParts.push(`Active goals:\n${goals.map((g) => `- ${g.title}`).join("\n")}`);
  }

  const decryptedNotes = notes.map((n) => decryptField(n.content).trim()).filter((text) => text.length > 0);
  return {
    name: agent.name,
    identity: whoParts.join("\n\n"),
    notes:
      decryptedNotes.length > 0
        ? { label: `agent notes — ${agent.name}`, body: decryptedNotes.map((text) => `- ${text}`).join("\n") }
        : null,
  };
}

/** Loads the persona and renders it for the relay, or null when there is none. */
export async function buildAgentRelayContext(input: { userId: string; agentId: string }): Promise<string | null> {
  const persona = await loadAgentRunPersona(input);
  return persona ? agentRelayContext(persona) : null;
}

/**
 * `agentContext` for a command the Mac has just claimed, or null.
 *
 * Built here, at claim time, from the live agent rather than read off the
 * command row: a resume a day later opens with the notes as they are now, a
 * note forgotten in between is gone, and nothing decrypted is ever written to
 * `WorkCommand.payload`. Only a start or a resume carries it, and only for a
 * session that belongs to a crew member of the same account.
 */
export async function claimedCommandAgentContext(input: {
  userId: string;
  command: { kind: string; sessionId: string };
}): Promise<string | null> {
  if (!(AGENT_CONTEXT_COMMAND_KINDS as readonly string[]).includes(input.command.kind)) return null;
  const session = await prisma.workSession.findFirst({
    where: { id: input.command.sessionId, userId: input.userId },
    select: { agentId: true },
  });
  if (!session?.agentId) return null;
  return buildAgentRelayContext({ userId: input.userId, agentId: session.agentId });
}

/**
 * The Work dispatch fields for an agent's work (`agentDispatchTarget`), with a
 * preferred Mac that no longer exists dropped.
 *
 * `Agent.preferredHostId` is a plain string, so revoking a Mac from the phone
 * (which deletes its WorkHost row) leaves it pointing at nothing, and every
 * task would then be refused "Host not found". A preference is an ordering
 * (dispatch puts that Mac first), so a missing one means "any of your Macs",
 * the way a project's default Mac is dropped when it no longer resolves.
 */
export async function resolveAgentDispatchTarget(
  userId: string,
  agent: { executionTarget?: string | null; preferredHostId?: string | null }
): Promise<{ requestedTarget: "cloud" | "local"; preferredHostId?: string }> {
  const target = agentDispatchTarget(agent);
  if (!target.preferredHostId) return target;
  const host = await prisma.workHost.findFirst({
    where: { id: target.preferredHostId, userId },
    select: { id: true },
  });
  return host ? target : { requestedTarget: target.requestedTarget };
}
