import "server-only";

/**
 * Temporary specialist teams, durably: every member is a Work task, the lead
 * is the task the person asked for, and this file is the coordinator that
 * starts members when their dependencies have ended, retries an interrupted
 * one that never acted, contains failures, and writes the final answer onto
 * the lead. The rules are pure, in src/lib/agents/team.ts.
 *
 * Where it runs: the Work runner's tick (scripts/work-runner.ts) calls
 * `advanceTeams` beside the stalled-run sweep. The lead's run is held by the
 * coordinator's lease (claimed, heartbeated, fenced like any executor's), so a
 * coordinator that dies is noticed by the same sweep, and the next tick picks
 * the team up again with a new attempt of the lead: everything it needs is in
 * the rows, nothing in memory.
 *
 * Admission: the team is admitted once, as the lead task, through
 * `start_task`'s full path (plan, usage window, run cap, approval card when
 * the estimate or untrusted content asks for one). Members run inside the
 * lead's budget, each with its share, its own capability scope and approval
 * mode, and the account's run cap still bounds how many run at once.
 */

import { Prisma, type WorkRun, type WorkSession } from "@prisma/client";
import { prisma, prismaUnguarded } from "@/lib/prisma";
import {
  WORK_LEASED_STATUSES,
  WorkSpendAdmissionError,
  appendEvents,
  claimRun,
  createRun,
  finishRun,
  renewRunLease,
} from "@/lib/work/store";
import { WORK_LIVE_STATUSES, WORK_TERMINAL_STATUSES, type WorkPermissionPolicy } from "@/lib/work/domain";
import { GOAL_ACTING_EVENT_KINDS } from "@/lib/agents/goals";
import {
  TEAM_NODE_MAX_ATTEMPTS,
  TEAM_ROLES,
  TEAM_ROLE_INFO,
  composeTeamNodePrompt,
  planTeam,
  planTeamTick,
  teamMemberSentence,
  type TeamNodeState,
  type TeamRole,
} from "@/lib/agents/team";

/** The account's live-run cap, mirrored from dispatch (WORK_RUN_CONCURRENCY_CAP). */
const ACCOUNT_RUN_CAP = 3;
/** Attempts of the lead (coordinator restarts) before the team gives up. */
const MAX_LEAD_ATTEMPTS = 5;
/** Teams one tick coordinates. */
const TEAMS_PER_TICK = 20;

function memberSessionId(leadId: string, role: TeamRole): string {
  return `${leadId}-${role}`;
}

function policyFor(role: TeamRole, leadPolicy: string): WorkPermissionPolicy {
  const info = TEAM_ROLE_INFO[role];
  if (info.policy !== "inherit") return info.policy;
  return leadPolicy === "conservative" || leadPolicy === "permissive" ? leadPolicy : "balanced";
}

/**
 * Turns a just-created lead task into a team: marks it the lead and creates
 * one member task per role, as drafts with no run. Idempotent: member ids are
 * derived from the lead's, so a retried call finds them.
 */
