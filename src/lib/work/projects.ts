/**
 * What a Work session inherits from its project, and the one direction that
 * inheritance can move.
 *
 * A project is a place to put defaults, not a place to acquire permissions.
 * Everything here narrows: a project may say "use the cheaper model", "cap this
 * at two pounds", "only these connectors" — and may not say "and also allow the
 * shell". The account and the host decided that already, and a project is a
 * folder, not a consent surface.
 *
 * That is worth stating in code rather than in a comment alone, because the
 * shape that would break it is so natural to write. Merging two option objects
 * with a spread takes the second one's value for every key, which is right for
 * a model preference and catastrophic for a permission: a project that spread
 * its way to `permissionPolicy: "permissive"` would hand every session inside
 * it more authority than the account granted. So the merge is written per
 * field, and every permission-shaped field goes through an intersection helper
 * from domain.ts rather than an assignment.
 *
 * Deliberately free of `server-only` and Prisma so the resolver can be tested
 * on its own, which is the only way the property below gets exercised properly:
 * for every pair of (account default, project default), the resolved value is
 * never wider than the account's.
 */

import { z } from "zod";
import {
  narrowestBudget,
  narrowestPolicy,
  type WorkBudget,
  type WorkPermissionPolicy,
  type WorkTarget,
  DEFAULT_WORK_PERMISSION_POLICY,
  WORK_PERMISSION_POLICIES,
  WORK_TARGETS,
} from "@/lib/work/domain";

/** The current shape of `Project.workDefaults`. */
export const WORK_DEFAULTS_VERSION = 1;

/**
 * A project's stored Work defaults.
 *
 * Every field optional: an absent field means "inherit", which is what a
 * project created before Juno Work existed should do, and is why the column
 * defaults to an empty object rather than to a populated one.
 */
export interface WorkProjectDefaults {
  /** cloud | local | automatic. */
  target?: WorkTarget;
  /** The Mac to prefer when the target is local or automatic. */
  preferredHostId?: string;
  /** Canonical "provider:model". */
  model?: string;
  reasoningEffort?: string;
  budget?: Partial<WorkBudget>;
  permissionPolicy?: WorkPermissionPolicy;
  /** Connector ids in scope for sessions in this project. */
  connectorIds?: string[];
  /** Grant ids the project's sessions may use without asking again. */
  grantIds?: string[];
  /** Skill ids offered first inside this project. */
  skillIds?: string[];
  /**
   * Whether a run may write back into the project's knowledge files.
   *
   * Off unless the user says otherwise. A project's knowledge files are what
   * the user told Juno to believe, and an agent that can quietly edit them can
   * quietly change its own instructions for every future run — which is memory
   * poisoning with a friendly name.
   */
  allowKnowledgeWrites?: boolean;
}

const TARGETS = new Set<string>(WORK_TARGETS);
const POLICIES = new Set<string>(WORK_PERMISSION_POLICIES);

/**
 * Reads a stored payload, discarding anything it does not recognise.
 *
 * Discarding rather than rejecting: a project written by a newer build carries
 * fields this one has never heard of, and refusing the whole payload would make
 * every session in that project fall back to account defaults — a much larger
 * behaviour change than ignoring one field. The version rides along so a reader
 * can tell "older shape" from "corrupt".
 */
