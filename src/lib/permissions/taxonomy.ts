/**
 * The unified permission model (BRIEF §6): four risk tiers, six grants, the
 * ceilings and hard floors every runtime must respect, and the projection of
 * each runtime's native risk names onto the tiers.
 *
 * Re-exported by src/lib/action-approval.ts, the broker that is the
 * authorization authority. Pure and import-light on purpose: Work's domain
 * (shared with clients) imports it, and the shared contract
 * contracts/permissions/permission-taxonomy.v1.json is checked against it by
 * tests/permission-conformance.test.ts, the agent-core runner's own test and
 * the Swift test that reads the same file.
 */

import { toolNameTokens } from "@/lib/tool-access";

//
// One risk taxonomy and one grant vocabulary for every dispatch boundary:
// connector/MCP and Juno's own chat tools (this broker), Work runs and Orbit
// agent tasks (src/lib/work/domain.ts, runner/agent-core/src/work/types.ts,
// WorkRisk.swift), Alevr Code (runner/agent-core/src/permissions.ts,
// PermissionModel.swift), computer and browser actions (Work's tools) and
// Alevr Secrets grants. Each runtime keeps its own native risk names — they
// are stored in rows, advertised by Macs and decoded by clients — and maps
// onto these four tiers through `RUNTIME_RISK_TIERS`, which the shared
// contract (contracts/permissions/permission-taxonomy.v1.json) pins and every
// runtime's tests read. This is a projection, not a second engine: each
// runtime's own decision function stays the enforcement point, and the
// conformance matrix proves none of them is looser than the floors below.
// ─────────────────────────────────────────────────────────────────────────────

export const PERMISSION_TIERS = [
  "safe_read",
  "reversible_write",
  "external_action",
  "destructive_sensitive",
] as const;
export type PermissionTier = (typeof PERMISSION_TIERS)[number];

/** What a person can answer, narrowest to widest. The labels are the product's words. */
export const PERMISSION_GRANTS = [
  "block",
  "ask_every_time",
  "allow_once",
  "allow_for_task",
  "allow_for_site",
  "always_allow",
] as const;
export type PermissionGrant = (typeof PERMISSION_GRANTS)[number];

export const PERMISSION_GRANT_LABEL: Readonly<Record<PermissionGrant, string>> = {
  block: "Block",
  ask_every_time: "Ask every time",
  allow_once: "Allow once",
  allow_for_task: "Allow for this task",
  allow_for_site: "Allow for this site or app",
  always_allow: "Always allow",
};

export const PERMISSION_TIER_LABEL: Readonly<Record<PermissionTier, string>> = {
  safe_read: "Reads only",
  reversible_write: "Reversible change",
  external_action: "Leaves Alevr",
  destructive_sensitive: "Cannot be undone or sensitive",
};

/**
 * The widest standing answer each tier may ever hold. External actions can be
 * allowed for one task at most; destructive or sensitive ones only once.
 */
export const PERMISSION_GRANT_CEILING: Readonly<Record<PermissionTier, PermissionGrant>> = {
  safe_read: "always_allow",
  reversible_write: "always_allow",
  external_action: "allow_for_task",
  destructive_sensitive: "allow_once",
};

/**
 * Categories that pin an action to "Allow once" whatever its tier, so a
 * misgraded tool cannot reach a standing approval for them.
 */
export const HARD_FLOOR_CATEGORIES = ["destructive", "sensitive", "financial", "credential", "account_security"] as const;
export type HardFloorCategory = (typeof HARD_FLOOR_CATEGORIES)[number];

const GRANT_RANK: Readonly<Record<PermissionGrant, number>> = {
  block: -2,
  ask_every_time: -1,
  allow_once: 0,
  allow_for_task: 1,
  allow_for_site: 2,
  always_allow: 3,
};

/**
 * Every runtime's native risk vocabulary onto the four tiers. Unknown, and
 * every name not listed, is `external_action` at least (see `tierOf`).
 */
export const RUNTIME_RISK_TIERS = {
  /** This broker: connectors, MCP, Juno's own chat tools, agent setup changes. */
  action_broker: {
    read_only: "safe_read",
    reversible_write: "reversible_write",
    external_write: "external_action",
    destructive_or_sensitive: "destructive_sensitive",
    unknown: "external_action",
  },
  /** Juno's tool registry declarations (src/lib/tools/types.ts ToolRisk). */
  tool_registry: {
    read: "safe_read",
    write: "reversible_write",
    external: "external_action",
    destructive: "destructive_sensitive",
  },
  /** Work runs and Orbit agent tasks (WorkRiskLevel, TS runner and Swift). */
  work: {
    safe: "safe_read",
    edit: "reversible_write",
    command: "external_action",
    sensitive: "destructive_sensitive",
    irreversible: "destructive_sensitive",
  },
  /** Alevr Code, cloud runner (RiskLevel). */
  code_runner: {
    safe: "safe_read",
    edit: "reversible_write",
    command: "external_action",
    sensitive: "destructive_sensitive",
  },
  /** Alevr Code on the Mac (ActionRisk). `critical` reaches the network inside the workspace. */
  code_native: {
    read: "safe_read",
    write: "reversible_write",
    execute: "external_action",
    critical: "external_action",
    destructive: "destructive_sensitive",
  },
} as const satisfies Record<string, Record<string, PermissionTier>>;

