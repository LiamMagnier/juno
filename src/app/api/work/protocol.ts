/**
 * The request shapes and the pure decisions of the Juno Work HTTP surface.
 *
 * Colocated with the routes that use it, the way `delete-account.ts` sits next
 * to the account routes, and deliberately free of Prisma and `server-only`. The
 * decisions below — which sessions a filter selects, whether a run may be
 * created at all, whether an approval answer is the one that was asked for —
 * are the parts of this surface that are worth being sure about, and a check
 * that can only be exercised against a live Postgres is a check that is
 * exercised once, by hand, on the day it is written. `tests/work-routes.test.ts`
 * imports this module and nothing else from the surface.
 *
 * Nothing here re-declares a union that `@/lib/work/domain` owns.
 */

import { z } from "zod";
import {
  WORK_CAPABILITIES,
  WORK_HOST_STATES,
  WORK_PERMISSION_POLICIES,
  WORK_STATUSES,
  WORK_TARGETS,
  describeCapability,
  hostStateFor,
  mayBeCoveredByStandingAllowance,
  selectTarget,
  type TargetSelection,
  type WorkTarget,
  type WorkApprovalDecision,
  type WorkCapability,
  type WorkDegradation,
  type WorkHostState,
  type WorkRiskLevel,
  type WorkStatus,
} from "@/lib/work/domain";
import { hostCapabilityView, type WorkHostRow } from "@/lib/work/schedule";
import { verifyApproval } from "@/lib/work/digests";
import { MAX_SKILL_SLUG_CHARS } from "@/lib/work/skills";
import { REASONING_TIERS } from "@/lib/model-metrics";
import { MAX_ATTACHMENTS } from "@/lib/uploads";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * A goal is the sentence a plan is checked back against, not a document.
 *
 * Generous enough for a briefing with a list of constraints in it, small enough
 * that the column a hundred sessions are listed from stays cheap to read.
 */
const MAX_GOAL_CHARS = 10_000;
const MAX_TITLE_CHARS = 200;
/** An answer to a question the run asked. Prose, occasionally a pasted list. */
const MAX_ANSWER_CHARS = 10_000;
/** Why the user refused. Shown back to them, never fed to the model as policy. */
const MAX_DENY_REASON_CHARS = 500;
/** Ids in this codebase are cuids; the cap is a sanity bound, not a format. */
const MAX_ID_CHARS = 200;

/**
 * How many connected apps one task may be handed.
 *
 * A bound on the request rather than a statement about the catalog, which is
 * why it is not `listConnectors().length`: that module is `server-only` and this
 * one is deliberately not, and the number would be wrong anyway — a Composio
 * account can link apps this deployment has never enumerated. The real ceiling
 * is what the account has actually connected, and the route checks every id
 * against a `Connection` row before it becomes a grant. This only keeps the body
 * and the ownership query from being unbounded.
 */
const MAX_TASK_CONNECTORS = 32;

/** Matches the idempotency bound in `/api/code/tasks`, for one obvious reason:
 *  a client generating keys for both surfaces should not have to remember two. */
const idempotencyKey = z.string().trim().min(8).max(MAX_ID_CHARS);

const id = z.string().trim().min(1).max(MAX_ID_CHARS);

/**
 * How much thinking the reader asked for, or `null` for none at all.
 *
 * Built from `REASONING_TIERS` rather than repeating the six literals, which is
 * the lesson `/api/chat`'s body schema already paid for: it listed four of them
 * and silently 400'd every request that asked for the other two, on 26 models,
 * for as long as it took somebody to notice.
 *
 * Nullable and optional mean different things and both are needed. Absent is
 * "the reader expressed no preference", and leaves whatever the session
 * already carries alone. `null` is a preference — Instant, no extra reasoning —
 * and is the only way to turn a tier back off once one has been set.
 */
const reasoningEffort = z.enum(REASONING_TIERS).nullable();

/**
 * The approval mode a task is composed with, or asked to retry under.
 *
 * Optional and never defaulted in the schema. Absent means "whatever this
 * session already carries", which is what a client that has never heard of the
 * control sends, and defaulting it here would have every such client silently
 * rewrite the mode its owner picked on another surface. The routes apply
 * `DEFAULT_WORK_PERMISSION_POLICY` at the one point where there genuinely is no
 * prior answer — creating a session — and nowhere else.
 *
 * Accepting it from a client is safe in exactly one direction. It is a request,
 * and `resolveApprovalMode` intersects it with the Mac's advertised policy
 * before anything is stored, so the widest thing this field can produce is the
 * host's own setting. A body that asks for `permissive` on a Mac pinned to
 * `conservative` gets `conservative` and is told so.
 */
