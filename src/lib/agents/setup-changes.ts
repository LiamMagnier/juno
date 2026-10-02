/**
 * Setup by conversation: a crew member's setup changed because the person said
 * so in its thread (PRODUCT_REFOUNDATION.md §7, "Configured by talking").
 *
 * "Every weekday at 8, summarise escalations", "Connect Linear", "Only notify
 * me when you need a decision", "Learn how I triage these issues": each becomes
 * ONE structured change with a before and an after, what it affects, and which
 * way it moves the member's reach:
 *
 *   narrowing  fewer notifications, a stricter approval mode, an app removed, a
 *              routine paused, a lower budget. Applies at once; Undo restores.
 *   widening   an app added, a looser approval mode, a higher (or no) budget, a
 *              routine added or resumed (it spends on every run, whatever its
 *              approval mode), a different model. Applies only after the person
 *              answers a deterministic approval card.
 *   neutral    more notifications, a draft skill (off until the person turns it
 *              on). Applies at once; Undo restores.
 *
 * The direction is decided HERE, from the member's current setup and the
 * request, never by the model: a model that calls "Connect Linear" narrowing
 * is still asked. Everything in this file is pure and is tested in
 * `tests/agents-setup-changes.test.ts`; the store
 * (src/lib/agents/setup-changes-store.ts) applies and undoes.
 */

import { createHash } from "node:crypto";
import {
  AGENT_NOTIFY_LEVELS,
  AGENT_ROUTINE_CADENCE_LABEL,
  agentModelChoice,
  agentReasoningEffort,
  createRoutineSchema,
  type AgentNotifyLevel,
  type CreateRoutineInput,
} from "@/lib/agents/domain";
import { MAX_MEMBER_BUDGET_MICRO_USD, formatBudget } from "@/lib/agents/budget";
import {
  WORK_APPROVAL_MODE_LABEL,
  WORK_PERMISSION_POLICIES,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";
import { PRODUCT_NAME } from "@/lib/brand/names";

export const SETUP_CHANGE_KINDS = [
  "notify",
  "approval_mode",
  "apps_add",
  "apps_remove",
  "routine_add",
  "routine_pause",
  "routine_resume",
  "budget",
  "model",
  "skill_draft",
] as const;
export type SetupChangeKind = (typeof SETUP_CHANGE_KINDS)[number];

export const SETUP_DIRECTIONS = ["narrowing", "widening", "neutral"] as const;
export type SetupDirection = (typeof SETUP_DIRECTIONS)[number];

export const SETUP_CHANGE_STATUSES = [
  /** Planned, not applied: a widening change whose approval expired or was never answered. */
  "proposed",
  /** A widening change waiting on the approval card. */
  "awaiting_approval",
  "applied",
  /** The person said no to the approval card. */
  "declined",
  "undone",
  /** Applying it failed; `detail` says why. */
  "failed",
] as const;
export type SetupChangeStatus = (typeof SETUP_CHANGE_STATUSES)[number];

/** The kind as a person reads it on the card. */
export const SETUP_CHANGE_KIND_LABEL: Record<SetupChangeKind, string> = {
  notify: "Notifications",
  approval_mode: "Approval",
  apps_add: "Apps",
  apps_remove: "Apps",
  routine_add: "Routine",
  routine_pause: "Routine",
  routine_resume: "Routine",
  budget: "Budget",
  model: "Model",
  skill_draft: "Skill",
};

/** What the member looks like now, as much as planning a change needs. */
export interface SetupSnapshot {
  name: string;
  approvalMode: WorkPermissionPolicy;
  notify: AgentNotifyLevel;
  connectorIds: readonly string[];
  budgetMicroUsd: number | null;
  model: string | null;
  reasoningEffort: string | null;
  routines: readonly { id: string; name: string; enabled: boolean }[];
}

export interface SetupChangeItem {
  label: string;
  from?: string;
  to: string;
}

export interface SetupPlan {
  kind: SetupChangeKind;
  direction: SetupDirection;
  /** One sentence: what changes. */
  summary: string;
  /** One sentence: what it affects. */
  affects: string;
  /** What Undo restores. JSON, stored as is. */
  before: Record<string, unknown>;
  /** What Apply writes. JSON, stored as is. */
  after: Record<string, unknown>;
  /** The card's rows: label, from → to. */
  changes: SetupChangeItem[];
}

export type SetupPlanResult = { ok: true; plan: SetupPlan } | { ok: false; reason: string; message: string };

const NOTIFY_RANK: Record<AgentNotifyLevel, number> = { needs_you: 0, results: 1, all: 2 };
const NOTIFY_LABEL: Record<AgentNotifyLevel, string> = {
  needs_you: "Only when it needs you",
  results: "When a task finishes or needs you",
  all: "Everything, ideas included",
};
const MODE_RANK: Record<WorkPermissionPolicy, number> = { conservative: 0, balanced: 1, permissive: 2 };

/** The limits a request is held to before anything is planned. */
export const MAX_SETUP_APPS = 16;
export const MAX_SKILL_NAME_CHARS = 60;
export const MAX_SKILL_DESCRIPTION_CHARS = 300;
export const MAX_SKILL_INSTRUCTIONS_CHARS = 8_000;

function refuse(reason: string, message: string): SetupPlanResult {
  return { ok: false, reason, message };
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function appList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const ids = raw
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0 && value.length <= 120);
  return [...new Set(ids)].slice(0, MAX_SETUP_APPS);
}

