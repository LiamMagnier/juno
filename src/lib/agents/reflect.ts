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
 * It never starts work. An idea is a card with Start on it. When the person
 * was not there to see them — the background sweep (reflect-sweep.ts) — the
 * ideas are announced once per agent through `notifyUser`; on the page or
 * behind "Think it over" they are already on screen, so nothing is sent.
 */

import type { Agent } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { decryptField, encryptField } from "@/lib/field-crypto";
import {
  accountBackgroundProvider,
  loadBackgroundProviderPolicy,
  runUtilityPrompt,
  type UtilityLlm,
} from "@/lib/memory";
import { normalizeAgentAvatar } from "@/lib/agents/avatar";
import { AGENT_REFLECT_INTERVAL_MS, agentNotifyLevel, formatAgentWhen, reflectionDue } from "@/lib/agents/domain";
import {
  announcedIdeaIds,
  goalCheckInDue,
  ideasAnnouncement,
  parseReflection,
  REFLECTION_ANNOUNCED_IDEAS,
  reflectionSystemPrompt,
  reflectionUserMessage,
  type ReflectionResult,
} from "@/lib/agents/reflection";
import { recordAgentEvent, type AgentActor } from "@/lib/agents/store";
import { notifyUser } from "@/lib/notifications";
import { agentPath } from "@/lib/notify/paths";

export type ReflectOutcome =
  | { kind: "reflected"; ideas: number; ideaIds: string[]; ideaTitles: string[]; checkIns: number; notes: number }
  | { kind: "skipped"; reason: "not_due" | "paused" | "claimed" | "no_answer" | "not_found" };

/**
 * Who asked: the agent's page opening (the lazy trigger), the person pressing
 * "Think it over", or the background sweep. Only the sweep tells anyone.
 */
export type ReflectOrigin = "page" | "button" | "sweep";

export async function reflectAgent(
  user: AgentActor,
  agentId: string,
  options: { force?: boolean; now?: Date; llm?: UtilityLlm; origin?: ReflectOrigin } = {}
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
  // Every active goal is context, so an idea can serve any of them; only the
  // ones whose cadence asks for it now may be checked in on.
  const checkInGoals = goals.flatMap((goal, index) => (goalCheckInDue(goal, now) ? [index] : []));

  const [policy, conversationProvider] = options.llm
    ? [undefined, undefined]
    : await Promise.all([loadBackgroundProviderPolicy(user.id), accountBackgroundProvider(user.id)]);

  const { result } = await runUtilityPrompt<ReflectionResult>({
    system: reflectionSystemPrompt(),
    userMsg: reflectionUserMessage({
      agentName: agent.name,
      role: agent.role,
      instructions: agent.instructions,
      goals: goals.map((goal, index) => ({
        title: goal.title,
        detail: goal.detail,
        lastCheckInNote: goal.lastCheckInNote,
        checkInDue: checkInGoals.includes(index),
        dueAt: goal.dueAt ? goal.dueAt.toISOString().slice(0, 10) : null,
      })),
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
        checkInGoals,
      }),
    llm: options.llm,
    policy,
    conversationProvider,
  });
  if (!result) return { kind: "skipped", reason: "no_answer" };

  const ideaIds: string[] = [];
  for (const idea of result.ideas) {
    const goal = idea.goalIndex !== null ? goals[idea.goalIndex] : undefined;
    const created = await prisma.agentIdea.create({
      data: {
        userId: user.id,
        agentId: agent.id,
        title: idea.title,
        detail: idea.detail,
        prompt: idea.prompt,
        goalId: goal?.id ?? null,
      },
      select: { id: true },
    });
    ideaIds.push(created.id);
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
  if (options.origin === "sweep" && ideaIds.length > 0) {
    // The ideas are written; a notification that cannot be sent must not
    // turn the reflection into a failure the sweep would count and log.
    await announceIdeas(user.id, agent, ideaIds).catch((error) => {
      console.error("[agents] ideas notification failed", {
        agentId: agent.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
  return {
    kind: "reflected",
    ideas: result.ideas.length,
    ideaIds,
    ideaTitles: result.ideas.map((idea) => idea.title),
    checkIns: result.checkIns.length,
    notes: result.notes.length,
  };
}

/**
 * Tells the person a sweep left ideas waiting: one unread row per agent,
 * refreshed rather than repeated (the collapse key), counting every idea an
 * unread announcement already named that is still waiting — so four quiet
 * sweeps read "Quill has 5 ideas" once, and an idea started or dismissed in
 * the meantime drops out of the count. A low-priority update, pushed quietly
 * (`passive`: no sound, no wake) to the devices whose Updates switch is on.
 */
async function announceIdeas(
  userId: string,
  agent: Pick<Agent, "id" | "name" | "avatar"> & { notify?: string | null },
  freshIds: string[]
): Promise<void> {
  if (agentNotifyLevel(agent.notify) !== "all") return;
  const collapseKey = `agent-ideas:${agent.id}`;
  const unread = await prisma.notification.findFirst({
    where: { userId, readAt: null, actionData: { path: ["collapseKey"], equals: collapseKey } },
    orderBy: { createdAt: "desc" },
    select: { actionData: true },
  });
  // Newest first: this sweep's ideas in the order the model ranked them, then
  // the ones the unread row already named.
  const order = [...new Set([...freshIds, ...announcedIdeaIds(unread?.actionData)])].slice(0, REFLECTION_ANNOUNCED_IDEAS);
  const waiting = await prisma.agentIdea.findMany({
    where: { userId, agentId: agent.id, status: "new", id: { in: order } },
    select: { id: true, title: true },
  });
  if (waiting.length === 0) return;
  waiting.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));

  const copy = ideasAnnouncement(agent.name, waiting.map((idea) => idea.title));
  await notifyUser({
    userId,
    type: "agent_ideas",
    title: copy.title,
    body: copy.body,
    priority: "low",
    sourceType: "agent",
    sourceId: agent.id,
    actionData: { agentId: agent.id, ideaIds: waiting.map((idea) => idea.id) },
    path: agentPath(agent.id),
    agent: { id: agent.id, name: agent.name, avatar: normalizeAgentAvatar(agent.avatar, agent.id) },
    channel: "updates",
    collapseKey,
    push: {
      title: agent.name,
      body: copy.pushBody,
      threadId: `agent-${agent.id}`,
      collapseId: `agent-ideas-${agent.id}`,
      interruption: "passive",
      data: { agentId: agent.id },
    },
  });
}