const permissionPolicy = z.enum(WORK_PERMISSION_POLICIES);

// ---------------------------------------------------------------------------
// Session bodies
// ---------------------------------------------------------------------------

export const createSessionSchema = z.object({
  goal: z.string().trim().min(1).max(MAX_GOAL_CHARS),
  title: z.string().trim().min(1).max(MAX_TITLE_CHARS).optional(),
  // Required rather than defaulted. `automatic` is a real choice with real
  // consequences — it is what lets a task silently move off the user's Mac —
  // and a client that has not thought about the target should be made to say so
  // rather than inherit the answer from whoever wrote this default.
  requestedTarget: z.enum(WORK_TARGETS),
  preferredHostId: id.optional(),
  projectId: id.optional(),
  // Passed through to `requestedModel` unvalidated against the catalog: the
  // executor resolves and may substitute the model, and records that
  // substitution as a `model_substituted` degradation. Refusing an unknown id
  // here would reject a model this deployment does not know but the executor
  // does, which is exactly the case a rolling deploy produces.
  model: z.string().trim().min(1).max(MAX_ID_CHARS).optional(),
  reasoningEffort: reasoningEffort.optional(),
  permissionPolicy: permissionPolicy.optional(),
  // Files the reader picked in the composer, by attachment id. The route
  // re-checks every one of them against the signed-in account before it becomes
  // a grant — an id in a request body is a claim about ownership, and the only
  // thing that makes it true is an `Attachment` row scoped to that account.
  //
  // Bounded by the same `MAX_ATTACHMENTS` the chat composer and `/api/chat`
  // use, imported rather than restated: a cap that disagreed with the one the
  // picker enforces would reject a selection the UI had already accepted, and
  // the reader would have no way to tell which of their files was the problem.
  attachmentIds: z.array(id).max(MAX_ATTACHMENTS).optional(),
  // The connected apps this task may reach, by provider id. Absent and `[]` are
  // different requests and the difference is the whole point: `[]` is a reader
  // who was shown their linked apps and switched none on — the composer's
  // default, and a task that reaches nothing — while absent is a client that has
  // never heard of the control, which must leave the task behaving as it did
  // before this existed. `WorkSession.connectorsChosen` is what carries that
  // difference past this schema, and `WorkConnectorAllowlist.taskAllowed` in
  // src/lib/work/connectors.ts is what reads it.
  //
  // Not `z.enum(...)` over the connector registry: the registry is server-only,
  // and a Composio account links apps no enum here could list. An id that names
  // nothing the account has connected is refused by the route, against the one
  // thing that can actually answer the question.
  connectorIds: z.array(id).max(MAX_TASK_CONNECTORS).optional(),
  idempotencyKey: idempotencyKey.optional(),
});

export const patchSessionSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_CHARS).optional(),
    pinned: z.boolean().optional(),
    archived: z.boolean().optional(),
  })
  // An empty patch is a client bug, and answering it with 200 and an unchanged
  // session hides that bug for as long as it takes somebody to notice the
  // rename never happened. Unknown keys are stripped by zod, so `{ name: "x" }`
  // arrives here as `{}` and is refused, which is the point.
  .refine((body) => Object.keys(body).length > 0, { message: "no_recognised_fields" });

// ---------------------------------------------------------------------------
// Session context — editing a task after it exists
// ---------------------------------------------------------------------------

/**
 * The body of `PATCH /api/work/sessions/[id]/context`.
 *
 * Separate from `patchSessionSchema` rather than folded into it, and the split
 * is the point. That schema changes how a task is *filed* — its name, whether
 * it is pinned, whether it is archived — and every one of those takes effect the
 * instant the row is written. This one changes what a task may *reach*, and none
 * of it is guaranteed to reach the attempt that is already running. Answering
 * both from one handler would mean one response shape carrying two different
 * promises, and the weaker promise is the one that would get lost.
 *
 * `goal` is deliberately absent and will stay absent. The schema documents it as
 * what the user asked for verbatim, and it is the sentence a plan is checked
 * back against; editing it mid-task would leave every attempt validated against
 * a goal nobody wrote.
 *
 * Every list field is the WHOLE set, never a delta — the same contract
 * `createSessionSchema` uses, for the same reason: a delta cannot express a
 * removal without a second verb, and a reader editing a list is editing a set.
 * Absent means "no opinion, leave it alone"; `[]` means "empty, on purpose".
 *
 * There is no idempotency key and there should not be one. Every operation here
 * is a set assignment or a scalar assignment, so sending the same body twice
 * converges on the same state and reports `unchanged` the second time. A key
 * would be a token the route accepted and had no use for.
 */