function listOrNone(ids: readonly string[]): string {
  return ids.length > 0 ? ids.join(", ") : "None";
}

function findRoutine(
  snapshot: SetupSnapshot,
  wanted: string
): { id: string; name: string; enabled: boolean } | null {
  const key = wanted.trim().toLowerCase();
  if (!key) return null;
  return (
    snapshot.routines.find((routine) => routine.id === wanted.trim()) ??
    snapshot.routines.find((routine) => routine.name.trim().toLowerCase() === key) ??
    null
  );
}

function clock(input: Pick<CreateRoutineInput, "cadence" | "hour" | "minute" | "weekday" | "monthday" | "timezone">): string {
  const time = `${String(input.hour).padStart(2, "0")}:${String(input.minute).padStart(2, "0")}`;
  const day =
    input.cadence === "weekly"
      ? ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][input.weekday ?? 1]
      : null;
  const when =
    input.cadence === "hourly"
      ? `Every hour at :${String(input.minute).padStart(2, "0")}`
      : input.cadence === "weekly"
        ? `Every ${day} at ${time}`
        : input.cadence === "monthly"
          ? `Monthly on day ${input.monthday ?? 1} at ${time}`
          : `${AGENT_ROUTINE_CADENCE_LABEL[input.cadence]} at ${time}`;
  return `${when} (${input.timezone})`;
}

/**
 * Whether a routine can act without asking: its tasks run under the member's
 * approval mode, and only "Just do it" lets a step that changes something go
 * ahead unattended. Under the other two, anything that changes something waits
 * for the person. That decides what the card says a routine affects, not its
 * direction: a routine spends on every run under any mode, and spending is
 * reach (PRODUCT_REFOUNDATION §7), so adding or resuming one always asks.
 */
export function routineActsWithoutAsking(mode: WorkPermissionPolicy): boolean {
  return mode === "permissive";
}

/**
 * One request, planned against the member as it is now.
 *
 * Refuses a request that changes nothing ("already") rather than recording a
 * no-op, and one it cannot read. Never touches anything: the store applies.
 */
