import "server-only";

/**
 * Setup changes, on the server: record, apply, undo.
 *
 * The plan (direction, before, after) is decided in
 * src/lib/agents/setup-changes.ts. This file writes it through the functions
 * every other path already uses (`updateAgentForUser`, `createAgentRoutine`,
 * `updateAgentRoutine`, the skill store), so a change asked for in a thread
 * meets exactly the checks the same change meets from the profile: linked
 * apps only, the plan gate on models, a paused member's routines staying
 * paused.
 *
 * Nothing here decides whether a widening change may apply. The chat tool asks
 * the approval broker first, and the Apply route requires the digest of the
 * card the person pressed; `applySetupChange` is only ever reached after one
 * of the two.
 */

import type { Agent, AgentSetupChange, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  agentApprovalMode,
  agentNotifyLevel,
  createRoutineSchema,
  patchAgentSchema,
} from "@/lib/agents/domain";
import {
  appsAtApply,
  planSetupChange,
  scalarUndoIsCurrent,
  setupChangeDigest,
  setupDirectionSentence,
  undoAppsDelta,
  SETUP_CHANGE_KIND_LABEL,
  type SetupChangeKind,
  type SetupChangeStatus,
  type SetupDirection,
  type SetupPlan,
  type SetupSnapshot,
} from "@/lib/agents/setup-changes";
import type { AgentActor } from "@/lib/agents/store";

/** What the card and the apps read about one change. */
export interface ClientSetupChange {
  id: string;
  agentId: string;
  kind: SetupChangeKind;
  kindLabel: string;
  direction: SetupDirection;
  directionSentence: string;
  summary: string;
  affects: string;
  status: SetupChangeStatus;
  detail: string | null;
  /** The digest Apply must carry. */
  digest: string;
  canApply: boolean;
  canUndo: boolean;
  appliedAt: string | null;
  undoneAt: string | null;
  createdAt: string;
}