export const patchSessionContextSchema = z
  .object({
    /**
     * The files this task may read, by attachment id — the whole set.
     *
     * Bounded by `MAX_ATTACHMENTS`, imported rather than restated, exactly as in
     * `createSessionSchema`: a cap that disagreed with the picker's would refuse
     * a selection the UI had already accepted.
     *
     * Scoped to attached uploads. A folder on a Mac is a `WorkFileGrant` too,
     * but it is granted and revoked through the host screen and the relay's
     * `grant_folder`/`revoke_grant` commands, because only the Mac can resolve
     * or release a bookmark. A route that silently swept those would revoke
     * grants it never wrote.
     */
    attachmentIds: z.array(id).max(MAX_ATTACHMENTS).optional(),
    /** The connected apps this task may reach, by provider id — the whole set. */
    connectorIds: z.array(id).max(MAX_TASK_CONNECTORS).optional(),
    /**
     * Accepted, validated, and answered with a refusal. See
     * `SKILL_NOT_EDITABLE` for why, and why that is better than a 400.
     */
    skillSlug: z.string().trim().min(1).max(MAX_SKILL_SLUG_CHARS).nullable().optional(),
    model: z.string().trim().min(1).max(MAX_ID_CHARS).optional(),
    reasoningEffort: reasoningEffort.optional(),
    permissionPolicy: permissionPolicy.optional(),
    /** The project this task is filed in. `null` unfiles it. */
    projectId: id.nullable().optional(),
  })
  // Same refusal as `patchSessionSchema`, for the same reason: unknown keys are
  // stripped by zod, so `{ files: [...] }` arrives as `{}` and is refused rather
  // than answered with a cheerful 200 and a task nobody edited.
  .refine((body) => Object.keys(body).length > 0, { message: "no_recognised_fields" });

/** The controls this route can be asked about. One result per field, per request. */
export const WORK_CONTEXT_FIELDS = [
  "files",
  "connectors",
  "skill",
  "model",
  "reasoningEffort",
  "permissionPolicy",
  "project",
] as const;

export type WorkContextField = (typeof WORK_CONTEXT_FIELDS)[number];

/**
 * What a request did to one field.
 *
 * `narrowed` and `widened` are separate values rather than a single `changed`
 * because they carry different promises, and that asymmetry is the whole design:
 * taking a permission away is a safety action and lands as soon as it is
 * written, while handing one over is a new grant and belongs to the attempt that
 * is dispatched next. `mixed` is one request that did both — the common case for
 * a file list, where a reader swapped one document for another.
 */
export const WORK_CONTEXT_CHANGES = [
  "unchanged",
  "narrowed",
  "widened",
  /** Both at once. Reported with the pessimistic effect; see `describeGrantChange`. */
  "mixed",
  /** Neither wider nor narrower — a different model, a different project. */
  "replaced",
  /** Understood, and cannot be done. The explanation says why. */
  "refused",
] as const;

export type WorkContextChange = (typeof WORK_CONTEXT_CHANGES)[number];

/**
 * WHEN a change takes effect on what the task actually does.
 *
 * The definition matters more than the values, so it is written here once: this
 * is not "when was the row written" — every accepted change is written before
 * the response is sent. It is when the change alters the work. A progress bar
 * that completes while the run never sees the file is the failure this whole
 * type exists to prevent, so `now` is only ever claimed where the answer is
 * true of the running attempt as well as of the next one.
 */
export const WORK_CONTEXT_EFFECTS = [
  /** In force from the moment this response was written, for every attempt. */
  "now",
  /** The attempt in flight will not see it. The next dispatch will. */
  "next_attempt",
  /** Nothing changed, or the change was refused. */
  "none",
] as const;

export type WorkContextEffect = (typeof WORK_CONTEXT_EFFECTS)[number];

export interface WorkContextFieldResult {
  field: WorkContextField;
  change: WorkContextChange;
  effect: WorkContextEffect;
  /**
   * One plain sentence, addressed to the reader, for the control that sent the
   * change. Always present — a verdict with no sentence is a UI guessing.
   */
  explanation: string;
  /**
   * Present only when an attempt is executing right now and was already handed
   * what has just been taken away.
   *
   * This is the field that keeps `effect: "now"` honest. Revoking a grant is
   * immediate and binds everything from here on, but a run that has already been
   * given a file's text, or has already opened a connector's socket, keeps what
   * it has until it finishes — the executor reads both once, when it starts.
   * Saying only "removed" at the control would tell somebody who has just pulled
   * a document off a live task that the run can no longer see it, which is the
   * one thing they most need to be right about.
   */
  inFlightCaveat?: string;
}