export async function createTeamForLead(input: {
  userId: string;
  lead: Pick<WorkSession, "id" | "title" | "projectId" | "requestedModel" | "reasoningEffort" | "permissionPolicy">;
  request: string;
  specialists?: readonly string[] | null;
}): Promise<{ roles: TeamRole[] }> {
  const plan = planTeam(input.request, input.specialists);
  const connectors = await prisma.workSessionConnector.findMany({
    where: { userId: input.userId, sessionId: input.lead.id },
    select: { connectorId: true },
  });
  await prisma.$transaction(async (tx) => {
    await tx.workSession.updateMany({
      where: { id: input.lead.id, userId: input.userId },
      data: { teamRole: "lead" },
    });
    for (const node of plan) {
      const id = memberSessionId(input.lead.id, node.role);
      const exists = await tx.workSession.findFirst({ where: { id, userId: input.userId }, select: { id: true } });
      if (exists) continue;
      const info = TEAM_ROLE_INFO[node.role];
      await tx.workSession.create({
        data: {
          id,
          userId: input.userId,
          projectId: input.lead.projectId,
          parentSessionId: input.lead.id,
          teamRole: node.role,
          title: `${input.lead.title} · ${info.name}`.slice(0, 120),
          titleSource: "manual",
          // Replaced with the composed prompt, colleagues' results included,
          // when the member starts (`advanceTeam`).
          goal: `${info.brief}\n\n${input.request}`,
          status: "draft",
          requestedTarget: "cloud",
          requestedModel: input.lead.requestedModel,
          reasoningEffort: input.lead.reasoningEffort,
          permissionPolicy: policyFor(node.role, input.lead.permissionPolicy),
          connectorsChosen: true,
          dependsOnSessionIds: node.dependsOn.map((role) => memberSessionId(input.lead.id, role)),
          dependencyMode: "settled",
          maxAttempts: TEAM_NODE_MAX_ATTEMPTS,
          // The member's slice of the lead's budget, in thousandths; read at start.
          completionCriteria: `budgetShare=${node.budgetShare}`,
        },
      });
      if (info.connectors && connectors.length) {
        await tx.workSessionConnector.createMany({
          data: connectors.map((c) => ({ userId: input.userId, sessionId: id, connectorId: c.connectorId })),
          skipDuplicates: true,
        });
      }
    }
  });
  return { roles: plan.map((node) => node.role) };
}

/** Removes a team's member drafts when its lead did not start. */
export async function discardTeamDrafts(userId: string, leadId: string): Promise<void> {
  await prisma.workSession
    .updateMany({
      where: { userId, parentSessionId: leadId, teamRole: { not: null }, status: "draft", deletedAt: null },
      data: { deletedAt: new Date() },
    })
    .catch(() => undefined);
}

async function latestRuns(userId: string, sessionIds: readonly string[]): Promise<Map<string, WorkRun>> {
  if (sessionIds.length === 0) return new Map();
  const runs = await prisma.workRun.findMany({
    where: { userId, sessionId: { in: [...sessionIds] } },
    orderBy: { attempt: "desc" },
  });
  const map = new Map<string, WorkRun>();
  for (const run of runs) if (!map.has(run.sessionId)) map.set(run.sessionId, run);
  return map;
}

/** The last thing a run wrote to the person: its result, for colleagues and for the lead. */
async function runOutput(userId: string, runId: string): Promise<string | null> {
  const event = await prisma.workEvent.findFirst({
    where: { userId, runId, kind: "assistant_message" },
    orderBy: { seq: "desc" },
    select: { payload: true },
  });
  const text = (event?.payload as { text?: unknown } | null)?.text;
  return typeof text === "string" && text.trim() ? text : null;
}

function shareOf(member: Pick<WorkSession, "completionCriteria">): number {
  const match = /budgetShare=(\d+)/.exec(member.completionCriteria ?? "");
  return match ? Math.min(1000, Number(match[1])) : 200;
}

export type AdvanceTeamOutcome =
  | { kind: "skipped"; reason: string }
  | { kind: "advanced"; started: TeamRole[]; retried: TeamRole[]; finished: null | "completed" | "failed" };

/**
 * One coordinator pass over one team. Safe to run from several workers at
 * once: the lead's lease decides which one coordinates, member runs are
 * created with idempotency keys, and every event carries a key.
 */
