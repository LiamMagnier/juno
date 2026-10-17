/**
 * A routine drafted in chat, before anybody has agreed to it.
 *
 * "Every weekday at 8am, summarise my inbox" used to reach `start_task`, which
 * runs once: the person was told something recurring had been set up and
 * nothing ever ran again. The model now has `propose_routine`, and this module
 * is everything about a proposal that can be decided without a request:
 *
 *   - admission: whether a draft may be put in front of the person at all, and
 *     the sentence it is refused with when not (`admitRoutineProposal`);
 *   - the proposal as the transcript carries it (`ClientRoutineProposal`), and
 *     the field-by-field reader the message serializer uses on reload;
 *   - the body the card POSTs when the person presses Schedule
 *     (`routineScheduleBody`), so what the card showed is what is created.
 *
 * NOTHING HERE CREATES ANYTHING. A proposal is a card with Schedule, Edit and
 * Not now; only the person's press on Schedule writes a `WorkSchedule`, through
 * the same route and the same checks the routine editor uses. The proposal key
 * rides along so a double press, or a press after a reload, lands on the
 * routine the first press made instead of a second one.
 *
 * Pure and client-safe: the card imports the types and the body builder.
 */

import { isValidTimeZone, type JsonObject } from "@/lib/work/schedule";
import {
  describeTimeTrigger,
  parseSchedulePhrase,
  upcomingFires,
  type PhraseTriggerKind,
} from "@/lib/work/schedule-phrase";

export const PROPOSE_ROUTINE_TOOL_ID = "propose_routine";

/** The most proposals one reply may put on screen. More is a model looping. */
export const MAX_PROPOSALS_PER_TURN = 3;

/** createScheduleSchema's own bounds, repeated so the card is refused before the route is. */
export const MAX_ROUTINE_NAME_CHARS = 120;
export const MAX_ROUTINE_INSTRUCTIONS_CHARS = 8_000;
const MAX_APPS = 12;

/**
 * The most a proposal may set as its own per-run ceiling. A model asked for
 * "a cheap daily check" must not be able to write $500 into a card somebody
 * presses without reading; above this the person types it in the editor.
 */
export const MAX_PROPOSAL_RUN_BUDGET_MICRO_USD = 25_000_000;
/** The floor of the default ceiling: one dollar a run. */
const MIN_DEFAULT_RUN_BUDGET_MICRO_USD = 1_000_000;

export const ROUTINE_PROPOSAL_NOTIFY = ["on_finish", "on_attention"] as const;
export type RoutineProposalNotify = (typeof ROUTINE_PROPOSAL_NOTIFY)[number];

export interface RoutineProposalApp {
  id: string;
  label: string;
}

/** A routine as the transcript carries it, on a `kind: "tool"` activity row. */
export interface ClientRoutineProposal {
  version: 1;
  /** Stable per proposal; sent with Schedule so a repeat press is a replay. */
  key: string;
  name: string;
  instructions: string;
  schedule: {
    /** What the model (or the person) wrote. */
    phrase: string;
    kind: PhraseTriggerKind;
    config: JsonObject;
    /** "Every weekday at 08:00". */
    summary: string;
    /** No clock time was given; the card says so. */
    assumedTime: boolean;
  };
  timezone: string;
  /** The next three fires, ISO, as they were when the card was drawn. */
  nextRuns: string[];
  /** Connected apps the routine may use. Empty means every app the account has connected. */
  apps: RoutineProposalApp[];
  /** Apps the request named that are not connected, so the card can say so. */
  missingApps: string[];
  /** This routine's own per-run ceiling. */
  maxCostMicroUsd: number;
  /** A warning estimate of one run, or null when there is no basis for one. */
  estimatedCostMicroUsd: number | null;
  notifyPolicy: RoutineProposalNotify;
  /** Drafted in a turn that read outside content: the card asks for a careful read. */
  fromOutsideContent: boolean;
  createdAt: string;
}

export interface RoutineProposalContext {
  key: string;
  now: Date;
  /** The person's zone from the client (`ChatRequestBody.timeZone`). */
  defaultTimezone: string | null | undefined;
  /** The apps connected and enabled for this turn. */
  connectors: readonly RoutineProposalApp[];
  /** Outside content (a page, a file, a tool result) is in this turn. */
  untrusted: boolean;
  /** The turn's own reading says that content is hostile. */
  hostile?: boolean;
  /** One run's warning estimate for these instructions. */
  estimateCostMicroUsd?: (instructions: string) => number | null;
}