/**
 * The skill a task runs under cannot be changed, and this says so out loud.
 *
 * `applySkill` in scripts/work-runner.ts resolves the skill from a leading
 * `/slug` on `WorkSession.goal`, and the goal is verbatim by design. There is no
 * second place the choice lives, so the only ways to make this control work
 * would be to rewrite the goal — which detaches every attempt from the sentence
 * its plan is validated against — or to add a column the executor does not read,
 * which is a control that looks like a permission and grants nothing.
 *
 * Answered as a per-field refusal inside a 200 rather than as a 400 on the whole
 * request, for two reasons. A UI that changes the model and the skill in one
 * save should not lose the model change to the field that cannot land. And a
 * refusal a client can read is a control it can disable with a sentence beside
 * it, where a 400 is indistinguishable from a bug in the client.
 */
export const SKILL_NOT_EDITABLE: WorkContextFieldResult = {
  field: "skill",
  change: "refused",
  effect: "none",
  explanation:
    "A task's skill comes from the slash command at the start of what you asked for, and Juno keeps that wording exactly as you wrote it because every attempt is checked back against it. Start a new task to run this under a different skill.",
};

export interface GrantChangeInput {
  field: "files" | "connectors";
  /** How many permissions this request took away. */
  removed: number;
  /** How many it handed over. */
  added: number;
  /**
   * True when an attempt is executing right now — claimed, past the point where
   * it read its files and opened its connectors. A queued or paused attempt has
   * not read anything yet and is not in flight for this purpose.
   */
  runInFlight: boolean;
  /**
   * Connectors only: true when this request is the first time anybody answered
   * the question for this task.
   *
   * It changes the verdict, and the reason is the `connectorsChosen` distinction
   * the schema and src/lib/work/connectors.ts both turn on. A task that has never
   * been asked carries `taskAllowed: null`, which means every app the account has
   * linked. Any explicit list is therefore a subset of what the task could reach
   * a moment ago — so the first answer is a pure narrowing however many apps it
   * names, and the rows it writes record an allowlist rather than hand over reach
   * the task did not already have. Reporting the named apps as a widening would
   * defer a promise that was already true, and reporting 0/0 as `unchanged`
   * would be worse: a reader who switched every app off would be told nothing
   * happened, when what happened is that the task stopped reaching all of them.
   *
   * Meaningless for files, where there is no such flag: no grants means no files.
   */
  firstAnswer?: boolean;
}

/**
 * Turns a reconciled grant set into the sentence and the promise for its control.
 *
 * The two halves are answered differently on purpose and the reason is the same
 * one `narrowHostToggles` encodes for a Mac's capability switches: in this
 * codebase permission only ever narrows on its way down. A removal is refused by
 * nothing and is safe to apply the moment it is written. An addition has to pass
 * through the layers a dispatch applies — the plan, the host, the project, the
 * skill — and the only place all of them are in one room is the start of an
 * attempt.
 *
 * A `mixed` request reports `next_attempt`, which is the pessimistic half. The
 * removal really has landed and the sentence says so; the field as a whole is
 * not in force until the addition is, and a UI told `now` would show a green
 * tick over a task that cannot yet read the file the reader just attached.
 */
export function describeGrantChange(input: GrantChangeInput): WorkContextFieldResult {
  const { field, removed, added, runInFlight } = input;
  const thing = field === "files" ? "files" : "apps";
  const caveat =
    field === "files"
      ? "The attempt running now was given its files when it started, so it still has what it has already read. Nothing after it will."
      : "The attempt running now opened its connections when it started and keeps them until it finishes. Nothing after it will.";

  // The first answer, before the add/remove arithmetic, because that arithmetic
  // cannot see it: the counts describe rows, and what changed here is what the
  // absence of rows meant. See `firstAnswer`.
  if (input.firstAnswer) {
    return {
      field,
      change: "narrowed",
      effect: "now",
      explanation:
        added === 0
          ? "This task can no longer reach any of your connected apps."
          : `This task can now reach only the ${added === 1 ? "app" : `${added} apps`} you picked, and nothing else you have connected.`,
      ...(runInFlight ? { inFlightCaveat: caveat } : {}),
    };
  }

  if (removed === 0 && added === 0) {
    return {
      field,
      change: "unchanged",
      effect: "none",
      explanation: `The ${thing} on this task are already the ones you sent.`,
    };
  }

  const gone =
    field === "files"
      ? `${removed === 1 ? "That file is" : `Those ${removed} files are`} no longer part of this task.`
      : `This task can no longer reach ${removed === 1 ? "that app" : `those ${removed} apps`}.`;
  const arrived =
    field === "files"
      ? `Juno hands a task its files when an attempt starts, so ${added === 1 ? "the new file is" : `the ${added} new files are`} read from the next attempt.`
      : `Juno connects a task's apps when an attempt starts, so ${added === 1 ? "the new app is" : `the ${added} new apps are`} reachable from the next attempt.`;

  if (added === 0) {
    return {
      field,
      change: "narrowed",
      effect: "now",
      explanation: gone,
      ...(runInFlight ? { inFlightCaveat: caveat } : {}),
    };
  }
  if (removed === 0) {
    return { field, change: "widened", effect: "next_attempt", explanation: arrived };
  }
  return {
    field,
    change: "mixed",
    effect: "next_attempt",
    explanation: `${gone} ${arrived}`,
    ...(runInFlight ? { inFlightCaveat: caveat } : {}),
  };
}

