/**
 * Reusable, versioned Work skills — and the one thing a skill must never be
 * able to do.
 *
 * A skill is instructions plus a declaration of what it wants: tools,
 * connectors, apps, domains, a policy, a budget. The declaration is a REQUEST,
 * never a grant. `resolveSkillPermissions` intersects it with what the user,
 * the project and the host have already granted, and the intersection can only
 * ever come out smaller. That is the whole security argument for the feature:
 * skills are shared, imported, pasted out of a forum post and run against
 * somebody's Downloads folder, so a skill that could add a tool to a run would
 * be a privilege-escalation primitive shipped as a convenience feature, and it
 * would be shipped to exactly the users least able to read what they just
 * installed.
 *
 * Two shapes of that mistake are easy to make and are guarded against by
 * construction rather than by review:
 *
 *   - a union instead of an intersection, which is one wrong operator; and
 *   - an intersection over an empty list of grant layers, which is
 *     mathematically everything and would hand a skill the full toolset the
 *     first time a caller passed a layer list it had not populated yet.
 *
 * `narrowestGrant` refuses the second explicitly, and every resolved list is
 * built by filtering the request rather than by merging anything.
 *
 * Deliberately free of `server-only` and of a Prisma client — the `@prisma/client`
 * import is types only, exactly as in `./serializers`. The cloud runner, the
 * planner, the route handlers and the tests all need this, and three of those
 * four cannot open a database. `tests/work-skills.test.ts` imports this module
 * and nothing else.
 *
 * Nothing here re-declares a union that `./domain` owns. Trust, skill origin
 * and example verdicts are vocabularies that exist only for skills, which is
 * why they are declared here and nowhere else.
 */

import { z } from "zod";
import type { Prisma, WorkSkill, WorkSkillVersion } from "@prisma/client";
import {
  NO_BUDGET,
  WORK_PERMISSION_POLICIES,
  WORK_TARGETS,
  narrowestBudget,
  narrowestPolicy,
  type WorkBudget,
  type WorkDegradation,
  type WorkPermissionPolicy,
} from "@/lib/work/domain";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export const MAX_SKILL_SLUG_CHARS = 64;
export const MAX_SKILL_NAME_CHARS = 200;
export const MAX_SKILL_DESCRIPTION_CHARS = 2_000;
/**
 * A skill is a set of instructions, not a corpus. Anything larger belongs in a
 * file the skill is pointed at, where it can be revised without minting a
 * version of the skill and without being re-sent on every planning turn.
 */
export const MAX_SKILL_INSTRUCTIONS_CHARS = 50_000;
export const MAX_REQUESTED_TOOLS = 64;
export const MAX_REQUESTED_NAMES = 32;
export const MAX_CONTRACT_FIELDS = 32;
export const MAX_SKILL_EXAMPLES = 20;

const MAX_FIELD_NAME_CHARS = 80;
const MAX_FIELD_DESCRIPTION_CHARS = 500;
const MAX_EXAMPLE_NAME_CHARS = 120;
const MAX_EXAMPLE_INPUT_CHARS = 4_000;
const MAX_EXAMPLE_EXPECTATION_CHARS = 200;
const MAX_MODEL_ID_CHARS = 200;
const MAX_DOMAIN_CHARS = 253;
const MAX_ID_CHARS = 200;

/**
 * Ceilings on the ceilings.
 *
 * A budget is only ever narrowed, so an absurd value here cannot widen a run —
 * but `narrowestBudget` treats zero as "no ceiling at this layer", and a value
 * one below the integer maximum is the same thing wearing a number. The column
 * is an Int, so anything above 2^31-1 also fails the write rather than the
 * validation, which is a 500 where a 400 belongs.
 */
const MAX_BUDGET_MICRO_USD = 1_000_000_000;
const MAX_BUDGET_TOKENS = 100_000_000;
const MAX_BUDGET_RUNTIME_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

/**
 * How much the account vouches for this skill.
 *
 * `untrusted` is where an import lands and it is not a warning badge — it is
 * the state in which the planner may not reach for the skill on its own. The
 * user can still invoke it by name, because they typed the name.
 */
export const WORK_SKILL_TRUST_LEVELS = ["untrusted", "user_authored", "verified"] as const;
export type WorkSkillTrust = (typeof WORK_SKILL_TRUST_LEVELS)[number];

/**
 * Trust levels a client may set.
 *
 * `verified` is absent, and that absence is the point. It means Juno reviewed
 * the skill, and it is the badge a user reads before letting a skill run
 * unattended against their files. A client that could set it could import a
 * skill from anywhere and mark it reviewed, which turns the strongest claim in
 * the vocabulary into the cheapest one. Moving from `untrusted` to
 * `user_authored` is a real decision the user is entitled to make about their
 * own account, and moving back is how they withdraw it.
 */
export const CLIENT_SKILL_TRUST_LEVELS = ["untrusted", "user_authored"] as const;
export type ClientSkillTrust = (typeof CLIENT_SKILL_TRUST_LEVELS)[number];

/** Where a skill came from, which is what decides its starting trust. */
export const WORK_SKILL_ORIGINS = ["authored", "imported"] as const;
export type WorkSkillOrigin = (typeof WORK_SKILL_ORIGINS)[number];

export function trustForOrigin(origin: WorkSkillOrigin): WorkSkillTrust {
  return origin === "imported" ? "untrusted" : "user_authored";
}