export type PermissionRuntime = keyof typeof RUNTIME_RISK_TIERS;

/** A runtime's native risk as a tier. Anything unrecognised is at least an external action. */
export function tierOf(runtime: PermissionRuntime, risk: string): PermissionTier {
  const table = RUNTIME_RISK_TIERS[runtime] as Readonly<Record<string, PermissionTier>>;
  return Object.prototype.hasOwnProperty.call(table, risk) ? table[risk] : "external_action";
}

/** Word tokens that place an action in a hard-floor category (pinned by the contract). */
export const HARD_FLOOR_TOKENS: Readonly<Record<HardFloorCategory, readonly string[]>> = {
  destructive: ["delete", "destroy", "drop", "erase", "trash", "remove", "wipe", "merge", "deploy", "empty", "purge"],
  sensitive: [],
  financial: ["pay", "payment", "purchase", "buy", "checkout", "refund", "transfer", "invoice", "order", "subscribe", "charge"],
  credential: ["credential", "credentials", "password", "passphrase", "token", "secret", "otp", "2fa", "mfa", "login"],
  account_security: ["account", "security", "permission", "permissions", "role", "roles", "sharing", "invite", "lock", "unlock", "revoke", "reset"],
};

const FLOOR_TOKENS: ReadonlyArray<[HardFloorCategory, ReadonlySet<string>]> = HARD_FLOOR_CATEGORIES.map(
  (category) => [category, new Set(HARD_FLOOR_TOKENS[category])],
);

/**
 * The hard-floor categories an action name falls in. Deterministic and
 * deliberately broad: a false positive costs one extra question; a false
 * negative could become a standing approval for a purchase.
 */
export function hardFloorCategories(action: string, riskTier?: PermissionTier): HardFloorCategory[] {
  const tokens = new Set(toolNameTokens(action.replace(/[.:]/g, "_")));
  const out = new Set<HardFloorCategory>();
  for (const [category, words] of FLOOR_TOKENS) {
    for (const token of tokens) if (words.has(token)) out.add(category);
  }
  if (riskTier === "destructive_sensitive") out.add("sensitive");
  return [...out];
}

/**
 * Whether a person may give this answer for an action of this tier and these
 * categories. Narrowing (Block, Ask every time) is always allowed. The model
 * never calls this to grant itself anything: a grant is minted only by a
 * signed-in decision route, which checks it here first.
 */
export function mayGrant(input: { tier: PermissionTier; categories?: readonly HardFloorCategory[] }, grant: PermissionGrant): boolean {
  if (GRANT_RANK[grant] <= GRANT_RANK.allow_once) return true;
  if (input.tier === "destructive_sensitive") return false;
  if (input.categories && input.categories.length > 0) return false;
  return GRANT_RANK[grant] <= GRANT_RANK[PERMISSION_GRANT_CEILING[input.tier]];
}

/** The widest grant a person may give here — what an approval card may offer. */
export function widestGrant(input: { tier: PermissionTier; categories?: readonly HardFloorCategory[] }): PermissionGrant {
  for (const grant of [...PERMISSION_GRANTS].reverse()) if (mayGrant(input, grant)) return grant;
  return "allow_once";
}

/**
 * How each runtime's stored answers read in the shared vocabulary. A
 * connector `allow_scope` is a standing account/project grant ("Always
 * allow"); Work's `allowed_always` lasts the rest of one task.
 */
export const RUNTIME_DECISION_GRANTS = {
  action_broker: { allow_once: "allow_once", allow_scope: "always_allow", deny: "block" },
  work: { allowed: "allow_once", allowed_always: "allow_for_task", denied: "block" },
  code_runner: { allow: "allow_once", allow_always: "allow_for_task", deny: "block" },
  secrets: { grant: "allow_for_task" },
} as const satisfies Record<string, Record<string, PermissionGrant>>;


/**
 * Whether the connector broker may offer, and record, a standing ("Always
 * allow") grant for this tool. Deterministic: the tier's ceiling allows it and
 * the tool name is in no hard-floor category. (Every model-authored call is
 * already treated as derived from untrusted content — src/lib/mcp.ts,
 * src/lib/tools/dispatch.ts — which is why the ceiling, not provenance, is
 * what keeps standing grants to reversible writes.)
 */
export function mayAllowScope(input: { riskClass: string; toolName: string }): boolean {
  if (input.riskClass !== "reversible_write") return false;
  return mayGrant(
    { tier: tierOf("action_broker", input.riskClass), categories: hardFloorCategories(input.toolName) },
    "always_allow",
  );
}