/**
 * Why each of the four settings below binds at dispatch and cannot bind sooner.
 *
 * One sentence each, written for the reader rather than for the log, and each
 * one is a fact about this codebase rather than a hedge:
 *
 *  - the model and the thinking depth are `AgentLoopOptions`, fixed when the
 *    loop is constructed, alongside the pricing the budget guard bills against;
 *  - the approval mode is digested into every approval the run asks for, so
 *    changing it under a live run would refuse the card already on somebody's
 *    screen with `policy_changed`;
 *  - a project's instructions are read into the run's opening context, once,
 *    before the first turn.
 */
const SETTING_EXPLANATIONS: Record<
  "model" | "reasoningEffort" | "permissionPolicy" | "project",
  string
> = {
  model: "Juno picks up the model when an attempt starts, so this one runs from the next attempt.",
  reasoningEffort:
    "Juno sets the thinking depth when an attempt starts, so this applies from the next attempt.",
  permissionPolicy:
    "Every approval an attempt asks for is signed against the mode it started under, so this applies from the next attempt.",
  project:
    "Juno reads a project's instructions when an attempt starts, so this applies from the next attempt.",
};

export interface SettingChangeInput {
  field: "model" | "reasoningEffort" | "permissionPolicy" | "project";
  /** False when the value sent is the value already stored. */
  changed: boolean;
}

/**
 * The verdict for a setting that binds at dispatch.
 *
 * `next_attempt` unconditionally, including when nothing is running. That is not
 * caution, it is accuracy: these four are read at exactly one moment, and when
 * no attempt is in flight "the next attempt" is the run the reader is about to
 * start — which is the sentence the control should be showing them anyway.
 * Reporting `now` because nothing happens to be running would make the promise
 * depend on the timing of the request rather than on what the executor does.
 */
export function describeSettingChange(input: SettingChangeInput): WorkContextFieldResult {
  if (!input.changed) {
    return {
      field: input.field,
      change: "unchanged",
      effect: "none",
      explanation: "That is already what this task is set to.",
    };
  }
  return {
    field: input.field,
    change: "replaced",
    effect: "next_attempt",
    explanation: SETTING_EXPLANATIONS[input.field],
  };
}

// ---------------------------------------------------------------------------
// Run bodies
// ---------------------------------------------------------------------------

/**
 * Origins a client may claim.
 *
 * `schedule` and `trigger` are absent on purpose. They mean "nobody was there",
 * which decides how the run is displayed, which budget it is accounted against
 * and what an unattended policy allows it to do. A browser that could label its
 * own run as scheduled would be choosing the rules it is judged by.
 */
export const CLIENT_RUN_ORIGINS = ["manual", "retry", "resume", "fork"] as const;

export const startRunSchema = z.object({
  origin: z.enum(CLIENT_RUN_ORIGINS).optional(),
  // What the plan says this attempt needs. A client that names capabilities is
  // making a request, not a suggestion, and the route honours it. Absent — or
  // an empty array, which is the same statement made less carefully — means
  // "you work it out", and the route reads the goal with `inferCapabilities`.
  //
  // The browser takes the second path now: the composer's chip asked the reader
  // to answer a question about Juno's architecture before describing their own
  // work, and the answer was always either "anything it needs" or nothing.
  // The native client still names them, because by then it has planned.
  requiredCapabilities: z.array(z.enum(WORK_CAPABILITIES)).max(WORK_CAPABILITIES.length).optional(),
  // Overrides the session's target for this attempt only, which is how "it
  // failed on the Mac, run it in the cloud" works without editing the session.
  requestedTarget: z.enum(WORK_TARGETS).optional(),
  model: z.string().trim().min(1).max(MAX_ID_CHARS).optional(),
  reasoningEffort: reasoningEffort.optional(),
  // The same override for the approval mode, and it exists for the same move:
  // "it stopped to ask me nine times, run it again and stop asking". Attempt-
  // scoped like `requestedTarget` and unlike `reasoningEffort`, which has no
  // column on the run and therefore leaks into the next attempt — the run's
  // `permissionPolicy` blob is written per attempt, so this one genuinely does
  // not.
  //
  // It may widen past the session's own setting, and that is deliberate: the
  // session's mode is the composer's default for this task, not a ceiling. The
  // only ceiling is the Mac's, and it is applied after this.
  permissionPolicy: permissionPolicy.optional(),
  /** Required after the server's preflight estimate crosses the warning bar. */
  confirmExpensive: z.boolean().optional(),
  idempotencyKey: idempotencyKey.optional(),
});