export function parseWorkDefaults(raw: unknown): WorkProjectDefaults {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const out: WorkProjectDefaults = {};

  if (typeof source.target === "string" && TARGETS.has(source.target)) {
    out.target = source.target as WorkTarget;
  }
  if (typeof source.preferredHostId === "string" && source.preferredHostId) {
    out.preferredHostId = source.preferredHostId;
  }
  if (typeof source.model === "string" && source.model) out.model = source.model;
  if (typeof source.reasoningEffort === "string" && source.reasoningEffort) {
    out.reasoningEffort = source.reasoningEffort;
  }
  if (typeof source.permissionPolicy === "string" && POLICIES.has(source.permissionPolicy)) {
    out.permissionPolicy = source.permissionPolicy as WorkPermissionPolicy;
  }
  if (source.budget && typeof source.budget === "object" && !Array.isArray(source.budget)) {
    const budget = source.budget as Record<string, unknown>;
    const picked: Partial<WorkBudget> = {};
    for (const key of ["maxCostMicroUsd", "maxTokens", "maxRuntimeMs"] as const) {
      const value = budget[key];
      // Negative and non-finite values are dropped rather than clamped to zero,
      // because zero already means "no ceiling at this layer" and clamping
      // would silently turn a typo into unlimited spend.
      if (typeof value === "number" && Number.isFinite(value) && value >= 0) picked[key] = value;
    }
    if (Object.keys(picked).length > 0) out.budget = picked;
  }
  // ABSENT IS NOT EMPTY, and the empty one survives. A missing key means "this
  // project has no opinion about apps, take the account's"; `[]` means "tasks
  // filed here reach nothing", which is a real instruction a reader can give by
  // switching every app off. Collapsing the second into the first — which this
  // did, by dropping any list that came back empty — turns a deliberately
  // locked-down project back into one that inherits everything the account has
  // linked, and nothing in a UI shows that it happened.
  for (const key of ["connectorIds", "grantIds", "skillIds"] as const) {
    const value = source[key];
    if (Array.isArray(value)) {
      out[key] = value.filter((id): id is string => typeof id === "string" && id.length > 0);
    }
  }
  if (typeof source.allowKnowledgeWrites === "boolean") {
    out.allowKnowledgeWrites = source.allowKnowledgeWrites;
  }
  return out;
}

/** What the account allows, which is the ceiling everything below sits under. */
export interface WorkAccountDefaults {
  target: WorkTarget;
  model?: string;
  reasoningEffort?: string;
  budget: WorkBudget;
  permissionPolicy: WorkPermissionPolicy;
  /** Connectors the account has actually linked and authorised. */
  connectorIds: readonly string[];
  /** Grants the account actually holds. */
  grantIds: readonly string[];
}

export interface ResolvedWorkDefaults {
  target: WorkTarget;
  preferredHostId: string | null;
  model: string | null;
  reasoningEffort: string | null;
  budget: WorkBudget;
  permissionPolicy: WorkPermissionPolicy;
  connectorIds: string[];
  grantIds: string[];
  skillIds: string[];
  allowKnowledgeWrites: boolean;
  /**
   * Fields the project asked for and did not get, with the reason.
   *
   * Surfaced rather than swallowed: a user who set a project to `permissive`
   * and cannot see that the account holds it at `balanced` will conclude the
   * setting does not work, and the next thing they try is turning something off
   * at the account level that they actually wanted.
   */
  narrowed: Array<{ field: string; requested: string; applied: string; reason: string }>;
}

/**
 * Folds a project's defaults into the account's, narrowing only.
 *
 * Written field by field on purpose. A spread merge is one line and takes the
 * project's value for every key, which is correct for a model preference and
 * wrong for a permission — and the wrongness is invisible until a project turns
 * out to have granted the shell.
 */
