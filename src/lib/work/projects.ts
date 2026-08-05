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

import {
  narrowestBudget,
  narrowestPolicy,
  type WorkBudget,
  type WorkPermissionPolicy,
  type WorkTarget,
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
  for (const key of ["connectorIds", "grantIds", "skillIds"] as const) {
    const value = source[key];
    if (Array.isArray(value)) {
      const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0);
      if (ids.length > 0) out[key] = ids;
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