export const runControlSchema = z.object({
  action: z.enum(["pause", "resume", "cancel"]),
});

export const answerSchema = z.object({
  // The question the run asked, echoed back. Without it a late answer typed
  // before the run moved on is applied to whatever it is asking now.
  questionId: id,
  text: z.string().trim().min(1).max(MAX_ANSWER_CHARS),
  idempotencyKey: idempotencyKey.optional(),
});

// ---------------------------------------------------------------------------
// Approval decisions
// ---------------------------------------------------------------------------

/**
 * The decisions a person may submit.
 *
 * `pending` is the initial state, and `expired`/`superseded` are written by the
 * server about the passage of time and about newer requests. A client that
 * could submit them could mark its own approval expired and, with the sweeper's
 * vocabulary, make a refusal look like a timeout in the audit log.
 */
export const CLIENT_APPROVAL_DECISIONS = ["allowed", "allowed_always", "denied"] as const;
export type ClientApprovalDecision = (typeof CLIENT_APPROVAL_DECISIONS)[number];

export const approvalDecisionSchema = z.object({
  decision: z.enum(CLIENT_APPROVAL_DECISIONS),
  // The digest of the card the client rendered. SHA-256, lower-case hex — the
  // exact shape `actionDigest()` produces, checked here so a malformed value is
  // a 400 about the request rather than a 409 about a replay.
  actionDigest: z.string().regex(/^[0-9a-f]{64}$/),
  reason: z.string().trim().min(1).max(MAX_DENY_REASON_CHARS).optional(),
});

/**
 * Why an approval answer was refused. Machine-readable, because the client has
 * to do something different for each: re-render the card, re-ask under the new
 * policy, or tell the user the window closed.
 */
export const APPROVAL_DECISION_REFUSALS = [
  /** The answer is not about the action this row describes. */
  "digest_mismatch",
  /** The policy narrowed after the user was asked. The question must be re-put. */
  "policy_changed",
  /** The answering window closed. */
  "expired",
  /** Resolved already: answered differently, or replaced by a newer request. */
  "already_decided",
  /**
   * "Always allow" was submitted for something no standing allowance may cover.
   *
   * The plain `allowed` on the same card is accepted — this refuses the
   * standing half of the answer, not the answer.
   */
  "not_standing_allowable",
] as const;

export type ApprovalDecisionRefusal = (typeof APPROVAL_DECISION_REFUSALS)[number];

export type ApprovalDecisionOutcome =
  | { outcome: "record"; decision: ClientApprovalDecision }
  /** The same answer to the same card, arriving twice. Not an error. */
  | { outcome: "replay" }
  | { outcome: "refuse"; reason: ApprovalDecisionRefusal };

export interface ApprovalDecisionInput {
  submittedDecision: ClientApprovalDecision;
  /** The digest the client says it rendered. */
  submittedDigest: string;
  approval: {
    action: string;
    detail: unknown;
    /** As the executor graded it when it asked. Decides what "always" may cover. */
    risk: WorkRiskLevel;
    actionDigest: string;
    policyDigest: string;
    decision: WorkApprovalDecision;
    expiresAt: Date;
  };
  /** The run's resolved permission policy, as stored on the run right now. */
  policy: unknown;
  now: Date;
}

/**
 * Decides what to do with a submitted approval answer.
 *
 * The order is the substance of this function, and it follows `verifyApproval`'s
 * for the same reason: the refusal reason is what an investigator gets, so the
 * most serious finding has to be reported first. An answer carrying a digest
 * that is not this row's is a client answering a different card — the
 * substitution case the whole digest mechanism exists for — and reporting
 * "expired" or "already decided" ahead of it would file a substitution attempt
 * as a timing problem. The standing-allowance check sits immediately below it,
 * above everything else, for the same reason: those two are the refusals about
 * the answer being wrong, and the rest are about it being late.
 *
 * `verifyApproval` is then called with the submitted decision, so the stored
 * row is re-checked against the policy in force right now rather than the one
 * that was in force when the card was drawn. Its `not_allowed` verdict is only
 * reachable here for a `denied` submission — the one answer it is designed to
 * refuse and the one this surface must accept — so that verdict falls through
 * to the explicit expiry check below it, which is the check `verifyApproval`
 * short-circuited past.
 */