export async function advanceTeam(input: { userId: string; leadId: string; executorId: string; now?: Date }): Promise<AdvanceTeamOutcome> {
  const now = input.now ?? new Date();
  const { userId, leadId, executorId } = input;
  const lead = await prisma.workSession.findFirst({ where: { id: leadId, userId, teamRole: "lead", deletedAt: null } });
  if (!lead) return { kind: "skipped", reason: "not_a_team" };
  let leadRun = (await latestRuns(userId, [leadId])).get(leadId) ?? null;
  if (!leadRun) return { kind: "skipped", reason: "lead_not_started" };

  const members = await prisma.workSession.findMany({
    where: { userId, parentSessionId: leadId, teamRole: { in: [...TEAM_ROLES] }, deletedAt: null },
  });

  // The person stopped the team (or it already ended): stop every member still going.
  if ((WORK_TERMINAL_STATUSES as readonly string[]).includes(leadRun.status) && leadRun.terminalReason !== "interrupted") {
    const runs = await latestRuns(userId, members.map((m) => m.id));
    for (const run of runs.values()) {
      if ((WORK_LIVE_STATUSES as readonly string[]).includes(run.status)) {
        await finishRun({ runId: run.id, userId, reason: "cancelled", detail: "The team's lead task ended.", now });
      }
    }
    return { kind: "skipped", reason: "lead_ended" };
  }

  // Hold the lead: claim it, heartbeat it, or start a new attempt after a coordinator died.
  if (leadRun.status === "queued") {
    const claim = await claimRun({ runId: leadRun.id, userId, executorId, now });
    if (!claim.claimed) return { kind: "skipped", reason: "lead_claimed_elsewhere" };
    await prisma.workRun.updateMany({ where: { id: leadRun.id, userId, claimedBy: executorId }, data: { status: "running" } });
    await prisma.workSession.updateMany({ where: { id: leadId, userId }, data: { status: "running" } });
    leadRun = claim.run;
  } else if (leadRun.terminalReason === "interrupted") {
    if (leadRun.attempt >= MAX_LEAD_ATTEMPTS) return { kind: "skipped", reason: "lead_attempts_exhausted" };
    const resumed = await createRun({
      sessionId: leadId,
      userId,
      origin: "resume",
      requestedTarget: "cloud",
      effectiveTarget: "cloud",
      requestedModel: leadRun.requestedModel,
      effectiveModel: leadRun.effectiveModel,
      permissionPolicy: leadRun.permissionPolicy as Prisma.InputJsonValue,
      budget: { maxCostMicroUsd: leadRun.maxCostMicroUsd, maxTokens: leadRun.maxTokens, maxRuntimeMs: 0 },
      idempotencyKey: `team-lead:${leadId}:${leadRun.attempt + 1}`,
      spendReservation: false,
    });
    const claim = await claimRun({ runId: resumed.run.id, userId, executorId, now });
    if (!claim.claimed) return { kind: "skipped", reason: "lead_claimed_elsewhere" };
    await prisma.workRun.updateMany({ where: { id: resumed.run.id, userId, claimedBy: executorId }, data: { status: "running" } });
    await prisma.workSession.updateMany({ where: { id: leadId, userId }, data: { status: "running" } });
    leadRun = claim.run;
    await appendEvents({ runId: leadRun.id, userId, events: [{ kind: "subagent_update", key: `team:resumed:${leadRun.attempt}`, payload: { phase: "resumed", sentence: "The team picked up where it left off" } }] });
  } else if ((WORK_LEASED_STATUSES as readonly string[]).includes(leadRun.status)) {
    if (leadRun.claimedBy !== executorId && leadRun.leaseExpiresAt && leadRun.leaseExpiresAt > now) {
      return { kind: "skipped", reason: "lead_claimed_elsewhere" };
    }
    if (leadRun.claimedBy === executorId) {
      const held = await renewRunLease({ runId: leadRun.id, userId, executorId, now });
      if (!held) return { kind: "skipped", reason: "lead_lease_lost" };
    } else {
      // Another coordinator's lapsed lease: the stalled-run sweep ends it and
      // the next pass resumes. Never take a live run over in place.
      return { kind: "skipped", reason: "lead_lease_lapsed" };
    }
  } else {
    return { kind: "skipped", reason: `lead_${leadRun.status}` };
  }

  const runs = await latestRuns(userId, members.map((m) => m.id));
  const runIds = [...runs.values()].map((run) => run.id);
  const acting = runIds.length
    ? await prisma.workEvent.findMany({
        where: { userId, runId: { in: runIds }, kind: { in: [...GOAL_ACTING_EVENT_KINDS] } },
        select: { runId: true },
        distinct: ["runId"],
      })
    : [];
  const acted = new Set(acting.map((row) => row.runId));
  const byRole = new Map(members.map((m) => [m.teamRole as TeamRole, m]));
  const states: TeamNodeState[] = members.map((member) => {
    const run = runs.get(member.id);
    return {
      role: member.teamRole as TeamRole,
      dependsOn: member.dependsOnSessionIds.map((id) => members.find((m) => m.id === id)?.teamRole as TeamRole).filter(Boolean),
      status: member.status,
      attempt: run?.attempt ?? 0,
      acted: run ? acted.has(run.id) : false,
    };
  });

  // Say what changed since the last pass: one keyed event per member outcome.
  const events: { kind: "subagent_update"; key: string; payload: Prisma.InputJsonValue; agentId: string }[] = [];
  for (const state of states) {
    const run = runs.get(byRole.get(state.role)!.id);
    if (!run) continue;
    const phase =
      state.status === "completed" ? "finished"
      : state.status === "waiting_approval" || state.status === "waiting_input" ? "waiting"
      : (WORK_TERMINAL_STATUSES as readonly string[]).includes(state.status) && state.status !== "cancelled" && !(state.status === "interrupted" && !state.acted && state.attempt < TEAM_NODE_MAX_ATTEMPTS) ? "failed"
      : null;
    if (phase) {
      events.push({
        kind: "subagent_update",
        key: `team:${state.role}:${phase}:${run.attempt}`,
        agentId: state.role,
        payload: { role: state.role, name: TEAM_ROLE_INFO[state.role].name, phase, sentence: teamMemberSentence(state.role, phase), sessionId: run.sessionId },
      });
    }
  }

  const live = await prisma.workRun.count({ where: { userId, status: { in: [...WORK_LIVE_STATUSES] } } });
  const tick = planTeamTick(states, Math.max(0, ACCOUNT_RUN_CAP - live));

  for (const role of tick.skip) {
    const member = byRole.get(role);
    if (!member || member.status !== "draft") continue;
    await prisma.workSession.updateMany({ where: { id: member.id, userId, status: "draft" }, data: { status: "cancelled" } });
    events.push({ kind: "subagent_update", key: `team:${role}:skipped`, agentId: role, payload: { role, name: TEAM_ROLE_INFO[role].name, phase: "skipped", sentence: teamMemberSentence(role, "skipped") } });
  }

  const started: TeamRole[] = [];
  const retried: TeamRole[] = [];
  const leadPolicy = (leadRun.permissionPolicy ?? {}) as Record<string, unknown>;
  const startMember = async (role: TeamRole, retry: boolean) => {
    const member = byRole.get(role);
    if (!member) return;
    const previous = runs.get(member.id);
    const attempt = (previous?.attempt ?? 0) + 1;
    if (!retry) {
      const upstream = await Promise.all(
        states
          .find((s) => s.role === role)!
          .dependsOn.map(async (dep) => {
            const depMember = byRole.get(dep);
            const depRun = depMember ? runs.get(depMember.id) : undefined;
            const completed = depMember?.status === "completed";
            return { role: dep, completed, output: completed && depRun ? await runOutput(userId, depRun.id) : null };
          })
      );
      await prisma.workSession.updateMany({
        where: { id: member.id, userId },
        data: { goal: composeTeamNodePrompt({ role, request: lead.goal, upstream }) },
      });
    }
    const policy = member.permissionPolicy as WorkPermissionPolicy;
    try {
      await createRun({
        sessionId: member.id,
        userId,
        origin: retry ? "retry" : "fork",
        requestedTarget: "cloud",
        effectiveTarget: "cloud",
        requestedModel: leadRun!.requestedModel,
        effectiveModel: leadRun!.effectiveModel,
        requiredCapabilities: TEAM_ROLE_INFO[role].capabilities,
        permissionPolicy: { ...leadPolicy, policy, session: policy, team: role } as Prisma.InputJsonValue,
        budget: {
          maxCostMicroUsd: leadRun!.maxCostMicroUsd > 0 ? Math.max(1, Math.floor((leadRun!.maxCostMicroUsd * shareOf(member)) / 1000)) : 0,
          maxTokens: 0,
          maxRuntimeMs: 0,
        },
        idempotencyKey: `team:${member.id}:${attempt}`,
      });
      (retry ? retried : started).push(role);
      events.push({ kind: "subagent_update", key: `team:${role}:${retry ? "retrying" : "started"}:${attempt}`, agentId: role, payload: { role, name: TEAM_ROLE_INFO[role].name, phase: retry ? "retrying" : "started", sentence: teamMemberSentence(role, retry ? "retrying" : "started"), sessionId: member.id } });
    } catch (error) {
      if (!(error instanceof WorkSpendAdmissionError)) throw error;
      // Out of room in the usage window: contained like any other failure.
      await prisma.workSession.updateMany({ where: { id: member.id, userId, status: "draft" }, data: { status: "failed" } });
      events.push({ kind: "subagent_update", key: `team:${role}:failed:admission`, agentId: role, payload: { role, name: TEAM_ROLE_INFO[role].name, phase: "failed", sentence: `${TEAM_ROLE_INFO[role].name} couldn't start: the usage window is full` } });
    }
  };
  for (const role of tick.retry) await startMember(role, true);
  for (const role of tick.start) await startMember(role, false);

  if (events.length) await appendEvents({ runId: leadRun.id, userId, events });

  if (tick.finish) {
    const synthesis = byRole.get("synthesis");
    const synthesisRun = synthesis ? runs.get(synthesis.id) : undefined;
    if (tick.finish.status === "completed" && synthesisRun) {
      const text = (await runOutput(userId, synthesisRun.id)) ?? "The team finished, but the lead wrote no final text.";
      await appendEvents({ runId: leadRun.id, userId, events: [{ kind: "assistant_message", key: `team:final:${synthesisRun.id}`, payload: { text } }] });
    }
    // No usage on the lead: each member's run carries and bills its own, and
    // copying their sum here would count the same spend twice.
    await finishRun({
      runId: leadRun.id,
      userId,
      reason: tick.finish.status === "completed" ? "completed" : "failed",
      detail: tick.finish.reason,
      executorId,
      now,
    });
    if (lead.agentId) {
      const { recordAgentEvent } = await import("@/lib/agents/store");
      await recordAgentEvent({
        userId,
        agentId: lead.agentId,
        kind: "team_run",
        title: tick.finish.status === "completed" ? `The team finished ${lead.title}` : `The team couldn't finish ${lead.title}`,
        sessionId: leadId,
      });
    }
    const { deliverRunNotification } = await import("@/lib/work/notify/deliver");
    void deliverRunNotification({ runId: leadRun.id, userId });
    return { kind: "advanced", started, retried, finished: tick.finish.status };
  }
  return { kind: "advanced", started, retried, finished: null };
}