export function planSetupChange(
  kind: string,
  args: Record<string, unknown>,
  snapshot: SetupSnapshot,
  options: {
    timeZone?: string;
    /**
     * The apps the account has linked, for `apps_add`. An app nobody linked is
     * refused with a sentence that says where to connect it, rather than
     * planned as a change that would save nothing.
     */
    linkedApps?: readonly string[];
  } = {}
): SetupPlanResult {
  const name = snapshot.name.trim() || "This agent";
  switch (kind) {
    case "notify": {
      const level = str(args, "level");
      if (!(AGENT_NOTIFY_LEVELS as readonly string[]).includes(level)) {
        return refuse("invalid_arguments", "Say which notifications: needs_you, results or all.");
      }
      const next = level as AgentNotifyLevel;
      if (next === snapshot.notify) return refuse("unchanged", `${name} already notifies you that way.`);
      return {
        ok: true,
        plan: {
          kind,
          direction: NOTIFY_RANK[next] < NOTIFY_RANK[snapshot.notify] ? "narrowing" : "neutral",
          summary: `${name} will notify you: ${NOTIFY_LABEL[next].toLowerCase()}.`,
          affects: `Which of ${name}'s notifications reach you. What it can do does not change.`,
          before: { notify: snapshot.notify },
          after: { notify: next },
          changes: [{ label: "Notifications", from: NOTIFY_LABEL[snapshot.notify], to: NOTIFY_LABEL[next] }],
        },
      };
    }
    case "approval_mode": {
      const mode = str(args, "mode");
      if (!(WORK_PERMISSION_POLICIES as readonly string[]).includes(mode)) {
        return refuse("invalid_arguments", "Say which approval mode: conservative, balanced or permissive.");
      }
      const next = mode as WorkPermissionPolicy;
      if (next === snapshot.approvalMode) return refuse("unchanged", `${name} already works that way.`);
      const looser = MODE_RANK[next] > MODE_RANK[snapshot.approvalMode];
      return {
        ok: true,
        plan: {
          kind,
          direction: looser ? "widening" : "narrowing",
          summary: `${name}'s tasks will ${WORK_APPROVAL_MODE_LABEL[next].charAt(0).toLowerCase()}${WORK_APPROVAL_MODE_LABEL[next].slice(1)}.`,
          affects: `What ${name}'s tasks may do without asking you. Sending, publishing, paying, deleting and account changes always ask.`,
          before: { approvalMode: snapshot.approvalMode },
          after: { approvalMode: next },
          changes: [
            { label: "Approval", from: WORK_APPROVAL_MODE_LABEL[snapshot.approvalMode], to: WORK_APPROVAL_MODE_LABEL[next] },
          ],
        },
      };
    }
    case "apps_add": {
      const wanted = appList(args.apps);
      const added = wanted.filter((id) => !snapshot.connectorIds.includes(id));
      if (wanted.length === 0) return refuse("invalid_arguments", "Name the apps to add.");
      if (added.length === 0) return refuse("unchanged", `${name} can already use ${listOrNone(wanted)}.`);
      if (options.linkedApps) {
        const linked = new Set(options.linkedApps);
        const missing = added.filter((id) => !linked.has(id));
        if (missing.length > 0) {
          return refuse(
            "not_connected",
            `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not connected to your account yet. Connect ${missing.length === 1 ? "it" : "them"} in Apps first, then ask again.`
          );
        }
      }
      const next = [...snapshot.connectorIds, ...added];
      return {
        ok: true,
        plan: {
          kind,
          direction: "widening",
          summary: `${name} will be able to use ${added.join(", ")}.`,
          affects: `What ${name}'s tasks can read and change in ${added.join(", ")}, under its approval mode.`,
          before: { connectorIds: [...snapshot.connectorIds] },
          after: { connectorIds: next, added },
          changes: [{ label: "Apps", from: listOrNone(snapshot.connectorIds), to: listOrNone(next) }],
        },
      };
    }
    case "apps_remove": {
      const wanted = appList(args.apps);
      const removed = wanted.filter((id) => snapshot.connectorIds.includes(id));
      if (wanted.length === 0) return refuse("invalid_arguments", "Name the apps to remove.");
      if (removed.length === 0) return refuse("unchanged", `${name} does not use ${listOrNone(wanted)}.`);
      const next = snapshot.connectorIds.filter((id) => !removed.includes(id));
      return {
        ok: true,
        plan: {
          kind,
          direction: "narrowing",
          summary: `${name} will stop using ${removed.join(", ")}.`,
          affects: `${name}'s next tasks. A task already running keeps the apps it started with.`,
          before: { connectorIds: [...snapshot.connectorIds] },
          after: { connectorIds: next, removed },
          changes: [{ label: "Apps", from: listOrNone(snapshot.connectorIds), to: listOrNone(next) }],
        },
      };
    }
    case "routine_add": {
      const parsed = createRoutineSchema.safeParse({
        name: str(args, "name") || undefined,
        instructions: typeof args.instructions === "string" ? args.instructions.trim() : undefined,
        cadence: str(args, "cadence") || undefined,
        hour: typeof args.hour === "number" ? args.hour : undefined,
        minute: typeof args.minute === "number" ? args.minute : undefined,
        weekday: typeof args.weekday === "number" ? args.weekday : undefined,
        monthday: typeof args.monthday === "number" ? args.monthday : undefined,
        timezone: str(args, "timezone") || options.timeZone || "UTC",
      });
      if (!parsed.success) {
        return refuse("invalid_arguments", "A routine needs a name, what to do each time, and when (hourly, daily, weekdays, weekly or monthly).");
      }
      const routine = parsed.data;
      if (snapshot.routines.some((existing) => existing.name.trim().toLowerCase() === routine.name.trim().toLowerCase())) {
        return refuse("unchanged", `${name} already has a routine called "${routine.name}".`);
      }
      const unattended = routineActsWithoutAsking(snapshot.approvalMode);
      const when = clock(routine);
      return {
        ok: true,
        plan: {
          kind,
          // Always asks: every run spends, whatever the approval mode, and
          // spending is reach (as `agent_routine` always asked before it).
          direction: "widening",
          summary: `${name} will run "${routine.name}": ${when}.`,
          affects: unattended
            ? `A task that runs on its own and can change things without asking (approval: ${WORK_APPROVAL_MODE_LABEL[snapshot.approvalMode]}). Each run spends from ${name}'s budget and your usage windows.`
            : `A task that runs on its own in this thread and asks before it changes anything. Each run spends from ${name}'s budget and your usage windows.`,
          before: { routine: null },
          after: { routine: { ...routine } },
          changes: [{ label: "Routine", to: `${routine.name} · ${when}` }],
        },
      };
    }
    case "routine_pause":
    case "routine_resume": {
      const pausing = kind === "routine_pause";
      const routine = findRoutine(snapshot, str(args, "routine") || str(args, "name"));
      if (!routine) return refuse("not_found", `${name} has no routine by that name.`);
      if (routine.enabled === !pausing) {
        return refuse("unchanged", `"${routine.name}" is already ${pausing ? "paused" : "running"}.`);
      }
      const unattended = routineActsWithoutAsking(snapshot.approvalMode);
      return {
        ok: true,
        plan: {
          kind,
          // Resuming starts the spending again, so it asks like adding one.
          direction: pausing ? "narrowing" : "widening",
          summary: pausing ? `"${routine.name}" will stop running until you resume it.` : `"${routine.name}" will run again on its schedule.`,
          affects: pausing
            ? `Only this routine. ${name} keeps everything else.`
            : unattended
              ? `A task that runs on its own and can change things without asking.`
              : `A task that runs on its own and asks before it changes anything.`,
          before: { scheduleId: routine.id, name: routine.name, enabled: routine.enabled },
          after: { scheduleId: routine.id, name: routine.name, enabled: !pausing },
          changes: [{ label: `Routine (${routine.name})`, from: pausing ? "Running" : "Paused", to: pausing ? "Paused" : "Running" }],
        },
      };
    }
    case "budget": {
      const clear = args.noBudget === true || args.budgetUsd === null;
      const usd = typeof args.budgetUsd === "number" && Number.isFinite(args.budgetUsd) ? args.budgetUsd : null;
      if (!clear && (usd === null || usd < 0)) {
        return refuse("invalid_arguments", "Say the weekly budget in dollars, or that there should be none.");
      }
      const asked = clear ? null : Math.round((usd ?? 0) * 1_000_000);
      if (asked !== null && asked > MAX_MEMBER_BUDGET_MICRO_USD) {
        // Refused rather than quietly lowered: the card must say what the
        // person asked for, and the column cannot hold more.
        return refuse(
          "invalid_arguments",
          `The largest weekly budget an agent can have is ${formatBudget(MAX_MEMBER_BUDGET_MICRO_USD)}. For more, remove ${name}'s own budget so only your usage windows apply.`
        );
      }
      const next = asked;
      if (next === snapshot.budgetMicroUsd) return refuse("unchanged", `${name}'s budget is already that.`);
      const label = (value: number | null) => (value === null ? "No budget of its own" : `${formatBudget(value)} a week`);
      // No cap is the widest; any cap narrows it; between two caps the bigger is wider.
      const widening =
        next === null ? true : snapshot.budgetMicroUsd === null ? false : next > snapshot.budgetMicroUsd;
      return {
        ok: true,
        plan: {
          kind,
          direction: widening ? "widening" : "narrowing",
          summary:
            next === null
              ? `${name} will have no budget of its own, only your usage windows.`
              : `${name} will spend at most ${formatBudget(next)} a week.`,
          affects: `How much ${name}'s tasks and routines may spend each week, inside your own usage windows.`,
          before: { budgetMicroUsd: snapshot.budgetMicroUsd },
          after: { budgetMicroUsd: next },
          changes: [{ label: "Budget", from: label(snapshot.budgetMicroUsd), to: label(next) }],
        },
      };
    }
    case "model": {
      const rawModel = str(args, "model");
      const model = rawModel ? agentModelChoice(rawModel) : null;
      if (rawModel && !model) return refuse("invalid_arguments", `That is not a chat model ${PRODUCT_NAME} offers.`);
      const rawEffort = str(args, "reasoningEffort");
      const effort = rawEffort ? agentReasoningEffort(rawEffort) : null;
      if (rawEffort && !effort) return refuse("invalid_arguments", `That is not a reasoning effort ${PRODUCT_NAME} offers.`);
      const nextModel = model ?? snapshot.model;
      const nextEffort = effort ?? snapshot.reasoningEffort;
      if (!model && !effort) return refuse("invalid_arguments", "Name a model or a reasoning effort.");
      if (nextModel === snapshot.model && nextEffort === snapshot.reasoningEffort) {
        return refuse("unchanged", `${name} already uses that.`);
      }
      const changes: SetupChangeItem[] = [];
      if (nextModel !== snapshot.model) changes.push({ label: "Model", from: snapshot.model ?? "Your default", to: nextModel ?? "Your default" });
      if (nextEffort !== snapshot.reasoningEffort) {
        changes.push({ label: "Reasoning effort", from: snapshot.reasoningEffort ?? "Default", to: nextEffort ?? "Default" });
      }
      return {
        ok: true,
        plan: {
          kind,
          // A model is a cost decision the person makes, so it asks either way.
          direction: "widening",
          summary: `${name} will answer and work with ${nextModel ?? "your default model"}${nextEffort ? ` at ${nextEffort} effort` : ""}.`,
          affects: `What ${name}'s replies, tasks and routines cost and how they reason.`,
          before: { model: snapshot.model, reasoningEffort: snapshot.reasoningEffort },
          after: { model: nextModel, reasoningEffort: nextEffort },
          changes,
        },
      };
    }
    case "skill_draft": {
      const skillName = str(args, "skillName").slice(0, MAX_SKILL_NAME_CHARS);
      const description = str(args, "skillDescription").slice(0, MAX_SKILL_DESCRIPTION_CHARS);
      const instructions =
        typeof args.skillInstructions === "string" ? args.skillInstructions.trim().slice(0, MAX_SKILL_INSTRUCTIONS_CHARS) : "";
      if (!skillName || !instructions) {
        return refuse("invalid_arguments", "A skill needs a name and the method, written out step by step.");
      }
      return {
        ok: true,
        plan: {
          kind,
          direction: "neutral",
          summary: `A draft skill "${skillName}" will be saved from this conversation.`,
          affects: "Nothing yet. The draft stays off until you read it and turn it on in Skills.",
          before: { skillId: null },
          after: { skill: { name: skillName, description: description || skillName, instructions } },
          changes: [{ label: "Skill", to: `${skillName} (draft, off)` }],
        },
      };
    }
    default:
      return refuse("invalid_arguments", `"${kind}" is not a setup change ${PRODUCT_NAME} knows.`);
  }
}