function objectOf(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function serializeSetupChange(row: AgentSetupChange, memberName: string): ClientSetupChange {
  const status = row.status as SetupChangeStatus;
  const direction = row.direction as SetupDirection;
  const kind = row.kind as SetupChangeKind;
  return {
    id: row.id,
    agentId: row.agentId,
    kind,
    kindLabel: SETUP_CHANGE_KIND_LABEL[kind] ?? "Setup",
    direction,
    directionSentence: setupDirectionSentence(direction, memberName),
    summary: row.summary,
    affects: row.affects,
    status,
    detail: row.detail,
    digest: setupChangeDigest({ id: row.id, agentId: row.agentId, kind: row.kind, after: row.after }),
    canApply: status === "proposed" || status === "declined" || status === "undone",
    canUndo: status === "applied",
    appliedAt: row.appliedAt?.toISOString() ?? null,
    undoneAt: row.undoneAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/** The member's current setup, as planning reads it. */
export async function setupSnapshot(userId: string, agent: Agent): Promise<SetupSnapshot> {
  const routines = await prisma.workSchedule.findMany({
    where: { userId, session: { userId, agentId: agent.id, deletedAt: null } },
    select: { id: true, name: true, enabled: true },
    orderBy: { createdAt: "asc" },
    take: 100,
  });
  return {
    name: agent.name,
    approvalMode: agentApprovalMode(agent.approvalMode),
    notify: agentNotifyLevel((agent as Agent & { notify?: string | null }).notify),
    connectorIds: agent.connectorIds,
    budgetMicroUsd: agent.budgetMicroUsd ?? null,
    model: agent.model,
    reasoningEffort: agent.reasoningEffort,
    routines,
  };
}

/**
 * Records a planned change. Idempotent on `callKey` (one per tool call in a
 * turn): a retried turn gets the row the first call made.
 */
export async function recordSetupChange(input: {
  userId: string;
  agentId: string;
  conversationId: string | null;
  userMessageId: string | null;
  callKey: string | null;
  plan: SetupPlan;
  status: SetupChangeStatus;
}): Promise<AgentSetupChange> {
  const existing = async () =>
    input.callKey
      ? prisma.agentSetupChange.findFirst({ where: { userId: input.userId, callKey: input.callKey } })
      : null;
  const found = await existing();
  if (found) return found;
  return prisma.agentSetupChange
    .create({
      data: {
        userId: input.userId,
        agentId: input.agentId,
        conversationId: input.conversationId,
        userMessageId: input.userMessageId,
        callKey: input.callKey,
        kind: input.plan.kind,
        direction: input.plan.direction,
        summary: input.plan.summary,
        affects: input.plan.affects,
        before: input.plan.before as Prisma.InputJsonValue,
        after: input.plan.after as Prisma.InputJsonValue,
        status: input.status,
      },
    })
    .catch(async (err: unknown) => {
      // Two attempts of the same call raced past the read above: the unique
      // (userId, callKey) let one in, and the other answers with its row.
      const code = (err as { code?: unknown } | null)?.code;
      const winner = code === "P2002" ? await existing() : null;
      if (winner) return winner;
      throw err;
    });
}

export async function findSetupChange(userId: string, agentId: string, changeId: string): Promise<AgentSetupChange | null> {
  return prisma.agentSetupChange.findFirst({ where: { id: changeId, userId, agentId } });
}

export type SetupChangeOutcome =
  | { ok: true; change: AgentSetupChange }
  | { ok: false; status: number; code: string; message: string };

async function markFailed(change: AgentSetupChange, userId: string, message: string): Promise<SetupChangeOutcome> {
  const updated = await prisma.agentSetupChange.update({
    where: { id: change.id, userId },
    data: { status: "failed", detail: message.slice(0, 500) },
  });
  return { ok: false, status: 409, code: "apply_failed", message: updated.detail ?? message };
}

/**
 * Writes a change. The caller has already settled whether it may (see the
 * file's header). Guarded by status, so two Apply presses apply once.
 */
export async function applySetupChange(
  user: AgentActor,
  change: AgentSetupChange,
  options: { approvalReceiptId?: string | null } = {}
): Promise<SetupChangeOutcome> {
  const claimed = await prisma.agentSetupChange.updateMany({
    where: { id: change.id, userId: user.id, status: { in: ["proposed", "awaiting_approval", "declined", "undone"] } },
    data: { status: "applied", appliedAt: new Date(), undoneAt: null, detail: null, ...(options.approvalReceiptId ? { approvalReceiptId: options.approvalReceiptId } : {}) },
  });
  if (claimed.count !== 1) {
    const current = await prisma.agentSetupChange.findFirst({ where: { id: change.id, userId: user.id } });
    if (current?.status === "applied") return { ok: true, change: current };
    return { ok: false, status: 409, code: "not_applicable", message: "That change can no longer be applied." };
  }

  const agents = await import("@/lib/agents/store");
  const agent = await agents.findAgent(user.id, change.agentId);
  if (!agent) return markFailed(change, user.id, "That crew member no longer exists.");
  const after = objectOf(change.after);
  let written: Record<string, unknown> = {};
  try {
    switch (change.kind as SetupChangeKind) {
      case "notify":
      case "approval_mode":
      case "budget":
      case "model": {
        const patch = patchFor(change.kind as SetupChangeKind, after);
        const parsed = patchAgentSchema.safeParse(patch);
        if (!parsed.success) return markFailed(change, user.id, "That change could not be read.");
        const result = await agents.updateAgentForUser(user, agent.id, parsed.data);
        if (result.status !== 200) return markFailed(change, user.id, String(result.body.message ?? "It could not be saved."));
        break;
      }
      case "apps_add":
      case "apps_remove": {
        // The change's own apps against the member's apps NOW, never the list
        // it was planned against: a card applied later must not put back an
        // app the person removed in between (`appsAtApply`).
        const kind = change.kind as "apps_add" | "apps_remove";
        const apps = stringList(kind === "apps_add" ? after.added : after.removed);
        if (apps.length === 0) return markFailed(change, user.id, "That change could not be read.");
        const delta = appsAtApply({ kind, current: agent.connectorIds, apps });
        const parsed = patchAgentSchema.safeParse({ connectorIds: delta.connectorIds });
        if (!parsed.success) return markFailed(change, user.id, "That change could not be read.");
        const result = await agents.updateAgentForUser(user, agent.id, parsed.data);
        if (result.status !== 200) return markFailed(change, user.id, String(result.body.message ?? "It could not be saved."));
        // What was actually saved: apps the account has not linked are left
        // out by `updateAgentForUser`, and Undo must know which ones stuck and
        // which this apply changed (not what was already there).
        const stuck = result.value?.connectorIds ?? [];
        written = {
          connectorIds: stuck,
          added: delta.added.filter((id) => stuck.includes(id)),
          removed: delta.removed,
        };
        break;
      }
      case "routine_add": {
        const routine = createRoutineSchema.safeParse(after.routine);
        if (!routine.success) return markFailed(change, user.id, "That routine could not be read.");
        const created = await agents.createAgentRoutine(user, agent, routine.data);
        if (created.status !== 201 || !created.value) {
          return markFailed(change, user.id, String(created.body.message ?? "The routine could not be created."));
        }
        written = { scheduleId: created.value.id, sessionId: created.value.sessionId };
        break;
      }
      case "routine_pause":
      case "routine_resume": {
        const scheduleId = typeof after.scheduleId === "string" ? after.scheduleId : "";
        const updated = await agents.updateAgentRoutine(user, agent, scheduleId, after.enabled === true);
        if (updated.status !== 200) return markFailed(change, user.id, String(updated.body.message ?? "The routine could not be changed."));
        break;
      }
      case "skill_draft": {
        const skill = objectOf((after.skill ?? {}) as Prisma.JsonValue);
        const created = await createDraftSkill(user.id, {
          name: String(skill.name ?? ""),
          description: String(skill.description ?? ""),
          instructions: String(skill.instructions ?? ""),
        });
        if (!created.ok) return markFailed(change, user.id, created.message);
        written = { skillId: created.skillId, slug: created.slug };
        break;
      }
      default:
        return markFailed(change, user.id, "Juno does not know that kind of change.");
    }
  } catch (err) {
    console.error("[agents] a setup change failed to apply", {
      changeId: change.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return markFailed(change, user.id, "Juno could not apply that change because of a problem on its side.");
  }

  const updated = await prisma.agentSetupChange.update({
    where: { id: change.id, userId: user.id },
    data: Object.keys(written).length > 0 ? { after: { ...after, applied: written } as Prisma.InputJsonValue } : {},
  });
  await agents.recordAgentEvent({
    userId: user.id,
    agentId: agent.id,
    kind: "setup_changed",
    title: change.summary,
    detail: { changeId: change.id, kind: change.kind, direction: change.direction, action: "applied" },
  });
  return { ok: true, change: updated };
}

function patchFor(kind: SetupChangeKind, after: Record<string, unknown>): Record<string, unknown> {
  switch (kind) {
    case "notify":
      return { notify: after.notify };
    case "approval_mode":
      return { approvalMode: after.approvalMode };
    case "budget":
      return { budgetMicroUsd: after.budgetMicroUsd ?? null };
    case "model":
      return { model: after.model ?? null, reasoningEffort: after.reasoningEffort ?? null };
    default:
      // Apps are never written as a stored list: see `appsAtApply`.
      return {};
  }
}

/**
 * A draft skill from the conversation: saved, scanned like every skill, and
 * switched OFF. Nothing selects it and nothing runs it until the person reads
 * it and turns it on.
 */
async function createDraftSkill(
  userId: string,
  input: { name: string; description: string; instructions: string }
): Promise<{ ok: true; skillId: string; slug: string } | { ok: false; message: string }> {
  const [{ createSkillWithFirstVersion }, { skillSlugFromName }] = await Promise.all([
    import("@/lib/skills/store"),
    import("@/lib/work/skills"),
  ]);
  const base = skillSlugFromName(input.name);
  if (!base) return { ok: false, message: "That skill name cannot become a slash name. Try a plainer one." };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = attempt === 0 ? base : `${base}-${attempt + 1}`.slice(0, 60);
    const created = await createSkillWithFirstVersion({
      userId,
      slug,
      name: input.name,
      description: input.description,
      instructions: input.instructions,
      origin: "authored",
      autoSelect: false,
    });
    if (!created.ok) continue;
    await prisma.workSkill.updateMany({
      where: { id: created.skill.id, userId },
      data: { enabled: false, autoSelect: false },
    });
    return { ok: true, skillId: created.skill.id, slug };
  }
  return { ok: false, message: "A skill with that name already exists. Try another name." };
}

/**
 * Puts a change back. The person presses Undo; the model never does.
 *
 * A scalar (notifications, approval, budget, model) is restored only while it
 * still holds what this change wrote: a later change the person made on
 * purpose is not overwritten by an old card. Apps are restored as the inverse
 * of what this change did, applied to whatever is there now.
 */
export async function undoSetupChange(user: AgentActor, change: AgentSetupChange): Promise<SetupChangeOutcome> {
  if (change.status !== "applied") {
    return { ok: false, status: 409, code: "not_undoable", message: "Only an applied change can be undone." };
  }
  const agents = await import("@/lib/agents/store");
  const agent = await agents.findAgent(user.id, change.agentId);
  if (!agent) return { ok: false, status: 404, code: "not_found", message: "That crew member no longer exists." };
  const before = objectOf(change.before);
  const after = objectOf(change.after);
  const applied = objectOf((after.applied ?? {}) as Prisma.JsonValue);
  const stale = { ok: false as const, status: 409, code: "changed_since", message: "That setting changed again since, so this card cannot put it back. Change it directly." };

  switch (change.kind as SetupChangeKind) {
    case "notify":
    case "approval_mode":
    case "budget":
    case "model": {
      const current = scalarState(change.kind as SetupChangeKind, agent);
      if (!scalarUndoIsCurrent(current, pickScalar(change.kind as SetupChangeKind, after))) return stale;
      const parsed = patchAgentSchema.safeParse(patchFor(change.kind as SetupChangeKind, before));
      if (!parsed.success) return { ok: false, status: 409, code: "not_undoable", message: "That change could not be read." };
      const result = await agents.updateAgentForUser(user, agent.id, parsed.data);
      if (result.status !== 200) return { ok: false, status: result.status, code: "undo_failed", message: String(result.body.message ?? "It could not be put back.") };
      break;
    }
    case "apps_add":
    case "apps_remove": {
      // What this apply changed (`applied.added` / `applied.removed`), so an
      // app the person already had, or added by hand since, is left alone.
      // Rows applied before those were recorded fall back to the plan.
      const stuck = stringList(applied.connectorIds);
      const added = Array.isArray(applied.added)
        ? stringList(applied.added)
        : stringList(after.added).filter((id) => stuck.includes(id));
      const removed = Array.isArray(applied.removed) ? stringList(applied.removed) : stringList(after.removed);
      const next = undoAppsDelta({ kind: change.kind as "apps_add" | "apps_remove", current: agent.connectorIds, added, removed });
      const result = await agents.updateAgentForUser(user, agent.id, { connectorIds: next });
      if (result.status !== 200) return { ok: false, status: result.status, code: "undo_failed", message: String(result.body.message ?? "It could not be put back.") };
      break;
    }
    case "routine_add": {
      const scheduleId = typeof applied.scheduleId === "string" ? applied.scheduleId : null;
      const sessionId = typeof applied.sessionId === "string" ? applied.sessionId : null;
      if (scheduleId) await prisma.workSchedule.deleteMany({ where: { id: scheduleId, userId: user.id } });
      if (sessionId) {
        await prisma.workSession.updateMany({
          where: { id: sessionId, userId: user.id, status: "draft", deletedAt: null },
          data: { deletedAt: new Date() },
        });
      }
      break;
    }
    case "routine_pause":
    case "routine_resume": {
      const scheduleId = typeof before.scheduleId === "string" ? before.scheduleId : "";
      const row = await prisma.workSchedule.findFirst({ where: { id: scheduleId, userId: user.id }, select: { enabled: true } });
      if (!row) return { ok: false, status: 404, code: "not_found", message: "That routine no longer exists." };
      if (row.enabled !== (after.enabled === true)) return stale;
      const updated = await agents.updateAgentRoutine(user, agent, scheduleId, before.enabled === true);
      if (updated.status !== 200) return { ok: false, status: updated.status, code: "undo_failed", message: String(updated.body.message ?? "It could not be put back.") };
      break;
    }
    case "skill_draft": {
      const skillId = typeof applied.skillId === "string" ? applied.skillId : null;
      if (skillId) {
        await prisma.workSkill.updateMany({
          where: { id: skillId, userId: user.id, deletedAt: null },
          data: { deletedAt: new Date(), enabled: false, autoSelect: false },
        });
      }
      break;
    }
  }

  const updated = await prisma.agentSetupChange.update({
    where: { id: change.id, userId: user.id },
    data: { status: "undone", undoneAt: new Date() },
  });
  await agents.recordAgentEvent({
    userId: user.id,
    agentId: agent.id,
    kind: "setup_changed",
    title: `Undone: ${change.summary}`,
    detail: { changeId: change.id, kind: change.kind, action: "undone" },
  });
  return { ok: true, change: updated };
}

function scalarState(kind: SetupChangeKind, agent: Agent): unknown {
  switch (kind) {
    case "notify":
      return { notify: agentNotifyLevel((agent as Agent & { notify?: string | null }).notify) };
    case "approval_mode":
      return { approvalMode: agentApprovalMode(agent.approvalMode) };
    case "budget":
      return { budgetMicroUsd: agent.budgetMicroUsd ?? null };
    case "model":
      return { model: agent.model, reasoningEffort: agent.reasoningEffort };
    default:
      return null;
  }
}

function pickScalar(kind: SetupChangeKind, after: Record<string, unknown>): unknown {
  switch (kind) {
    case "notify":
      return { notify: after.notify };
    case "approval_mode":
      return { approvalMode: after.approvalMode };
    case "budget":
      return { budgetMicroUsd: after.budgetMicroUsd ?? null };
    case "model":
      return { model: after.model ?? null, reasoningEffort: after.reasoningEffort ?? null };
    default:
      return null;
  }
}

/** Planning, re-exported for the tool so it reads one module. */
export { planSetupChange };