export const ROUTINE_PROPOSAL_REFUSALS = {
  invalid_arguments: "A routine needs a name, what it should do, and when it runs. Nothing was proposed.",
  instructions_too_long: "Those instructions are too long for a routine. Nothing was proposed.",
  outside_content: "This turn read content that tried to set something up, so no routine was proposed.",
  too_many: "Three routines have already been proposed in this reply. Nothing more was proposed.",
} as const;

export type RoutineProposalRefusal =
  | keyof typeof ROUTINE_PROPOSAL_REFUSALS
  | "schedule_empty"
  | "schedule_not_recurring"
  | "schedule_too_frequent"
  | "schedule_unrecognised";

export type RoutineProposalAdmission =
  | { ok: true; proposal: ClientRoutineProposal }
  | { ok: false; reason: RoutineProposalRefusal; message: string };

function oneLine(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function clipWords(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return (space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "");
}

function matchApps(
  requested: unknown,
  connectors: readonly RoutineProposalApp[]
): { apps: RoutineProposalApp[]; missing: string[] } {
  if (!Array.isArray(requested)) return { apps: [], missing: [] };
  const apps = new Map<string, RoutineProposalApp>();
  const missing = new Set<string>();
  for (const raw of requested.slice(0, MAX_APPS)) {
    const wanted = oneLine(raw).toLowerCase();
    if (!wanted) continue;
    const squash = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const found = connectors.find(
      (connector) =>
        connector.id.toLowerCase() === wanted ||
        connector.label.toLowerCase() === wanted ||
        squash(connector.id) === squash(wanted) ||
        squash(connector.label) === squash(wanted)
    );
    if (found) apps.set(found.id, { id: found.id, label: found.label });
    else missing.add(clipWords(oneLine(raw), 40));
  }
  return { apps: [...apps.values()], missing: [...missing] };
}

/** Rounds a dollar amount in micro-dollars up to the next quarter. */
function upToQuarter(microUsd: number): number {
  const quarter = 250_000;
  return Math.ceil(microUsd / quarter) * quarter;
}

/**
 * The ceiling a proposal carries when the request named none: three times the
 * warning estimate, at least a dollar, never above the proposal cap. A routine
 * with no ceiling of its own is bounded only by the account's window, which is
 * the right default for a form a person filled in and the wrong one for a card
 * a model filled in.
 */
export function defaultRunBudget(estimatedCostMicroUsd: number | null): number {
  const base = estimatedCostMicroUsd === null ? MIN_DEFAULT_RUN_BUDGET_MICRO_USD : upToQuarter(estimatedCostMicroUsd * 3);
  return Math.min(MAX_PROPOSAL_RUN_BUDGET_MICRO_USD, Math.max(MIN_DEFAULT_RUN_BUDGET_MICRO_USD, base));
}

/** A ceiling typed in dollars, or null when it is not one. */
export function runBudgetFromUsd(value: unknown): number | null {
  const usd = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(usd) || usd <= 0) return null;
  return Math.min(MAX_PROPOSAL_RUN_BUDGET_MICRO_USD, Math.round(usd * 1_000_000));
}

const SCHEDULE_REFUSAL: Record<string, RoutineProposalRefusal> = {
  empty: "schedule_empty",
  not_recurring: "schedule_not_recurring",
  too_frequent: "schedule_too_frequent",
  unrecognised: "schedule_unrecognised",
};

/**
 * Whether the model's draft may become a card, and the card if so.
 *
 * Refused: a draft missing its name, instructions or schedule; a schedule that
 * does not repeat, repeats more than hourly or cannot be read; and any draft
 * from a turn whose outside content was judged hostile. A turn that merely read
 * outside content still gets its card, marked, because nothing is created
 * until the person presses Schedule on a card that shows the instructions in
 * full.
 */