/**
 * Every live team, coordinated once. Called from the Work runner's tick.
 * Cross-account read said out loud; each team is then advanced with its
 * owner's id through the guarded client.
 */
export async function advanceTeams(input: { executorId: string; now?: Date }): Promise<{ teams: number; finished: number }> {
  const leads = await prismaUnguarded.workSession.findMany({
    where: { teamRole: "lead", deletedAt: null, status: { in: ["queued", "preparing", "running", "interrupted"] } },
    select: { id: true, userId: true },
    orderBy: { lastActivityAt: "asc" },
    take: TEAMS_PER_TICK,
  });
  // Teams whose lead was stopped while members still run: stop the members.
  const orphans = await prismaUnguarded.workSession.findMany({
    where: { teamRole: { in: [...TEAM_ROLES] }, deletedAt: null, status: { in: [...WORK_LIVE_STATUSES] } },
    select: { parentSessionId: true, userId: true },
    take: TEAMS_PER_TICK * 5,
  });
  const orphanLeadIds = [...new Set(orphans.map((o) => o.parentSessionId).filter((id): id is string => !!id))];
  const stopped = orphanLeadIds.length
    ? await prismaUnguarded.workSession.findMany({
        where: { id: { in: orphanLeadIds }, teamRole: "lead", status: { in: ["cancelled", "failed", "completed"] } },
        select: { id: true, userId: true },
      })
    : [];
  for (const lead of stopped) leads.push(lead);
  let finished = 0;
  for (const lead of leads) {
    try {
      const outcome = await advanceTeam({ userId: lead.userId, leadId: lead.id, executorId: input.executorId, now: input.now });
      if (outcome.kind === "advanced" && outcome.finished) finished += 1;
    } catch (error) {
      console.error("[teams] advance failed", { leadId: lead.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { teams: leads.length, finished };
}