export function classifyApprovalDecision(input: ApprovalDecisionInput): ApprovalDecisionOutcome {
  const { approval, submittedDecision } = input;

  if (input.submittedDigest !== approval.actionDigest) {
    return { outcome: "refuse", reason: "digest_mismatch" };
  }
  // Above the replay check, so a row written before this rule existed cannot be
  // re-affirmed into a standing allowance either. A standing "always allow" is
  // the one answer that authorises actions the user has not seen, so the answer
  // and the row have to agree that this action may ever be covered by one — and
  // the check is on the action name as well as the risk, because the risk is the
  // executor's classification and the always-confirm list exists precisely
  // because that classification is the thing not to trust. A UI that offers the
  // button for a send is a UI bug; a server that records it is a permission.
  if (
    submittedDecision === "allowed_always" &&
    !mayBeCoveredByStandingAllowance(approval.action, approval.risk)
  ) {
    return { outcome: "refuse", reason: "not_standing_allowable" };
  }
  if (approval.decision === submittedDecision) {
    // A phone retrying over a flaky connection, or the same person tapping
    // twice. Answering 409 would present a successful decision as a failure.
    return { outcome: "replay" };
  }
  if (approval.decision !== "pending") {
    // A sweeper's `expired` is not somebody else's answer, and reporting it as
    // one sends the user to ask a colleague about a decision nobody made. Every
    // other non-pending value — a real second answer, or a `superseded` row
    // replaced by a newer request — is honestly "already resolved".
    return {
      outcome: "refuse",
      reason: approval.decision === "expired" ? "expired" : "already_decided",
    };
  }

  const verdict = verifyApproval({
    storedDigest: approval.actionDigest,
    storedPolicyDigest: approval.policyDigest,
    action: approval.action,
    detail: approval.detail,
    policy: input.policy,
    decision: submittedDecision,
    expiresAt: approval.expiresAt,
    now: input.now,
  });

  if (!verdict.ok && verdict.reason !== "not_allowed") {
    return { outcome: "refuse", reason: verdict.reason };
  }
  if (input.now.getTime() >= approval.expiresAt.getTime()) {
    return { outcome: "refuse", reason: "expired" };
  }
  return { outcome: "record", decision: submittedDecision };
}

// ---------------------------------------------------------------------------
// Run admission
// ---------------------------------------------------------------------------

export interface RunRefusal {
  error: "no_executor_available";
  /** `TargetSelection.explanation`, verbatim. It is already addressed to the user. */
  message: string;
  missing: WorkCapability[];
  degradation: WorkDegradation[];
}

/**
 * Turns a target selection with no target into the refusal a client shows.
 *
 * The one thing this must never do is soften a null target into a queued run.
 * A run queued with no possible executor renders as a spinner that resolves
 * never: the Mac is asleep, nothing is listening, and no part of the system
 * ever says so. Refusing at creation is the only moment anything can.
 *
 * A cloud target that carries degradations is NOT a refusal. It is a run that
 * will happen and will do less than was asked, and the degradations are how the
 * user finds that out before it starts rather than from the summary afterwards.
 */
export function refusalForSelection(selection: TargetSelection): RunRefusal | null {
  if (selection.target !== null) return null;
  return {
    error: "no_executor_available",
    message: selection.explanation,
    missing: [...selection.missing],
    degradation: [...selection.degradation],
  };
}

// ---------------------------------------------------------------------------
// Host state
// ---------------------------------------------------------------------------

/**
 * The host state to act on, which is not always the one stored on the row.
 *
 * `WorkHost.state` is host-authored, and that is right for the distinction only
 * the host can draw — heartbeating but declining work is `stale`, not
 * `offline`. It is wrong for the case where the host stopped talking: a Mac
 * that was closed mid-afternoon leaves `online` in that column until something
 * updates it, and `online` is precisely what makes `selectTarget` hand it a run
 * nobody will ever claim.
 *
 * So the heartbeat only ever narrows. While it is fresh the host's own claim
 * stands, including a claim of `offline`; once it has lapsed, the clock wins.
 */