export function admitRoutineProposal(
  args: Record<string, unknown>,
  ctx: RoutineProposalContext
): RoutineProposalAdmission {
  if (ctx.hostile) return { ok: false, reason: "outside_content", message: ROUTINE_PROPOSAL_REFUSALS.outside_content };

  const name = clipWords(oneLine(args.name), MAX_ROUTINE_NAME_CHARS);
  const instructions = typeof args.instructions === "string" ? args.instructions.trim() : "";
  const phrase = oneLine(args.schedule);
  if (!name || !instructions || !phrase) {
    return { ok: false, reason: "invalid_arguments", message: ROUTINE_PROPOSAL_REFUSALS.invalid_arguments };
  }
  if (instructions.length > MAX_ROUTINE_INSTRUCTIONS_CHARS) {
    return { ok: false, reason: "instructions_too_long", message: ROUTINE_PROPOSAL_REFUSALS.instructions_too_long };
  }

  const parsed = parseSchedulePhrase(phrase);
  if (!parsed.ok) {
    return { ok: false, reason: SCHEDULE_REFUSAL[parsed.reason] ?? "schedule_unrecognised", message: parsed.message };
  }

  const requestedZone = oneLine(args.timezone);
  const timezone =
    requestedZone && isValidTimeZone(requestedZone)
      ? requestedZone
      : ctx.defaultTimezone && isValidTimeZone(ctx.defaultTimezone)
        ? ctx.defaultTimezone
        : "UTC";

  const { apps, missing } = matchApps(args.apps, ctx.connectors);
  const estimate = ctx.estimateCostMicroUsd?.(instructions) ?? null;
  const asked = runBudgetFromUsd(args.maxCostUsd);
  const notifyPolicy: RoutineProposalNotify =
    args.notify === "on_attention" ? "on_attention" : "on_finish";

  return {
    ok: true,
    proposal: {
      version: 1,
      key: ctx.key,
      name,
      instructions,
      schedule: {
        phrase,
        kind: parsed.schedule.kind,
        config: parsed.schedule.config,
        summary: describeTimeTrigger(parsed.schedule.kind, parsed.schedule.config),
        assumedTime: parsed.schedule.assumedTime,
      },
      timezone,
      nextRuns: upcomingFires(parsed.schedule.kind, parsed.schedule.config, timezone, ctx.now, 3).map((d) => d.toISOString()),
      apps,
      missingApps: missing,
      maxCostMicroUsd: asked ?? defaultRunBudget(estimate),
      estimatedCostMicroUsd: estimate,
      notifyPolicy,
      fromOutsideContent: ctx.untrusted,
      createdAt: ctx.now.toISOString(),
    },
  };
}

// ---------------------------------------------------------------------------
// What the card sends
// ---------------------------------------------------------------------------

/** What the person may change on the card before pressing Schedule. */
export interface RoutineProposalEdits {
  name?: string;
  instructions?: string;
  schedule?: { kind: PhraseTriggerKind; config: JsonObject };
  timezone?: string;
  maxCostMicroUsd?: number;
  notifyPolicy?: RoutineProposalNotify;
}

/**
 * The POST /api/work/schedules body for a proposal.
 *
 * Cloud, always: a routine drafted in chat must not reach into one of the
 * person's Macs at seven in the morning without them having picked it in the
 * editor. Stop-and-wait when it meets something it cannot undo, which is the
 * safe unattended default. The person changes either in the editor.
 */