export function resolveWorkDefaults(
  account: WorkAccountDefaults,
  project: WorkProjectDefaults
): ResolvedWorkDefaults {
  const narrowed: ResolvedWorkDefaults["narrowed"] = [];

  // A target is a preference, not an authority: asking for local does not grant
  // the Mac anything, and selectTarget still decides whether it can be served.
  const target = project.target ?? account.target;

  const policy = narrowestPolicy(account.permissionPolicy, project.permissionPolicy);
  if (project.permissionPolicy && project.permissionPolicy !== policy) {
    narrowed.push({
      field: "permissionPolicy",
      requested: project.permissionPolicy,
      applied: policy,
      reason: "A project can ask for stricter approvals than the account, never looser ones.",
    });
  }

  // Filled out to a whole budget before narrowing, because a partial one is not
  // a budget. narrowestBudget reads all three fields, and an absent field
  // arriving as undefined makes its Math.min produce NaN — a ceiling of NaN
  // compares false against every usage, so the run would have had no limit at
  // all. Zero is the correct filler: it already means "no ceiling at this
  // layer", which is exactly what an unset project field means.
  const projectBudget: WorkBudget | undefined = project.budget
    ? {
        maxCostMicroUsd: project.budget.maxCostMicroUsd ?? 0,
        maxTokens: project.budget.maxTokens ?? 0,
        maxRuntimeMs: project.budget.maxRuntimeMs ?? 0,
      }
    : undefined;
  const budget = narrowestBudget(account.budget, projectBudget);

  // Intersections, not unions. A project naming a connector the account has not
  // linked does not thereby link it, and a project naming a grant the account
  // does not hold does not thereby hold it.
  const accountConnectors = new Set(account.connectorIds);
  const connectorIds = (project.connectorIds ?? account.connectorIds).filter((id) =>
    accountConnectors.has(id)
  );
  for (const id of project.connectorIds ?? []) {
    if (!accountConnectors.has(id)) {
      narrowed.push({
        field: "connectorIds",
        requested: id,
        applied: "",
        reason: "That connector is not linked to this account, so the project cannot offer it.",
      });
    }
  }

  const accountGrants = new Set(account.grantIds);
  const grantIds = (project.grantIds ?? account.grantIds).filter((id) => accountGrants.has(id));
  for (const id of project.grantIds ?? []) {
    if (!accountGrants.has(id)) {
      narrowed.push({
        field: "grantIds",
        requested: id,
        applied: "",
        reason: "That folder has not been granted, so the project cannot use it.",
      });
    }
  }

  return {
    target,
    preferredHostId: project.preferredHostId ?? null,
    model: project.model ?? account.model ?? null,
    reasoningEffort: project.reasoningEffort ?? account.reasoningEffort ?? null,
    budget,
    permissionPolicy: policy,
    connectorIds: [...connectorIds],
    grantIds: [...grantIds],
    skillIds: [...(project.skillIds ?? [])],
    // Absent means off. A project that has never been asked the question has
    // not consented to an agent editing what it told Juno to believe.
    allowKnowledgeWrites: project.allowKnowledgeWrites === true,
    narrowed,
  };
}

/** Serialises defaults back for storage, dropping anything not recognised. */
export function serializeWorkDefaults(defaults: WorkProjectDefaults): Record<string, unknown> {
  // Round-tripped through the parser so a caller cannot write a field the
  // reader will ignore, which is how a setting comes to look saved and have no
  // effect.
  return parseWorkDefaults(defaults) as Record<string, unknown>;
}

/** Ids are cuids or provider names; the cap is a sanity bound, not a product one. */
export const MAX_WORK_DEFAULT_ID_CHARS = 200;
/** As many connectors, grants or skills as a project can plausibly name. */
export const MAX_WORK_DEFAULT_IDS = 200;

/**
 * The write shape, validated wherever a client hands these over.
 *
 * `.strict()` for the reason the native mutation union is strict: a field name
 * the server does not know is a client bug or a version skew, and accepting it
 * silently stores something no reader will ever look at while the user believes
 * it took effect.
 *
 * NOTHING HERE HAS A `.default()`. A Zod default would manufacture the
 * "configured" state out of silence — a project that has never been asked about
 * approvals would start declaring one — and the whole of `resolveWorkDefaults`
 * turns on the difference between a field a project stated and a field it left
 * alone.
 *
 * Note what this schema does NOT do: decide whether the account may have any of
 * it. A model named here still goes through the plan gate, a Mac is still
 * matched against a row carrying this user, and connectors are still
 * intersected with what the account has linked. This is a shape check; the
 * ceiling is `resolveWorkDefaults`.
 */
