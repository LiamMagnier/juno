import "server-only";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { detectRepeatedMethods, skillDraftFromCandidate, type MethodRun } from "@/lib/procedural-memory";
import { skillSlugFromName } from "@/lib/work/skills";

/** Completed runs read per refresh: recent enough to be the person's current way of working. */
const RUNS_PER_REFRESH = 200;

export interface ClientSkillCandidate {
  id: string;
  title: string;
  projectId: string | null;
  examples: string[];
  tools: string[];
  runCount: number;
  lastSeenAt: string;
  status: string;
  skillId: string | null;
}

function methodOf(value: Prisma.JsonValue): { examples: string[]; tools: string[]; sessionIds: string[] } {
  const body = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const list = (key: string) => (Array.isArray(body[key]) ? (body[key] as unknown[]).filter((x): x is string => typeof x === "string") : []);
  return { examples: list("examples"), tools: list("tools"), sessionIds: list("sessionIds") };
}

/**
 * Re-reads the person's completed runs and refreshes proposals: new methods
 * become pending proposals; known ones update their counts; dismissed and
 * accepted ones are never reopened. Bounded, model-free.
 */
export async function refreshSkillCandidates(userId: string): Promise<{ proposed: number }> {
  const sessions = await prisma.workSession.findMany({
    where: { userId, deletedAt: null, status: "completed" },
    orderBy: { lastActivityAt: "desc" },
    take: RUNS_PER_REFRESH,
    select: { id: true, title: true, goal: true, projectId: true, lastActivityAt: true },
  });
  if (sessions.length === 0) return { proposed: 0 };
  const events = await prisma.workEvent.findMany({
    where: { userId, kind: "tool_finished", run: { sessionId: { in: sessions.map((s) => s.id) }, userId } },
    select: { payload: true, run: { select: { sessionId: true } } },
  });
  const toolsBySession = new Map<string, Set<string>>();
  for (const event of events) {
    const payload = event.payload && typeof event.payload === "object" ? (event.payload as Record<string, unknown>) : {};
    if (payload.isError === true || typeof payload.tool !== "string") continue;
    const set = toolsBySession.get(event.run.sessionId) ?? new Set<string>();
    set.add(payload.tool);
    toolsBySession.set(event.run.sessionId, set);
  }
  const runs: MethodRun[] = sessions.map((s) => ({
    sessionId: s.id,
    title: s.title,
    goal: s.goal,
    projectId: s.projectId,
    finishedAt: s.lastActivityAt,
    tools: [...(toolsBySession.get(s.id) ?? [])],
  }));
  let proposed = 0;
  for (const candidate of detectRepeatedMethods(runs)) {
    const method = { examples: candidate.examples, tools: candidate.tools, sessionIds: candidate.sessionIds };
    const existing = await prisma.skillCandidate.findUnique({
      where: { userId_key: { userId, key: candidate.key } },
      select: { id: true, status: true },
    });
    if (existing) {
      if (existing.status === "pending") {
        await prisma.skillCandidate.updateMany({
          where: { id: existing.id, userId },
          data: { method, runCount: candidate.sessionIds.length, lastSeenAt: candidate.lastSeenAt, title: candidate.title },
        });
      }
      continue;
    }
    await prisma.skillCandidate.create({
      data: {
        userId,
        projectId: candidate.projectId,
        key: candidate.key,
        title: candidate.title,
        method,
        runCount: candidate.sessionIds.length,
        lastSeenAt: candidate.lastSeenAt,
      },
    });
    proposed++;
  }
  return { proposed };
}

export async function listSkillCandidates(userId: string): Promise<ClientSkillCandidate[]> {
  const rows = await prisma.skillCandidate.findMany({
    where: { userId, status: "pending" },
    orderBy: { lastSeenAt: "desc" },
    take: 20,
  });
  return rows.map((row) => {
    const method = methodOf(row.method);
    return {
      id: row.id,
      title: row.title,
      projectId: row.projectId,
      examples: method.examples,
      tools: method.tools,
      runCount: row.runCount,
      lastSeenAt: row.lastSeenAt.toISOString(),
      status: row.status,
      skillId: row.skillId,
    };
  });
}

export async function dismissSkillCandidate(userId: string, id: string): Promise<boolean> {
  const { count } = await prisma.skillCandidate.updateMany({ where: { id, userId, status: "pending" }, data: { status: "dismissed" } });
  return count > 0;
}

/**
 * The person accepted: the method becomes a skill they own, with auto-selection
 * off, through the same store every authored skill goes through (scanned,
 * audited). Returns the skill's slug, or a refusal the page can say.
 */
export async function acceptSkillCandidate(
  userId: string,
  id: string
): Promise<{ ok: true; slug: string; skillId: string } | { ok: false; reason: "not_found" | "slug_taken" | "no_name" }> {
  const row = await prisma.skillCandidate.findFirst({ where: { id, userId, status: "pending" } });
  if (!row) return { ok: false, reason: "not_found" };
  const method = methodOf(row.method);
  const draft = skillDraftFromCandidate({ title: row.title, examples: method.examples, tools: method.tools });
  const slug = skillSlugFromName(draft.name);
  if (!slug) return { ok: false, reason: "no_name" };
  const { createSkillWithFirstVersion } = await import("@/lib/skills/store");
  const created = await createSkillWithFirstVersion({
    userId,
    slug,
    name: draft.name,
    description: draft.description,
    instructions: draft.instructions,
    projectId: row.projectId,
    origin: "authored",
    autoSelect: false,
    actor: "web",
  });
  if (!created.ok) return { ok: false, reason: "slug_taken" };
  await prisma.skillCandidate.updateMany({
    where: { id, userId },
    data: { status: "accepted", skillId: created.skill.id },
  });
  return { ok: true, slug, skillId: created.skill.id };
}