/**
 * Whether the planner may reach for this skill without being asked.
 *
 * Takes a plain string and fails closed on anything it does not recognise. The
 * column is TEXT so a trust level can ship as code, which means a row written
 * by a newer deployment can legitimately hold a value this build has never
 * seen — and the safe reading of a value we cannot interpret is that it does
 * not authorise automatic selection.
 */
export function trustPermitsAutoSelection(trust: string): boolean {
  return trust === "user_authored" || trust === "verified";
}

/** An unreadable trust level is `untrusted`, for the reason above. */
export function coerceSkillTrust(value: string): WorkSkillTrust {
  return (WORK_SKILL_TRUST_LEVELS as readonly string[]).includes(value)
    ? (value as WorkSkillTrust)
    : "untrusted";
}

// ---------------------------------------------------------------------------
// Slugs and slash invocation
// ---------------------------------------------------------------------------

/** Lowercase words joined by single hyphens. The slash name, and the only one. */
export const SKILL_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Validates a slug the caller supplied, lowercasing and trimming first.
 *
 * Returns null rather than a repaired value for anything else. A slug is what a
 * user types after a slash and what a schedule names, so silently repairing
 * `Tidy Downloads!` into `tidy-downloads` at write time and then failing to
 * repair the same string at invocation time gives a skill a name its author
 * cannot type.
 */
export function normalizeSkillSlug(raw: string): string | null {
  const slug = raw.trim().toLowerCase();
  if (slug.length === 0 || slug.length > MAX_SKILL_SLUG_CHARS) return null;
  return SKILL_SLUG_PATTERN.test(slug) ? slug : null;
}

/**
 * Derives a candidate slug from a display name, for the client that did not
 * supply one.
 *
 * Everything outside `[a-z0-9]` becomes a separator, runs collapse, and the
 * result is truncated on a hyphen boundary so a cut name does not end in one.
 * Returns null when nothing usable survives — a name written entirely in a
 * script this pattern cannot represent has no slug, and inventing `skill-1` for
 * it would give the user a name they have no reason to remember.
 */
export function skillSlugFromName(name: string): string | null {
  const collapsed = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (collapsed.length === 0) return null;
  const truncated = collapsed.slice(0, MAX_SKILL_SLUG_CHARS).replace(/-+$/g, "");
  return truncated.length === 0 ? null : truncated;
}

export interface SkillInvocation {
  slug: string;
  /** Everything after the slug, which is the request the skill is applied to. */
  remainder: string;
}

/**
 * Reads a leading `/slug …` invocation out of a message.
 *
 * Returns null for anything that is not one, and the cases that matter are the
 * near misses. A message beginning `/Users/liam/Downloads is a mess` is a
 * person quoting a path, not invoking a skill called `Users`: the slug pattern
 * is lowercase-only, so it does not match and the message is left alone. A bare
 * `/` and a leading `//` likewise resolve to null rather than to a slug of the
 * empty string, which would otherwise match whichever skill sorted first.
 */
export function parseSkillInvocation(text: string): SkillInvocation | null {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const boundary = body.search(/\s/);
  const candidate = boundary === -1 ? body : body.slice(0, boundary);
  if (!SKILL_SLUG_PATTERN.test(candidate) || candidate.length > MAX_SKILL_SLUG_CHARS) return null;
  return {
    slug: candidate,
    remainder: boundary === -1 ? "" : body.slice(boundary).trim(),
  };
}

// ---------------------------------------------------------------------------
// The contract a version declares
// ---------------------------------------------------------------------------

/**
 * A tool, connector or app name as it is matched against a grant.
 *
 * Matching is exact string equality, so the only thing this pattern has to
 * exclude is a value that is not a name at all — a sentence, a path, a JSON
 * blob somebody pasted into the wrong field. Deliberately permissive about the
 * naming style itself: `work.file.move`, `gmail_send` and `sheets-read` are all
 * real shapes in this codebase and a stricter pattern would only mean the
 * grant side and the request side disagree about which of them is a name.
 */
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

const nameSchema = z.string().trim().regex(NAME_PATTERN);

export const SKILL_FIELD_KINDS = ["string", "number", "boolean", "file", "url"] as const;
export type SkillFieldKind = (typeof SKILL_FIELD_KINDS)[number];

const skillFieldSchema = z.object({
  name: z.string().trim().min(1).max(MAX_FIELD_NAME_CHARS),
  kind: z.enum(SKILL_FIELD_KINDS),
  required: z.boolean().default(false),
  description: z.string().trim().max(MAX_FIELD_DESCRIPTION_CHARS).default(""),
});

export type WorkSkillField = z.infer<typeof skillFieldSchema>;

/**
 * One worked example, stored on the version it describes.
 *
 * On the version rather than on the skill, because an example is a claim about
 * a particular set of instructions. Moved to the head it would keep passing or
 * failing across edits that changed the very behaviour it was written to pin.
 */
export const skillExampleSchema = z.object({
  name: z.string().trim().min(1).max(MAX_EXAMPLE_NAME_CHARS),
  input: z.string().trim().min(1).max(MAX_EXAMPLE_INPUT_CHARS),
  /** Tools the run must have used. */
  expectTools: z.array(nameSchema).max(MAX_REQUESTED_TOOLS).default([]),
  /** Tools the run must NOT have used, which is how a tier rule is pinned. */
  forbidTools: z.array(nameSchema).max(MAX_REQUESTED_TOOLS).default([]),
  expectContains: z
    .array(z.string().trim().min(1).max(MAX_EXAMPLE_EXPECTATION_CHARS))
    .max(MAX_SKILL_EXAMPLES)
    .default([]),
});

export type WorkSkillExample = z.infer<typeof skillExampleSchema>;