export const workDefaultsSchema = z
  .object({
    target: z.enum(WORK_TARGETS).optional(),
    preferredHostId: z.string().trim().min(1).max(MAX_WORK_DEFAULT_ID_CHARS).optional(),
    model: z.string().trim().min(1).max(MAX_WORK_DEFAULT_ID_CHARS).optional(),
    reasoningEffort: z.string().trim().min(1).max(40).optional(),
    budget: z
      .object({
        maxCostMicroUsd: z.number().int().min(0).optional(),
        maxTokens: z.number().int().min(0).optional(),
        maxRuntimeMs: z.number().int().min(0).optional(),
      })
      .strict()
      .optional(),
    permissionPolicy: z.enum(WORK_PERMISSION_POLICIES).optional(),
    connectorIds: z
      .array(z.string().min(1).max(MAX_WORK_DEFAULT_ID_CHARS))
      .max(MAX_WORK_DEFAULT_IDS)
      .optional(),
    grantIds: z
      .array(z.string().min(1).max(MAX_WORK_DEFAULT_ID_CHARS))
      .max(MAX_WORK_DEFAULT_IDS)
      .optional(),
    skillIds: z
      .array(z.string().min(1).max(MAX_WORK_DEFAULT_ID_CHARS))
      .max(MAX_WORK_DEFAULT_IDS)
      .optional(),
    allowKnowledgeWrites: z.boolean().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// What one session takes from the project it was filed in
// ---------------------------------------------------------------------------

/**
 * The project's answer to each field a session-creation request may leave open.
 *
 * `null` means "the project said nothing", which is NOT the same as an empty
 * list — see `connectorIds` below.
 */
export interface InheritedFromProject {
  model: string | null;
  reasoningEffort: string | null;
  permissionPolicy: WorkPermissionPolicy | null;
  /**
   * Null when the project has no opinion about apps; `[]` when it has one and
   * the answer is "none". The two are different instructions, and the layer
   * below reads them differently.
   */
  connectorIds: string[] | null;
  preferredHostId: string | null;
}

/**
 * What a task takes from the project it was filed in, when it said nothing
 * itself.
 *
 * This is what makes a project a *role* rather than a label. File a task in
 * Bookkeeping and it arrives with Bookkeeping's connected apps, its approval
 * mode and its model already chosen — the bundle a plugin carries elsewhere,
 * expressed on the noun Juno already has for "this body of work".
 *
 * Pure, and deliberately so: it does no ownership checking and reaches no
 * database, so the caller still has to put the model through the plan gate and
 * match the Mac against a row carrying this user. Keeping it pure is the only
 * way the two properties below get exercised — that a project can never widen
 * the approval mode, and that a project which said nothing about apps does not
 * thereby switch them all on.
 *
 * ABSENT IS NOT EMPTY, and it is the reason for the two `undefined` checks at
 * the end. `resolveWorkDefaults` answers with the account's own value when the
 * project declares nothing, which is right for the question it was written for
 * and wrong here twice over: a project with no connector list would hand the
 * task every app the account has linked, turning "this client said nothing
 * about apps" into "the reader switched them all on"; and a project with no
 * approval mode would resolve to the account layer, which is a value nobody
 * chose for this task. So a value is read back only where the project actually
 * stated one.
 */
export function inheritFromProjectDefaults(input: {
  /**
   * The body's own target, passed through. It is required in the session
   * schema precisely so that every task states one, so there is no such thing
   * here as a task with no opinion about where it runs, and the resolved
   * target is deliberately not read back.
   *
   * THE PROJECT'S `target` AND ITS `preferredHostId` ARE NOT TWO HALVES OF ONE
   * SETTING, which is what makes it consistent to read the second back and not
   * the first. A task always states a target, so there is no silence for the
   * project to fill; it states a Mac only sometimes, and that silence the
   * project can fill. The preference is passed on even for a `cloud` request —
   * `selectTarget` ignores it there — because dropping it would also drop it
   * from the retry that comes back as `automatic`, which is the attempt the
   * preference was written for.
   */
  requestedTarget: WorkTarget;
  /** The providers this account has actually linked, as the ceiling. */
  linkedConnectorIds: readonly string[];
  defaults: WorkProjectDefaults;
}): InheritedFromProject {
  const { defaults } = input;
  const resolved = resolveWorkDefaults(
    {
      target: input.requestedTarget,
      // Not read back either. Whatever limits a run is held to are decided when
      // an attempt is dispatched, not when the task is composed. Zero on every
      // axis means "no ceiling at this layer", so passing it narrows nothing.
      budget: { maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 },
      // The PRODUCT DEFAULT, and not the widest value in the vocabulary.
      //
      // This layer used to be `"permissive"`, on the argument that the account
      // holds no stored Work approval mode of its own so the widest value is
      // the honest one for it. The consequence was the opposite of what this
      // module exists for: `narrowestPolicy` then returns the project's value
      // verbatim, so a project set to "Just do it" made every task filed in it
      // run wider than the default every task in the product has had, with
      // nothing anywhere saying so. A project is a place to put defaults, not a
      // place to acquire permissions; giving it `DEFAULT_WORK_PERMISSION_POLICY`
      // to narrow from is what makes that sentence true of the code and not
      // only of the comment at the top of this file.
      permissionPolicy: DEFAULT_WORK_PERMISSION_POLICY,
      connectorIds: input.linkedConnectorIds,
      // Folder grants are not decided here — the dispatch reads the session's
      // own grants — so the project's list is passed through as its own ceiling
      // and the resolved value is not read. Passing an empty account layer
      // instead would report every grant the project names as refused, which is
      // a complaint about a question this layer did not ask.
      grantIds: defaults.grantIds ?? [],
    },
    defaults
  );

  return {
    model: resolved.model,
    reasoningEffort: resolved.reasoningEffort,
    permissionPolicy: defaults.permissionPolicy === undefined ? null : resolved.permissionPolicy,
    connectorIds: defaults.connectorIds === undefined ? null : resolved.connectorIds,
    preferredHostId: resolved.preferredHostId,
  };
}

/** What a session-creation request stated for itself. Absent means "no opinion". */
export interface WorkSessionChoices {
  model?: string | null;
  reasoningEffort?: string | null;
  permissionPolicy?: WorkPermissionPolicy;
  /**
   * Absent means the client has no control for apps at all. `[]` is an answer
   * — this task reaches nothing — and the browser composer sends it, which is
   * why this is tested against `undefined` and never for emptiness.
   */
  connectorIds?: readonly string[];
  preferredHostId?: string | null;
}

export interface ResolvedSessionFields {
  model: string | null;
  reasoningEffort: string | null;
  permissionPolicy: WorkPermissionPolicy;
  /** Null when neither layer had an opinion, so no connector rows are written. */
  connectorIds: string[] | null;
  preferredHostId: string | null;
}

/**
 * Folds the project's answers into the ones the request stated.
 *
 * Two different rules here, and the difference between them is the difference
 * between a preference and a permission.
 *
 * The scalars — model, effort, Mac — fall through with `??`: a field the client
 * sent is a decision somebody made about this one task and it stands, and a
 * field it omitted has no per-task opinion, so the project's is the next-best
 * answer.
 *
 * The approval mode does NOT fall through, it MEETS. Falling through would mean
 * a project set to "Ask before every change" is ignored by every client that
 * states a mode — which is every browser build since the segmented control
 * shipped, because the composer always sends the value it is showing. The
 * project would be a setting that visibly does nothing on the surface most
 * people reach it from. Taking the narrower of the two instead makes it bind,
 * and it can only ever bind downwards: acting stricter than the composer
 * disclosed is the safe direction of that disagreement, and it is the same meet
 * `resolveApprovalMode` already performs against the Mac's own floor at
 * dispatch.
 *
 * Connectors intersect for the same reason, and the empty cases are why this is
 * written out rather than expressed with `??`. A project that names three apps
 * is saying which apps tasks filed here may reach; a task inside it may pick
 * among those and may not add a fourth. A project that named none has no
 * opinion, and the task's own list is then the whole answer.
 */
export function resolveSessionFields(
  chosen: WorkSessionChoices,
  inherited: InheritedFromProject
): ResolvedSessionFields {
  const offered = inherited.connectorIds;
  const connectorIds =
    chosen.connectorIds === undefined
      ? offered
      : offered === null
        ? [...chosen.connectorIds]
        : chosen.connectorIds.filter((id) => offered.includes(id));

  return {
    model: chosen.model ?? inherited.model,
    reasoningEffort: chosen.reasoningEffort ?? inherited.reasoningEffort,
    permissionPolicy: narrowestPolicy(
      chosen.permissionPolicy ?? DEFAULT_WORK_PERMISSION_POLICY,
      inherited.permissionPolicy
    ),
    connectorIds,
    preferredHostId: chosen.preferredHostId ?? inherited.preferredHostId,
  };
}