/**
 * The digest the card's Apply is bound to: the change's identity and exactly
 * what it will write. An Apply sent for a card that showed something else (a
 * stale tab, a change rewritten since) does not match and is refused.
 */
export function setupChangeDigest(change: { id: string; agentId: string; kind: string; after: unknown }): string {
  return createHash("sha256")
    .update("juno-setup-change-v1\0")
    .update(canonicalJson({ id: change.id, agentId: change.agentId, kind: change.kind, after: change.after }))
    .digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * The idempotency key of one `propose_setup_change` call: the user turn, the
 * call's place in it, and exactly what the call asks to write.
 *
 * What it writes is part of the key on purpose. A retried turn that asks for
 * the same change meets the row its first attempt recorded; a retried turn
 * whose model asks for something else gets a row of its own. Keyed on the turn
 * and the kind alone, the second request was answered with the first one's
 * row, so a narrowing request could apply a widening change the person had
 * just declined.
 */
export function setupChangeCallKey(input: {
  userMessageId: string;
  seq: number;
  plan: Pick<SetupPlan, "kind" | "after">;
}): string {
  const digest = createHash("sha256")
    .update("juno-setup-call-v1\0")
    .update(canonicalJson({ kind: input.plan.kind, after: input.plan.after }))
    .digest("hex")
    .slice(0, 24);
  return `setup:${input.userMessageId}:${input.seq}:${digest}`;
}

/** What the tool does next with a change it recorded, or found recorded for this call. */
export type SetupChangeStep = "apply" | "ask" | "report";

/**
 * The tool's next step, read from the recorded row and today's plan, never
 * from the model.
 *
 * Widening wins when either says so: a change recorded under one setup and
 * planned wider under today's is asked about, not applied. Only a
 * change nobody has decided yet moves. A row the person applied, declined or
 * undid, or one that failed, is reported as it stands: a retried turn is not
 * the person asking again, and the card's Apply is how they do that.
 */
export function setupChangeNextStep(input: {
  rowStatus: string;
  rowDirection: string;
  planDirection: SetupDirection;
}): SetupChangeStep {
  const widening = input.rowDirection === "widening" || input.planDirection === "widening";
  if (input.rowStatus === "proposed" || input.rowStatus === "awaiting_approval") return widening ? "ask" : "apply";
  return "report";
}

/**
 * The apps a change writes, worked out against the member's apps as they are
 * when it applies, not as they were when it was planned: `apps_add` adds its
 * apps to whatever is there, `apps_remove` takes its apps away.
 *
 * Writing the planned list instead reverted every app change made in between:
 * a card applied a day later put back an app the person had removed that
 * morning, a widening nobody approved. `added` and `removed` are only what this
 * apply actually changed, so Undo takes back exactly that and nothing the
 * person did by hand.
 */
export function appsAtApply(input: {
  kind: "apps_add" | "apps_remove";
  current: readonly string[];
  apps: readonly string[];
}): { connectorIds: string[]; added: string[]; removed: string[] } {
  const current = [...new Set(input.current)];
  if (input.kind === "apps_add") {
    const added = [...new Set(input.apps)].filter((id) => !current.includes(id));
    return { connectorIds: [...current, ...added], added, removed: [] };
  }
  const drop = new Set(input.apps);
  return {
    connectorIds: current.filter((id) => !drop.has(id)),
    added: [],
    removed: current.filter((id) => drop.has(id)),
  };
}

/** What the card says about the direction, in one line. */
export function setupDirectionSentence(direction: SetupDirection, name: string): string {
  const who = name.trim() || "This agent";
  switch (direction) {
    case "narrowing":
      return `Narrows what ${who} can do. Applied at once; Undo puts it back.`;
    case "widening":
      return `Widens what ${who} can do, so it waits for your approval.`;
    case "neutral":
    default:
      return `Applied at once; Undo puts it back.`;
  }
}

/**
 * Whether a scalar setting can still be undone: only while it still holds the
 * value this change wrote. If it was changed again since, Undo would overwrite
 * that later decision, which is not what the person pressed.
 */
export function scalarUndoIsCurrent(current: unknown, applied: unknown): boolean {
  return canonicalJson(current ?? null) === canonicalJson(applied ?? null);
}

/** The apps an Undo restores: the inverse of what the change did, applied to what is there now. */
export function undoAppsDelta(input: {
  kind: "apps_add" | "apps_remove";
  current: readonly string[];
  added?: readonly string[];
  removed?: readonly string[];
}): string[] {
  if (input.kind === "apps_add") {
    const drop = new Set(input.added ?? []);
    return input.current.filter((id) => !drop.has(id));
  }
  return [...new Set([...input.current, ...(input.removed ?? [])])];
}