const budgetSchema = z.object({
  maxCostMicroUsd: z.number().int().min(0).max(MAX_BUDGET_MICRO_USD).default(0),
  maxTokens: z.number().int().min(0).max(MAX_BUDGET_TOKENS).default(0),
  maxRuntimeMs: z.number().int().min(0).max(MAX_BUDGET_RUNTIME_MS).default(0),
});

/**
 * Everything a version declares apart from its instructions and its tools.
 *
 * Every field named `requested*` or `preferred*` is a wish. None of them is
 * honoured as written: connectors, apps and domains are intersected with the
 * grant, the policy and the budget go through `narrowestPolicy` and
 * `narrowestBudget`, and the target and model are hints the executor may
 * substitute and then record as a degradation. The naming is load-bearing —
 * a field called `allowedTools` on a row a user can import reads like an
 * allowance, and somebody eventually treats it as one.
 */
export const skillContractSchema = z.object({
  inputs: z.array(skillFieldSchema).max(MAX_CONTRACT_FIELDS).default([]),
  outputs: z.array(skillFieldSchema).max(MAX_CONTRACT_FIELDS).default([]),
  requestedConnectors: z.array(nameSchema).max(MAX_REQUESTED_NAMES).default([]),
  requestedApps: z.array(nameSchema).max(MAX_REQUESTED_NAMES).default([]),
  requestedDomains: z
    .array(z.string().trim().min(1).max(MAX_DOMAIN_CHARS))
    .max(MAX_REQUESTED_NAMES)
    .default([]),
  preferredTarget: z.enum(WORK_TARGETS).nullable().default(null),
  preferredModel: z.string().trim().min(1).max(MAX_MODEL_ID_CHARS).nullable().default(null),
  requestedPolicy: z.enum(WORK_PERMISSION_POLICIES).nullable().default(null),
  requestedBudget: budgetSchema.default({ maxCostMicroUsd: 0, maxTokens: 0, maxRuntimeMs: 0 }),
  examples: z.array(skillExampleSchema).max(MAX_SKILL_EXAMPLES).default([]),
});

export type WorkSkillContract = z.infer<typeof skillContractSchema>;

/** A contract with every list empty and every preference unset. */
export function emptySkillContract(): WorkSkillContract {
  return skillContractSchema.parse({});
}

/**
 * Reads the `contract` column back into a contract.
 *
 * Never throws, and falls back to the empty contract rather than to anything
 * partial. The column is JSONB written by whichever deployment last edited the
 * skill, so a row this build cannot parse is a real and expected state, and the
 * empty contract asks for nothing — a skill that suddenly requests nothing is
 * visible to the user as a skill that stopped working, whereas a skill quietly
 * granted half of what it declared is visible to nobody.
 */
export function parseSkillContract(raw: unknown): WorkSkillContract {
  const parsed = skillContractSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : emptySkillContract();
}

/**
 * Reads the `requestedTools` column.
 *
 * Entries that are not names are dropped one by one rather than failing the
 * whole list, which is the opposite of what `parseSkillContract` does above and
 * is right for the opposite reason: this is a flat array of independent names,
 * so one bad entry says nothing about the others, and every entry that survives
 * still has to clear the intersection before it means anything.
 */