export function effectiveHostState(
  host: { state: string; lastSeenAt: Date; activeRunCount: number },
  now: Date
): WorkHostState {
  const derived = hostStateFor(host.lastSeenAt, now, host.activeRunCount);
  if (derived === "stale" || derived === "offline") return derived;
  return (WORK_HOST_STATES as readonly string[]).includes(host.state)
    ? (host.state as WorkHostState)
    : "offline";
}

// ---------------------------------------------------------------------------
// Session list query
// ---------------------------------------------------------------------------

export const SESSION_LIST_DEFAULT_LIMIT = 30;
export const SESSION_LIST_MAX_LIMIT = 100;

export interface SessionListQuery {
  status?: WorkStatus;
  needsAttention?: boolean;
  pinned?: boolean;
  /**
   * Absent means false, not "either". The archive is a place a user puts a
   * session to stop seeing it, and a default list that still shows it has
   * quietly refused the only instruction that toggle carries.
   */
  archived: boolean;
  projectId?: string;
  limit: number;
}

export type SessionListQueryResult =
  | { ok: true; query: SessionListQuery }
  /** The parameter that was wrong, so the 400 says which one. */
  | { ok: false; parameter: string };

/**
 * Booleans in a query string, strictly.
 *
 * `"maybe"` is rejected rather than read as false. A filter that silently
 * ignores what it could not parse returns a plausible list of the wrong
 * sessions, and nothing about the response says the filter was dropped.
 */
function booleanParam(raw: string | null): boolean | null | undefined {
  if (raw === null) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return null;
}

/**
 * Validates and clamps the session list filters.
 *
 * `limit` follows the repo's query-param idiom exactly: unparseable falls back
 * to the default rather than 400ing, and anything parseable is clamped into
 * range. The clamp is what stops `?limit=100000` from turning a list view into
 * a full-table read whenever somebody's pagination is off by a zero.
 */
export function parseSessionListQuery(params: URLSearchParams): SessionListQueryResult {
  const status = params.get("status");
  if (status !== null && !(WORK_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, parameter: "status" };
  }

  const needsAttention = booleanParam(params.get("needsAttention"));
  if (needsAttention === null) return { ok: false, parameter: "needsAttention" };
  const pinned = booleanParam(params.get("pinned"));
  if (pinned === null) return { ok: false, parameter: "pinned" };
  const archived = booleanParam(params.get("archived"));
  if (archived === null) return { ok: false, parameter: "archived" };

  const projectId = params.get("projectId");
  if (projectId !== null && (projectId.length === 0 || projectId.length > MAX_ID_CHARS)) {
    return { ok: false, parameter: "projectId" };
  }

  const rawLimit = Number(params.get("limit") ?? String(SESSION_LIST_DEFAULT_LIMIT));
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), SESSION_LIST_MAX_LIMIT)
    : SESSION_LIST_DEFAULT_LIMIT;

  return {
    ok: true,
    query: {
      ...(status !== null ? { status: status as WorkStatus } : {}),
      ...(needsAttention !== undefined ? { needsAttention } : {}),
      ...(pinned !== undefined ? { pinned } : {}),
      archived: archived ?? false,
      ...(projectId !== null ? { projectId } : {}),
      limit,
    },
  };
}
/** Matches the constant the run-dispatch route and the scheduler each hold, for
 *  the same reason: turning cloud off should produce an honest refusal rather
 *  than schedules accepted for an executor that will never exist. */
const CLOUD_WORK_AVAILABLE = true;

export function admissionRefusal(
  target: WorkTarget,
  named: WorkHostRow | undefined,
  required: readonly WorkCapability[],
  hosts: readonly WorkHostRow[]
): RunRefusal | null {
  // The named Mac first, because `selectTarget` takes the first fully capable
  // host in the list. Ordered rather than filtered, so this asks exactly the
  // question the dispatcher will ask — it orders the same way, and an
  // `automatic` schedule really can end up on the second Mac.
  const ordered = named ? [named, ...hosts.filter((host) => host.id !== named.id)] : hosts;
  const refusal = refusalForSelection(
    selectTarget({
      requested: target,
      required,
      hosts: ordered.map((host) => hostCapabilityView(host, "idle")),
      cloudAvailable: CLOUD_WORK_AVAILABLE,
    })
  );
  if (!refusal || !named) return refusal;

  const why =
    named.revokedAt !== null
      ? `You revoked Juno's access to ${named.displayName}.`
      : !named.enabled
        ? `${named.displayName} is switched off for Juno Work.`
        : refusal.missing.length > 0
          ? `${named.displayName} has not been granted ${refusal.missing.map(describeCapability).join(", ")}.`
          : refusal.message;
  return { ...refusal, message: `${why} This schedule would fail every time it fired.` };
}
