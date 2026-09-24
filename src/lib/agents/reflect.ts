import "server-only";

/**
 * Running a reflection: an agent looks at its goals and recent work and
 * raises ideas, checks in on goals, and keeps a note or two.
 *
 * Bounded three ways. **Frequency**: at most once per
 * `AGENT_REFLECT_INTERVAL_MS` per agent unless a person asks, claimed with a
 * conditional update so two tabs opening the page cannot both pay for it.
 * **Provider**: it runs on the account's background provider under the same
 * policy titles and memory use (`runUtilityPrompt`), so content never crosses
 * to a provider the account did not allow. **Money**: the walk bills the
 * account's ApiSpend ledger as utility work, so it counts against the monthly
 * budget and shows on the usage page.
 *
 * It never starts work. An idea is a card with Start on it.
 */

import { prisma } from "@/lib/prisma";
import { decryptField, encryptField } from "@/lib/field-crypto";
import {
  accountBackgroundProvider,
  loadBackgroundProviderPolicy,
  runUtilityPrompt,
  type UtilityLlm,
} from "@/lib/memory";
import { AGENT_REFLECT_INTERVAL_MS, formatAgentWhen, reflectionDue } from "@/lib/agents/domain";
import {
  parseReflection,
  reflectionSystemPrompt,
  reflectionUserMessage,
  type ReflectionResult,
} from "@/lib/agents/reflection";
import { recordAgentEvent, type AgentActor } from "@/lib/agents/store";

export type ReflectOutcome =
  | { kind: "reflected"; ideas: number; checkIns: number; notes: number }
  | { kind: "skipped"; reason: "not_due" | "paused" | "claimed" | "no_answer" | "not_found" };

export async function reflectAgent(
  user: AgentActor,
  agentId: string,
  options: { force?: boolean; now?: Date; llm?: UtilityLlm } = {}
): Promise<ReflectOutcome> {
  const now = options.now ?? new Date();
  const agent = await prisma.agent.findFirst({ where: { id: agentId, userId: user.id, deletedAt: null } });
  if (!agent) return { kind: "skipped", reason: "not_found" };
  if (agent.status !== "active") return { kind: "skipped", reason: "paused" };
  if (
    !reflectionDue({
      status: agent.status,
      proactive: agent.proactive,
      lastReflectedAt: agent.lastReflectedAt,
      now,
      force: options.force,
    })
  ) {
    return { kind: "skipped", reason: "not_due" };
  }

  // The claim. A forced reflection still claims, so a double press is one call.
  const threshold = new Date(now.getTime() - (options.force ? 30_000 : AGENT_REFLECT_INTERVAL_MS));
  const claimed = await prisma.agent.updateMany({
    where: {
      id: agent.id,
      userId: user.id,
      OR: [{ lastReflectedAt: null }, { lastReflectedAt: { lt: threshold } }],
    },
    data: { lastReflectedAt: now },
  });
  if (claimed.count === 0) return { kind: "skipped", reason: "claimed" };

  const [goals, notes, tasks, openIdeas, dismissedIdeas] = await Promise.all([
    prisma.agentGoal.findMany({
      where: { userId: user.id, agentId: agent.id, status: "active" },
      orderBy: { createdAt: "asc" },
      take: 10,
    }),
    prisma.agentNote.findMany({
      where: { userId: user.id, agentId: agent.id, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { content: true },
    }),
    prisma.workSession.findMany({
      where: { userId: user.id, agentId: agent.id, deletedAt: null, status: { not: "draft" } },
      orderBy: { lastActivityAt: "desc" },
      take: 15,
      select: { title: true, status: true, lastActivityAt: true },
    }),
    prisma.agentIdea.findMany({
      where: { userId: user.id, agentId: agent.id, status: "new" },
      select: { title: true },
      take: 20,
    }),
    prisma.agentIdea.findMany({
      where: { userId: user.id, agentId: agent.id, status: "dismissed" },
      orderBy: { decidedAt: "desc" },
      select: { title: true },
      take: 15,
    }),
  ]);

  const openTitles = openIdeas.map((idea) => idea.title);
  const dismissedTitles = dismissedIdeas.map((idea) => idea.title);
  const knownNotes = notes.map((note) => decryptField(note.content));

  const [policy, conversationProvider] = options.llm
    ? [undefined, undefined]
    : await Promise.all([loadBackgroundProviderPolicy(user.id), accountBackgroundProvider(user.id)]);

  const { result } = await runUtilityPrompt<ReflectionResult>({
    system: reflectionSystemPrompt(),
    userMsg: reflectionUserMessage({
      agentName: agent.name,
      role: agent.role,
      instructions: agent.instructions,
      goals: goals.map((goal) => ({ title: goal.title, detail: goal.detail, lastCheckInNote: goal.lastCheckInNote })),
      notes: knownNotes,
      tasks: tasks.map((task) => ({ title: task.title, status: task.status, when: formatAgentWhen(task.lastActivityAt, now) })),
      openIdeas: openTitles,
      dismissedIdeas: dismissedTitles,
      today: now.toISOString().slice(0, 10),
    }),
    maxTokens: 900,
    label: "agent-reflection",
    userId: user.id,
    parse: (text) =>
      parseReflection(text, {
        goalCount: goals.length,
        openIdeas: openTitles,
        dismissedIdeas: dismissedTitles,
        knownNotes,
      }),
    llm: options.llm,
    policy,
    conversationProvider,
  });
  if (!result) return { kind: "skipped", reason: "no_answer" };

  for (const idea of result.ideas) {
    const goal = idea.goalIndex !== null ? goals[idea.goalIndex] : undefined;
    await prisma.agentIdea.create({
      data: {
        userId: user.id,
        agentId: agent.id,
        title: idea.title,
        detail: idea.detail,
        prompt: idea.prompt,
        goalId: goal?.id ?? null,
      },
    });
    await recordAgentEvent({ userId: user.id, agentId: agent.id, kind: "idea_raised", title: `Idea: ${idea.title}` });
  }
  for (const checkIn of result.checkIns) {
    const goal = goals[checkIn.goalIndex];
    if (!goal) continue;
    await prisma.agentGoal.updateMany({
      where: { id: goal.id, userId: user.id },
      data: { lastCheckInAt: now, lastCheckInNote: checkIn.note },
    });
    await recordAgentEvent({
      userId: user.id,
      agentId: agent.id,
      kind: "goal_checked_in",
      title: `Checked in on ${goal.title}`,
      text: checkIn.note,
    });
  }
  for (const note of result.notes) {
    await prisma.agentNote.create({
      data: { userId: user.id, agentId: agent.id, content: encryptField(note), source: "reflection" },
    });
    // What it learned stays in the (encrypted) note, not in the plaintext log.
    await recordAgentEvent({ userId: user.id, agentId: agent.id, kind: "note_learned", title: "Learned something" });
  }
  return { kind: "reflected", ideas: result.ideas.length, checkIns: result.checkIns.length, notes: result.notes.length };
}