export function parseRequestedTools(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tools: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (!NAME_PATTERN.test(name) || seen.has(name)) continue;
    seen.add(name);
    tools.push(name);
    if (tools.length >= MAX_REQUESTED_TOOLS) break;
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Permission resolution — the part that may only ever narrow
// ---------------------------------------------------------------------------

/** What a skill version asks for, gathered from its two columns. */
export interface WorkSkillRequest {
  tools: readonly string[];
  connectors: readonly string[];
  apps: readonly string[];
  domains: readonly string[];
  /** Null when the skill expresses no preference, which narrows nothing. */
  policy: WorkPermissionPolicy | null;
  budget: WorkBudget;
}

export function skillRequestFrom(version: {
  requestedTools: readonly string[];
  contract: WorkSkillContract;
}): WorkSkillRequest {
  return {
    tools: version.requestedTools,
    connectors: version.contract.requestedConnectors,
    apps: version.contract.requestedApps,
    domains: version.contract.requestedDomains,
    policy: version.contract.requestedPolicy,
    budget: version.contract.requestedBudget,
  };
}

/** The same, straight from a stored row. */
export function skillRequestFromRow(
  version: Pick<WorkSkillVersion, "requestedTools" | "contract">
): WorkSkillRequest {
  return skillRequestFrom({
    requestedTools: parseRequestedTools(version.requestedTools),
    contract: parseSkillContract(version.contract),
  });
}

/**
 * One layer of what has already been granted, as that layer granted it.
 *
 * The caller passes every layer that applies — the account's tool access, the
 * project's, the host's advertised and enabled capabilities, the session's
 * policy — and they are intersected before the skill is considered at all.
 * Passing them separately rather than pre-merged is what lets `narrowestGrant`
 * refuse the empty list, which a pre-merged single value cannot express.
 */
export interface WorkSkillGrantLayer {
  tools: readonly string[];
  connectors: readonly string[];
  apps: readonly string[];
  domains: readonly string[];
  policy: WorkPermissionPolicy;
  /** Omitted when this layer sets no ceiling of its own. */
  budget?: WorkBudget;
}

export interface WorkSkillGrant {
  tools: string[];
  connectors: string[];
  apps: string[];
  domains: string[];
  policy: WorkPermissionPolicy;
  budget: WorkBudget;
}

/**
 * A grant that permits nothing.
 *
 * Returned fresh each call rather than shared, so a caller that sorts or pushes
 * into one of the arrays cannot widen every future empty grant in the process.
 *
 * The budget is `NO_BUDGET`, which reads as "no ceiling" and looks like the
 * wrong direction. It is not reachable as one: the columns are Ints where zero
 * means unlimited, so "spend nothing" has no representation, and it needs none
 * because a caller holding this value may use no tool, no connector, no app and
 * no domain, and therefore spends nothing.
 */
function emptyGrant(): WorkSkillGrant {
  return {
    tools: [],
    connectors: [],
    apps: [],
    domains: [],
    policy: "conservative",
    budget: { ...NO_BUDGET },
  };
}

function intersectAll(lists: readonly (readonly string[])[]): string[] {
  let kept = [...new Set(lists[0])];
  for (let index = 1; index < lists.length; index++) {
    const present = new Set(lists[index]);
    kept = kept.filter((name) => present.has(name));
  }
  return kept;
}

/**
 * Intersects every grant layer into the one grant a skill is measured against.
 *
 * An empty layer list returns a grant that permits nothing, and that special
 * case is the reason this function exists rather than a chain of `narrowest*`
 * calls at the call site. The intersection of no sets is, mathematically,
 * everything: a fold that starts from "all tools" and narrows per layer hands
 * back the complete toolset the first time a caller passes a list it had not
 * populated yet — a missing await, a host whose capabilities have not loaded, a
 * project with no row. `narrowestPolicy()` has the same shape of answer for the
 * same reason, returning `permissive` when handed nothing, so it is never
 * called with a spread that might be empty.
 */
export function narrowestGrant(layers: readonly WorkSkillGrantLayer[]): WorkSkillGrant {
  if (layers.length === 0) return emptyGrant();
  return {
    tools: intersectAll(layers.map((layer) => layer.tools)),
    connectors: intersectAll(layers.map((layer) => layer.connectors)),
    apps: intersectAll(layers.map((layer) => layer.apps)),
    domains: intersectAll(layers.map((layer) => layer.domains)),
    policy: narrowestPolicy(...layers.map((layer) => layer.policy)),
    budget: narrowestBudget(...layers.map((layer) => layer.budget)),
  };
}

export interface WithheldFromSkill {
  tools: string[];
  connectors: string[];
  apps: string[];
  domains: string[];
}

export interface ResolvedSkillPermissions {
  tools: string[];
  connectors: string[];
  apps: string[];
  domains: string[];
  policy: WorkPermissionPolicy;
  budget: WorkBudget;
  /**
   * What the skill asked for and did not get.
   *
   * Reported rather than dropped silently, because a skill doing three of the
   * five things it promised is otherwise indistinguishable from a skill that
   * only ever promised three, and the user's actual question — "why did it not
   * file the invoice" — has an answer nobody can see.
   */
  withheld: WithheldFromSkill;
}

function intersectRequest(
  requested: readonly string[],
  granted: readonly string[]
): { kept: string[]; withheld: string[] } {
  const available = new Set(granted);
  const kept: string[] = [];
  const withheld: string[] = [];
  const seen = new Set<string>();
  for (const name of requested) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (available.has(name)) kept.push(name);
    else withheld.push(name);
  }
  return { kept, withheld };
}

/**
 * Resolves what a skill may actually use on this run.
 *
 * The result is a subset of the request AND a subset of every grant layer, and
 * it is built by filtering the request rather than by combining anything, so
 * there is no operator here that could be the wrong one. Order follows the
 * request, because a skill lists its tools in the order it means to reach for
 * them and re-sorting the list throws that away.
 *
 * An empty request resolves to nothing. That is the deliberate reading: a
 * version that declares no tools is a version that asks for none, not a version
 * that asks for everything. The alternative — treating the empty list as a
 * wildcard — turns a field somebody forgot to fill in into the widest grant in
 * the system, which is precisely the accident this module exists to make
 * impossible.
 *
 * The policy and the budget go through `narrowestPolicy` and `narrowestBudget`
 * rather than being compared here, so a skill asking for `permissive` inside a
 * `conservative` session gets `conservative`, and a skill asking for a bigger
 * ceiling than the host allows gets the host's.
 */
export function resolveSkillPermissions(input: {
  request: WorkSkillRequest;
  granted: readonly WorkSkillGrantLayer[];
}): ResolvedSkillPermissions {
  const grant = narrowestGrant(input.granted);
  const tools = intersectRequest(input.request.tools, grant.tools);
  const connectors = intersectRequest(input.request.connectors, grant.connectors);
  const apps = intersectRequest(input.request.apps, grant.apps);
  const domains = intersectRequest(input.request.domains, grant.domains);

  return {
    tools: tools.kept,
    connectors: connectors.kept,
    apps: apps.kept,
    domains: domains.kept,
    policy: narrowestPolicy(grant.policy, input.request.policy),
    budget: narrowestBudget(grant.budget, input.request.budget),
    withheld: {
      tools: tools.withheld,
      connectors: connectors.withheld,
      apps: apps.withheld,
      domains: domains.withheld,
    },
  };
}

/** True when the skill got everything it asked for. */
export function skillWasFullyGranted(resolved: ResolvedSkillPermissions): boolean {
  const { tools, connectors, apps, domains } = resolved.withheld;
  return tools.length + connectors.length + apps.length + domains.length === 0;
}

// ---------------------------------------------------------------------------
// Versioning
// ---------------------------------------------------------------------------