export function routineScheduleBody(
  proposal: ClientRoutineProposal,
  edits: RoutineProposalEdits = {}
): Record<string, unknown> {
  const schedule = edits.schedule ?? { kind: proposal.schedule.kind, config: proposal.schedule.config };
  return {
    name: (edits.name ?? proposal.name).trim(),
    instructions: (edits.instructions ?? proposal.instructions).trim(),
    timezone: edits.timezone ?? proposal.timezone,
    target: "cloud",
    enabled: true,
    triggers: [{ kind: schedule.kind, config: schedule.config, enabled: true }],
    unattendedPolicy: "pause_for_approval",
    hostOfflinePolicy: "skip",
    missedRunPolicy: "run_once",
    notifyPolicy: edits.notifyPolicy ?? proposal.notifyPolicy,
    maxConcurrentRuns: 1,
    budget: { maxCostMicroUsd: edits.maxCostMicroUsd ?? proposal.maxCostMicroUsd, maxTokens: 0, maxRuntimeMs: 0 },
    ...(proposal.apps.length > 0 ? { connectorIds: proposal.apps.map((app) => app.id) } : {}),
    proposalKey: proposal.key,
  };
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function isKind(value: unknown): value is PhraseTriggerKind {
  return (
    value === "hourly" ||
    value === "daily" ||
    value === "weekdays" ||
    value === "weekly" ||
    value === "monthly" ||
    value === "yearly" ||
    value === "cron"
  );
}

/**
 * A persisted proposal, field by field, or nothing. The message serializer is
 * a whitelist (src/lib/serializers.ts), and a row that does not match is
 * dropped here rather than handed to a card that trusts it.
 */
export function readRoutineProposal(raw: unknown): ClientRoutineProposal | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const key = text(r, "key");
  const name = text(r, "name");
  const instructions = text(r, "instructions");
  const timezone = text(r, "timezone");
  const schedule = r.schedule && typeof r.schedule === "object" && !Array.isArray(r.schedule)
    ? (r.schedule as Record<string, unknown>)
    : null;
  if (!key || !name || !instructions || !timezone || !schedule || !isKind(schedule.kind)) return undefined;
  const config = schedule.config && typeof schedule.config === "object" && !Array.isArray(schedule.config)
    ? (schedule.config as JsonObject)
    : null;
  if (!config) return undefined;
  const apps = Array.isArray(r.apps)
    ? r.apps.flatMap((app) => {
        if (!app || typeof app !== "object" || Array.isArray(app)) return [];
        const a = app as Record<string, unknown>;
        return typeof a.id === "string" && typeof a.label === "string" ? [{ id: a.id, label: a.label }] : [];
      })
    : [];
  const number = (key: string): number | null =>
    typeof r[key] === "number" && Number.isFinite(r[key]) ? (r[key] as number) : null;
  return {
    version: 1,
    key,
    name,
    instructions,
    schedule: {
      phrase: text(schedule, "phrase") ?? "",
      kind: schedule.kind,
      config,
      summary: text(schedule, "summary") ?? describeTimeTrigger(schedule.kind, config),
      assumedTime: schedule.assumedTime === true,
    },
    timezone,
    nextRuns: Array.isArray(r.nextRuns) ? r.nextRuns.filter((v): v is string => typeof v === "string").slice(0, 3) : [],
    apps,
    missingApps: Array.isArray(r.missingApps) ? r.missingApps.filter((v): v is string => typeof v === "string").slice(0, MAX_APPS) : [],
    maxCostMicroUsd: Math.max(0, Math.min(MAX_PROPOSAL_RUN_BUDGET_MICRO_USD, number("maxCostMicroUsd") ?? 0)),
    estimatedCostMicroUsd: number("estimatedCostMicroUsd"),
    notifyPolicy: r.notifyPolicy === "on_attention" ? "on_attention" : "on_finish",
    fromOutsideContent: r.fromOutsideContent === true,
    createdAt: text(r, "createdAt") ?? new Date(0).toISOString(),
  };
}

/** The proposal key for the n-th proposal answering one user message. */
export function routineProposalKey(userMessageId: string, index: number): string {
  return `routine-proposal:${userMessageId}:${index}`;
}

// ---------------------------------------------------------------------------
// A finished task, offered as a routine
// ---------------------------------------------------------------------------

/**
 * The instructions a finished task becomes as a routine: the person's own
 * request when the goal carries one (`composeTaskGoal` writes "Request: …"
 * first), otherwise the goal as it is. The brief stays out: it was written for
 * one run and names things the next run will not find.
 */
export function routineInstructionsFromGoal(goal: string): string {
  const trimmed = goal.trim().replace(/^\/[a-z0-9-]+\s+/i, "");
  const request = /^Request:\s*([\s\S]*?)(?:\n\nBrief:|\n\nDeliverable:|$)/.exec(trimmed);
  const body = request ? request[1].trim() : trimmed;
  return body.slice(0, MAX_ROUTINE_INSTRUCTIONS_CHARS);
}

/**
 * A proposal drawn from a finished task, for the card's "Make a routine": no
 * schedule yet, so the card opens on Edit with the When field focused.
 */
export function proposalFromTask(input: {
  sessionId: string;
  title: string;
  goal: string;
  timezone: string;
  now: Date;
}): ClientRoutineProposal {
  return {
    version: 1,
    key: `routine-from-task:${input.sessionId}`,
    name: clipWords(oneLine(input.title) || "Routine", MAX_ROUTINE_NAME_CHARS),
    instructions: routineInstructionsFromGoal(input.goal),
    schedule: {
      phrase: "",
      kind: "daily",
      config: { hour: 9, minute: 0 },
      summary: describeTimeTrigger("daily", { hour: 9, minute: 0 }),
      assumedTime: true,
    },
    timezone: isValidTimeZone(input.timezone) ? input.timezone : "UTC",
    nextRuns: upcomingFires("daily", { hour: 9, minute: 0 }, isValidTimeZone(input.timezone) ? input.timezone : "UTC", input.now, 3).map((d) => d.toISOString()),
    apps: [],
    missingApps: [],
    maxCostMicroUsd: MIN_DEFAULT_RUN_BUDGET_MICRO_USD,
    estimatedCostMicroUsd: null,
    notifyPolicy: "on_finish",
    fromOutsideContent: false,
    createdAt: input.now.toISOString(),
  };
}