/** The complete content of one version. A version is a snapshot, not a patch. */
export interface WorkSkillVersionContent {
  instructions: string;
  contract: WorkSkillContract;
  contractVersion: number;
  requestedTools: string[];
}

/** The contract-shape version this build writes. */
export const SKILL_CONTRACT_VERSION = 1;

/**
 * The number a newly minted version takes.
 *
 * Derived from the highest version that exists, never from `currentVersion`.
 * `currentVersion` is a pointer and a restore moves it backwards: a skill with
 * five versions that the user restored to version 3 has `currentVersion: 3`,
 * and `currentVersion + 1` is 4 — a number already taken. The unique index on
 * `(skillId, version)` turns that into a failed write, so the symptom is that a
 * user who restored an old version once can never edit the skill again.
 */
export function nextSkillVersion(highestVersion: number): number {
  return Math.max(0, Math.floor(highestVersion)) + 1;
}

export type SkillVersionChoice =
  | {
      ok: true;
      version: number;
      /** True when a caller pinned this rather than following the pointer. */
      pinned: boolean;
      degradation: WorkDegradation[];
    }
  | { ok: false; reason: "no_such_version" };

/**
 * Decides which version of a skill a run uses.
 *
 * A pin that names a version which no longer exists is refused rather than
 * quietly resolved to the current one. The whole reason a schedule pins version
 * 3 is that version 4 behaves differently; falling back to whatever is current
 * would deliver exactly the change the pin was written to prevent, at 3am, with
 * nobody watching. Refusing gives the user a broken schedule they can see.
 *
 * A pin that resolves to something other than the pointer produces a
 * `skill_version_pinned` degradation, which is how the run's summary can say
 * "this used version 3, and the skill is now on version 5" — a sentence that is
 * otherwise unavailable to anyone reading the run a month later.
 */
export function selectSkillVersion(input: {
  slug: string;
  currentVersion: number;
  availableVersions: readonly number[];
  pinnedVersion?: number | null;
}): SkillVersionChoice {
  const available = new Set(input.availableVersions);
  const pinned = input.pinnedVersion ?? null;

  if (pinned !== null) {
    if (!available.has(pinned)) return { ok: false, reason: "no_such_version" };
    return {
      ok: true,
      version: pinned,
      pinned: true,
      degradation:
        pinned === input.currentVersion
          ? []
          : [
              {
                kind: "skill_version_pinned",
                subject: input.slug,
                explanation: `Used version ${pinned} of ${input.slug}, which is pinned. The skill is now on version ${input.currentVersion}.`,
              },
            ],
    };
  }

  // A head pointing at a row that is not there is a data fault, not a reason to
  // improvise: running the newest version instead would run instructions the
  // user did not choose, under a tool request they have not seen.
  if (!available.has(input.currentVersion)) return { ok: false, reason: "no_such_version" };
  return { ok: true, version: input.currentVersion, pinned: false, degradation: [] };
}

/**
 * The `WorkRunIO` row that records which version actually ran.
 *
 * This is what makes "which skill ran" answerable after the skill has been
 * edited. `refId` is the version row's id rather than the skill's, because the
 * skill's id resolves to whatever the instructions say today, which is the one
 * thing the question is never asking.
 */
export interface SkillVersionRunReference {
  direction: "input";
  refKind: "skill_version";
  refId: string;
  /** Display label safe for any client — a slug and a number, never a path. */
  label: string;
  detail: {
    skillId: string;
    slug: string;
    version: number;
    trust: WorkSkillTrust;
    pinned: boolean;
  };
}

export function skillVersionRunReference(input: {
  versionRowId: string;
  skillId: string;
  slug: string;
  version: number;
  trust: string;
  pinned: boolean;
}): SkillVersionRunReference {
  return {
    direction: "input",
    refKind: "skill_version",
    refId: input.versionRowId,
    label: `${input.slug} v${input.version}`,
    detail: {
      skillId: input.skillId,
      slug: input.slug,
      version: input.version,
      trust: coerceSkillTrust(input.trust),
      pinned: input.pinned,
    },
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * How sure the planner has to be before it reaches for a skill unasked.
 *
 * High, and deliberately so. The cost of not selecting a skill is that the run
 * does the work the ordinary way; the cost of selecting the wrong one is a run
 * that follows somebody else's instructions about somebody else's folder and
 * reports success.
 */
export const SKILL_AUTO_SELECT_MIN_CONFIDENCE = 0.75;

export interface SkillCandidate {
  id: string;
  slug: string;
  enabled: boolean;
  /** As stored. Coerced here rather than by the caller, and fails closed. */
  trust: string;
  autoSelect: boolean;
  currentVersion: number;
}

export interface ScoredSkillCandidate {
  candidate: SkillCandidate;
  /** Planner confidence in [0, 1]. NaN never clears the threshold. */
  confidence: number;
}

export const SKILL_SELECTION_REFUSALS = [
  /** No skill of that slug, for this user. */
  "unknown_slug",
  "disabled",
  /** The skill exists and is trusted, but automatic selection is switched off. */
  "auto_select_disabled",
  /** Imported and not vouched for. Never auto-selected, at any confidence. */
  "untrusted",
  "low_confidence",
  /** Two eligible skills scored identically. Picking either would be a guess. */
  "ambiguous",
  "no_candidate",
] as const;

export type SkillSelectionRefusal = (typeof SKILL_SELECTION_REFUSALS)[number];

export type SkillSelection =
  | { selected: true; candidate: SkillCandidate; via: "slash" | "automatic"; confidence: number }
  | { selected: false; reason: SkillSelectionRefusal };

/**
 * Explicit invocation by slug.
 *
 * Trust is NOT consulted, and that is the distinction the whole trust model
 * rests on. "An imported skill cannot be auto-selected" is a statement about
 * the planner choosing for the user; a user who typed `/tidy-downloads` has
 * chosen. Refusing here would make an imported skill unusable rather than
 * un-suggested, and the user's next move would be to mark it trusted just to
 * run it once — which would hand it automatic selection as well, and lose the
 * distinction entirely.
 *
 * A disabled skill is still refused: disabled is the user saying "not now" in
 * the one place they can say it.
 */
export function selectSkillBySlug(
  slug: string,
  candidates: readonly SkillCandidate[]
): SkillSelection {
  const candidate = candidates.find((entry) => entry.slug === slug);
  if (!candidate) return { selected: false, reason: "unknown_slug" };
  if (!candidate.enabled) return { selected: false, reason: "disabled" };
  return { selected: true, candidate, via: "slash", confidence: 1 };
}

function eligibleForAutoSelection(candidate: SkillCandidate): boolean {
  return candidate.enabled && candidate.autoSelect && trustPermitsAutoSelection(candidate.trust);
}

function autoSelectionRefusalFor(candidate: SkillCandidate): SkillSelectionRefusal {
  if (!candidate.enabled) return "disabled";
  // Trust before the toggle: `autoSelect` on an untrusted skill is a setting
  // that was never going to take effect, and reporting it would send the user
  // to switch on something that is already on.
  if (!trustPermitsAutoSelection(candidate.trust)) return "untrusted";
  return "auto_select_disabled";
}

/**
 * Automatic selection, gated on confidence and on trust.
 *
 * Ineligible candidates are removed before ranking rather than allowed to block
 * the decision. If they were merely refused at the top, importing one untrusted
 * skill that happens to match a request well would stop a trusted skill from
 * ever being selected for it — an import would be able to switch off a feature
 * for everything it resembled.
 *
 * When nothing is eligible, the refusal reported is the reason the best-scoring
 * candidate was excluded rather than `low_confidence`, because confidence is
 * not what stopped it and telling the user to be clearer would not help.
 */
export function selectSkillAutomatically(input: {
  scored: readonly ScoredSkillCandidate[];
  minConfidence?: number;
}): SkillSelection {
  if (input.scored.length === 0) return { selected: false, reason: "no_candidate" };
  const minConfidence = input.minConfidence ?? SKILL_AUTO_SELECT_MIN_CONFIDENCE;

  // Slug is the tie-break so the ranking is stable across calls; the tie itself
  // is still refused below rather than resolved alphabetically.
  const ranked = [...input.scored].sort(
    (a, b) => b.confidence - a.confidence || a.candidate.slug.localeCompare(b.candidate.slug)
  );
  const eligible = ranked.filter((entry) => eligibleForAutoSelection(entry.candidate));
  if (eligible.length === 0) {
    return { selected: false, reason: autoSelectionRefusalFor(ranked[0].candidate) };
  }

  const best = eligible[0];
  if (!(best.confidence >= minConfidence)) return { selected: false, reason: "low_confidence" };
  if (eligible.length > 1 && eligible[1].confidence === best.confidence) {
    return { selected: false, reason: "ambiguous" };
  }
  return {
    selected: true,
    candidate: best.candidate,
    via: "automatic",
    confidence: best.confidence,
  };
}

// ---------------------------------------------------------------------------
// Example evaluation
// ---------------------------------------------------------------------------

export const SKILL_EXAMPLE_VERDICTS = [
  "passed",
  "failed",
  /** No outcome was supplied for this example. */
  "not_run",
  /** The example needs a tool the resolver withheld, so it could not be run. */
  "not_permitted",
] as const;

export type SkillExampleVerdict = (typeof SKILL_EXAMPLE_VERDICTS)[number];

/** What a run of one example actually did, as observed by whoever ran it. */
export interface WorkSkillExampleOutcome {
  name: string;
  output: string;
  toolsUsed: readonly string[];
}

export interface WorkSkillExampleResult {
  name: string;
  verdict: SkillExampleVerdict;
  /** One sentence naming the first thing that was wrong. Empty when passed. */
  detail: string;
}

export interface WorkSkillEvaluation {
  results: WorkSkillExampleResult[];
  passed: number;
  failed: number;
  notRun: number;
  notPermitted: number;
  /**
   * True only when there was at least one example and every one of them ran and
   * passed. A version with no examples is not a version that passed its tests;
   * reporting it as one is how an untested skill acquires a green badge and
   * then gets switched on for unattended runs.
   */
  allPassed: boolean;
}

/**
 * Reports which examples a version passes, as a pure function of what was
 * declared and what was observed.
 *
 * Deliberately does not run anything. Executing an example means a model, a
 * host, a budget and several minutes, none of which belong inside a checker
 * that a route or a test needs an answer from synchronously — and the judgement
 * itself, which is the part worth being sure about, is exactly the part that
 * does not need any of them.
 *
 * `permitted` is the resolved tool set, when the caller has one. An example
 * that needs a tool the resolver withheld is `not_permitted` rather than
 * `failed`: the skill is fine and a connector was revoked, and filing that as a
 * failure sends whoever reads the report to rewrite instructions that were
 * never the problem.
 *
 * Text matching is case-insensitive. A model's capitalisation varies between
 * runs of the same prompt, and a case-sensitive check reports a working skill
 * as broken because it wrote "Downloads" where the example said "downloads".
 */
export function evaluateSkillExamples(input: {
  examples: readonly WorkSkillExample[];
  outcomes: readonly WorkSkillExampleOutcome[];
  permitted?: readonly string[] | null;
}): WorkSkillEvaluation {
  const byName = new Map(input.outcomes.map((outcome) => [outcome.name, outcome]));
  const permitted = input.permitted ? new Set(input.permitted) : null;
  const results = input.examples.map((example) =>
    evaluateOne(example, byName.get(example.name), permitted)
  );

  const count = (verdict: SkillExampleVerdict) =>
    results.reduce((total, result) => total + (result.verdict === verdict ? 1 : 0), 0);
  const passed = count("passed");

  return {
    results,
    passed,
    failed: count("failed"),
    notRun: count("not_run"),
    notPermitted: count("not_permitted"),
    allPassed: results.length > 0 && passed === results.length,
  };
}

function evaluateOne(
  example: WorkSkillExample,
  outcome: WorkSkillExampleOutcome | undefined,
  permitted: ReadonlySet<string> | null
): WorkSkillExampleResult {
  if (permitted) {
    const missing = example.expectTools.filter((tool) => !permitted.has(tool));
    if (missing.length > 0) {
      return {
        name: example.name,
        verdict: "not_permitted",
        detail: `This example needs ${missing.join(", ")}, which the skill was not granted.`,
      };
    }
  }
  if (!outcome) {
    return { name: example.name, verdict: "not_run", detail: "No result was recorded." };
  }

  const used = new Set(outcome.toolsUsed);
  // Forbidden first: a run that used a tool the example rules out has broken
  // the rule the example was written for, whatever else it got right.
  const forbidden = example.forbidTools.find((tool) => used.has(tool));
  if (forbidden !== undefined) {
    return {
      name: example.name,
      verdict: "failed",
      detail: `Used ${forbidden}, which this example forbids.`,
    };
  }
  const absent = example.expectTools.find((tool) => !used.has(tool));
  if (absent !== undefined) {
    return { name: example.name, verdict: "failed", detail: `Did not use ${absent}.` };
  }

  const haystack = outcome.output.toLowerCase();
  const missingText = example.expectContains.find(
    (needle) => !haystack.includes(needle.toLowerCase())
  );
  if (missingText !== undefined) {
    return {
      name: example.name,
      verdict: "failed",
      detail: `The result does not mention ${JSON.stringify(missingText)}.`,
    };
  }

  return { name: example.name, verdict: "passed", detail: "" };
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

const idSchema = z.string().trim().min(1).max(MAX_ID_CHARS);
const instructionsSchema = z.string().trim().min(1).max(MAX_SKILL_INSTRUCTIONS_CHARS);
const requestedToolsSchema = z.array(nameSchema).max(MAX_REQUESTED_TOOLS);

/**
 * The content of a version, as a client sends it.
 *
 * `contract` and `requestedTools` default to empty rather than inheriting from
 * the previous version. A version is a complete snapshot: one that filled in
 * its missing fields from its predecessor would make "what exactly did version
 * 3 ask for" a question whose answer is spread across two rows and changes when
 * the older one is read differently. The default is also the narrow one, so a
 * client that omits a field gets a version that asks for less, never more.
 */
export const skillVersionContentSchema = z.object({
  instructions: instructionsSchema,
  contract: skillContractSchema.optional(),
  requestedTools: requestedToolsSchema.optional(),
});

export const createSkillSchema = z.object({
  name: z.string().trim().min(1).max(MAX_SKILL_NAME_CHARS),
  /** Derived from `name` when absent. */
  slug: z.string().trim().min(1).max(MAX_SKILL_SLUG_CHARS).optional(),
  description: z.string().trim().max(MAX_SKILL_DESCRIPTION_CHARS).default(""),
  instructions: instructionsSchema,
  contract: skillContractSchema.optional(),
  requestedTools: requestedToolsSchema.optional(),
  projectId: idSchema.optional(),
  // Required rather than defaulted, because it decides the starting trust and
  // therefore whether the planner may ever reach for this on its own. A client
  // that has not said where the skill came from should be made to say it rather
  // than inherit the answer from whoever wrote the default.
  origin: z.enum(WORK_SKILL_ORIGINS),
  autoSelect: z.boolean().default(false),
});

export const patchSkillSchema = z
  .object({
    name: z.string().trim().min(1).max(MAX_SKILL_NAME_CHARS).optional(),
    description: z.string().trim().max(MAX_SKILL_DESCRIPTION_CHARS).optional(),
    enabled: z.boolean().optional(),
    autoSelect: z.boolean().optional(),
    trust: z.enum(CLIENT_SKILL_TRUST_LEVELS).optional(),
    // The slug is absent on purpose: it is what a user types after a slash and
    // what an older message in their history already says, so it is chosen once.
  })
  // An empty patch is a client bug, and answering it with 200 and an unchanged
  // skill hides that bug until somebody notices the rename never happened.
  .refine((body) => Object.keys(body).length > 0, { message: "no_recognised_fields" });

/**
 * Minting a version: either new content, or a restore of an existing one.
 *
 * A restore mints a copy rather than moving `currentVersion` backwards on its
 * own. Version history stays append-only, so "what was the skill doing on the
 * 3rd" keeps its answer, and the restore itself is a dated event rather than an
 * invisible pointer move.
 */
export const mintSkillVersionSchema = z
  .object({
    instructions: instructionsSchema.optional(),
    contract: skillContractSchema.optional(),
    requestedTools: requestedToolsSchema.optional(),
    restoreVersion: z.number().int().min(1).optional(),
  })
  .refine(
    (body) => (body.restoreVersion === undefined) !== (body.instructions === undefined),
    { message: "instructions_or_restore_version" }
  );

export const SKILL_LIST_DEFAULT_LIMIT = 50;
export const SKILL_LIST_MAX_LIMIT = 200;

export interface SkillListQuery {
  enabled?: boolean;
  autoSelect?: boolean;
  trust?: WorkSkillTrust;
  projectId?: string;
  limit: number;
}

export type SkillListQueryResult =
  | { ok: true; query: SkillListQuery }
  | { ok: false; parameter: string };

/**
 * Booleans in a query string, strictly. `"maybe"` is rejected rather than read
 * as false: a filter that ignores what it could not parse returns a plausible
 * list of the wrong skills and says nothing about having dropped the filter.
 */
function booleanParam(raw: string | null): boolean | null | undefined {
  if (raw === null) return undefined;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  return null;
}

export function parseSkillListQuery(params: URLSearchParams): SkillListQueryResult {
  const enabled = booleanParam(params.get("enabled"));
  if (enabled === null) return { ok: false, parameter: "enabled" };
  const autoSelect = booleanParam(params.get("autoSelect"));
  if (autoSelect === null) return { ok: false, parameter: "autoSelect" };

  const trust = params.get("trust");
  if (trust !== null && !(WORK_SKILL_TRUST_LEVELS as readonly string[]).includes(trust)) {
    return { ok: false, parameter: "trust" };
  }

  const projectId = params.get("projectId");
  if (projectId !== null && (projectId.length === 0 || projectId.length > MAX_ID_CHARS)) {
    return { ok: false, parameter: "projectId" };
  }

  // Unparseable falls back to the default rather than 400ing, and anything
  // parseable is clamped — the repo's query-param idiom, and what stops
  // `?limit=100000` turning a list view into a full-table read.
  const rawLimit = Number(params.get("limit") ?? String(SKILL_LIST_DEFAULT_LIMIT));
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), SKILL_LIST_MAX_LIMIT)
    : SKILL_LIST_DEFAULT_LIMIT;

  return {
    ok: true,
    query: {
      ...(enabled !== undefined ? { enabled } : {}),
      ...(autoSelect !== undefined ? { autoSelect } : {}),
      ...(trust !== null ? { trust: trust as WorkSkillTrust } : {}),
      ...(projectId !== null ? { projectId } : {}),
      limit,
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence and wire shapes
// ---------------------------------------------------------------------------

/**
 * The contract as a JSONB value, rebuilt field by field.
 *
 * Nothing is spread from the parsed object. A field added to the contract next
 * quarter has to be added here to be stored, which is the right direction: the
 * alternative is a column that quietly accumulates whatever a client sent under
 * a key this build does not understand, and then hands it back to a client that
 * does.
 */
export function skillContractToJson(contract: WorkSkillContract): Prisma.InputJsonObject {
  const field = (entry: WorkSkillField) => ({
    name: entry.name,
    kind: entry.kind,
    required: entry.required,
    description: entry.description,
  });
  return {
    inputs: contract.inputs.map(field),
    outputs: contract.outputs.map(field),
    requestedConnectors: [...contract.requestedConnectors],
    requestedApps: [...contract.requestedApps],
    requestedDomains: [...contract.requestedDomains],
    preferredTarget: contract.preferredTarget,
    preferredModel: contract.preferredModel,
    requestedPolicy: contract.requestedPolicy,
    requestedBudget: {
      maxCostMicroUsd: contract.requestedBudget.maxCostMicroUsd,
      maxTokens: contract.requestedBudget.maxTokens,
      maxRuntimeMs: contract.requestedBudget.maxRuntimeMs,
    },
    examples: contract.examples.map((example) => ({
      name: example.name,
      input: example.input,
      expectTools: [...example.expectTools],
      forbidTools: [...example.forbidTools],
      expectContains: [...example.expectContains],
    })),
  };
}

export interface ClientWorkSkill {
  id: string;
  projectId: string | null;
  slug: string;
  name: string;
  description: string;
  currentVersion: number;
  enabled: boolean;
  trust: WorkSkillTrust;
  /**
   * As stored. A reader deciding whether the planner may use this must still
   * ask `trustPermitsAutoSelection`, because the two columns are written
   * separately and only the pair is the answer.
   */
  autoSelect: boolean;
  createdAt: string;
  updatedAt: string;
}

export function serializeSkill(skill: WorkSkill): ClientWorkSkill {
  return {
    id: skill.id,
    projectId: skill.projectId,
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    currentVersion: skill.currentVersion,
    enabled: skill.enabled,
    trust: coerceSkillTrust(skill.trust),
    autoSelect: skill.autoSelect,
    createdAt: skill.createdAt.toISOString(),
    updatedAt: skill.updatedAt.toISOString(),
  };
}

export interface ClientWorkSkillVersion {
  id: string;
  skillId: string;
  version: number;
  instructions: string;
  contract: WorkSkillContract;
  contractVersion: number;
  /** What this version asks for. Never what it was given. */
  requestedTools: string[];
  createdAt: string;
}

export function serializeSkillVersion(version: WorkSkillVersion): ClientWorkSkillVersion {
  return {
    id: version.id,
    skillId: version.skillId,
    version: version.version,
    instructions: version.instructions,
    contract: parseSkillContract(version.contract),
    contractVersion: version.contractVersion,
    requestedTools: parseRequestedTools(version.requestedTools),
    createdAt: version.createdAt.toISOString(),
  };
}
