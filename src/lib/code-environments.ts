/*
 * Cloud Code environments — what a run may reach, what it carries, and what it
 * is allowed to do without being asked.
 *
 * Until now a cloud run had exactly one shape: a container with no network, an
 * environment scrubbed down to twelve names, no setup step between the clone
 * and the first model turn, and the permission mode hardcoded to `full` in the
 * driver. A `CodeEnvironment` is the row that makes those four facts a choice
 * the submitter gets to make per session, and this module is the half of it
 * that can be reasoned about without a database: the vocabularies, the limits,
 * and the validation that decides whether a variable is a variable or a way to
 * change how the driver's own children execute.
 *
 * It is deliberately free of `server-only` imports so the rules below can be
 * exercised directly by tests — the pattern src/lib/work/domain.ts and
 * src/lib/background-provider-policy.ts already use. The cipher lives in
 * src/lib/crypto.ts, which cannot be imported here and is applied at the two
 * places that actually hold plaintext: the environments route (sealing) and
 * runner-context (unsealing, for the runner alone).
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Network access
// ---------------------------------------------------------------------------

/**
 * Egress for agent-authored commands.
 *
 * Two levels, not four, and the two missing ones are the point. Claude Code on
 * the web offers "trusted" and "custom" as well, and both mean *an allowlist an
 * egress proxy enforces*. The container this runner builds can join a proxy
 * network (`ContainerSandboxConfig.network = "proxied"`), but no deployment of
 * Juno runs that proxy — there is no such network on a GitHub Actions VM — so a
 * domain list stored here would be a field nothing reads and a control that
 * promises filtering nobody performs. `allowedDomains` is therefore NOT part of
 * this model. When the egress proxy exists, this union grows a third member and
 * the column arrives with the thing that honours it.
 *
 *   none — `--network=none`. The default, and what every run has had until now.
 *   full — the container joins Docker's default bridge and can reach anything
 *          the runner VM can. Chosen knowingly: it is also the level at which
 *          an agent that can run `curl` can post the worktree somewhere.
 */
export const CODE_NETWORK_ACCESS = ["none", "full"] as const;
export type CodeNetworkAccess = (typeof CODE_NETWORK_ACCESS)[number];
export const DEFAULT_CODE_NETWORK_ACCESS: CodeNetworkAccess = "none";

export function isCodeNetworkAccess(value: unknown): value is CodeNetworkAccess {
  return typeof value === "string" && (CODE_NETWORK_ACCESS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Permission mode
// ---------------------------------------------------------------------------

/**
 * How much the agent may do before it would have to ask.
 *
 * These three are a SUBSET of agent-core's `PermissionMode`
 * (runner/agent-core/src/types.ts): `ask` is missing on purpose. `ask` means
 * "stop and put the question to a person", and a cloud run has no person
 * attached — every request would be answered by the driver's own callback, so
 * offering it would name a behaviour the cloud cannot perform.
 *
 * The other three each mean something different in a headless run, and the
 * driver has to make them mean it (see scripts/cloud-code-runner.mjs):
 *
 *   plan      — the engine allows `safe` tools and denies everything else
 *               outright, so the run reads the repository and writes a plan.
 *   auto-edit — file edits run; a shell command is refused, with a line saying
 *               so, rather than auto-allowed. This is the mode whose honesty
 *               costs something: the driver used to answer EVERY approval
 *               request with `allow`, which would have made "Accept edits"
 *               indistinguishable from "Auto".
 *   full      — today's behaviour exactly: the engine's `sensitive` gate still
 *               fires, and the driver auto-allows it inside the sandbox and
 *               records one honest tool row saying that is what happened.
 */
export const CODE_PERMISSION_MODES = ["plan", "auto-edit", "full"] as const;
export type CodePermissionMode = (typeof CODE_PERMISSION_MODES)[number];

/**
 * What a cloud run gets when the submitter expressed no preference — which is
 * every task created before the column existed, and every native client that
 * does not know about it. It has to be `full`, because that is the literal
 * string the driver passed to `AgentSession.create` before any of this, and a
 * migration that quietly narrows what running tasks may do is a behaviour
 * change disguised as a default.
 */
export const DEFAULT_CLOUD_PERMISSION_MODE: CodePermissionMode = "full";

export function isCodePermissionMode(value: unknown): value is CodePermissionMode {
  return typeof value === "string" && (CODE_PERMISSION_MODES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

/** At most this many variables per environment. */
export const MAX_ENV_VARS = 64;
/** Longest accepted variable name. */
export const MAX_ENV_VAR_NAME_LENGTH = 128;
/** Longest accepted variable value. */
export const MAX_ENV_VAR_VALUE_LENGTH = 8_192;
/** Cap on the whole map once serialised, so one row cannot carry a payload. */
export const MAX_ENV_VARS_TOTAL_BYTES = 64 * 1024;
/**
 * Longest accepted setup script.
 *
 * There is deliberately no `cacheKey` beside it, and the reason is worth
 * writing down so it is not added as an obvious optimisation later. Caching a
 * setup script's output means `actions/cache` on the RUNNER repository, whose
 * cache is one namespace shared by every user's runs. A key chosen per
 * environment does not change that: one account's setup script would write a
 * `node_modules` that another account's run restores and then executes. The
 * cost of not caching is a slower `npm ci`; the cost of caching it here is
 * cross-tenant code execution, and no cache key is a fix for that.
 */
export const MAX_SETUP_SCRIPT_LENGTH = 16 * 1024;
/** How long the setup script may run before the driver kills it. */
export const SETUP_SCRIPT_TIMEOUT_MS = 10 * 60_000;
/** How much of the setup script's output is kept on the event that reports it. */
export const SETUP_SCRIPT_OUTPUT_LIMIT = 8_000;
/** At most this many environments per user, so the list stays a list. */
export const MAX_CODE_ENVIRONMENTS = 25;

/** POSIX environment variable name. Anything else is not a name a shell reads. */
const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Names an environment may not set, and why each group is here.
 *
 * These are not "sensitive" names — they are names whose VALUES change how a
 * process starts rather than what it computes. `LD_PRELOAD` loads a library
 * into every child; `BASH_ENV` runs a file before every non-interactive bash;
 * `PATH` decides which binary `npm` is; `IFS` changes how the shell splits the
 * words of a command someone else wrote. The driver hands this map to its own
 * children — the setup script runs on the runner host — so accepting any of
 * them would mean a stored environment could rewrite the execution of the
 * process that holds the task token.
 *
 * The prefixes are a different argument: `JUNO_`, `ACTIONS_` and `GITHUB_` are
 * exactly the names `hardenDriverEnv()` strips and `AGENT_ENV_ALLOW` decides
 * about. A user-settable variable in one of those namespaces would be reasoned
 * about by that code as if the runner had set it.
 */
const RESERVED_ENV_VAR_NAMES = new Set([
  "BASH_ENV",
  "CDPATH",
  "ENV",
  "GLOBIGNORE",
  "HOME",
  "IFS",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LOGNAME",
  "NODE_OPTIONS",
  "PATH",
  "PS4",
  "PYTHONSTARTUP",
  "SHELL",
  "SHELLOPTS",
  "USER",
]);

const RESERVED_ENV_VAR_PREFIXES = ["JUNO_", "ACTIONS_", "GITHUB_"];

export type EnvVarRejection =
  | { reason: "invalid_name"; name: string }
  | { reason: "reserved_name"; name: string }
  | { reason: "duplicate_name"; name: string }
  | { reason: "value_too_long"; name: string }
  | { reason: "too_many" }
  | { reason: "too_large" };

export type EnvVarParse =
  | { ok: true; vars: Record<string, string>; names: string[] }
  | { ok: false; rejection: EnvVarRejection };

/** True when this name may be set by a user-authored environment. */
export function isAllowedEnvVarName(name: string): boolean {
  if (!ENV_VAR_NAME_RE.test(name)) return false;
  if (name.length > MAX_ENV_VAR_NAME_LENGTH) return false;
  if (RESERVED_ENV_VAR_NAMES.has(name)) return false;
  return !RESERVED_ENV_VAR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Validate a submitted variable map and return it in a stable key order.
 *
 * Sorted because the map is sealed as one ciphertext: without an order, an
 * unchanged edit re-seals to different bytes every time and the row's
 * `updatedAt` stops meaning "someone changed this".
 */
export function parseEnvVars(input: Record<string, unknown>): EnvVarParse {
  const entries = Object.entries(input);
  if (entries.length > MAX_ENV_VARS) return { ok: false, rejection: { reason: "too_many" } };

  const vars: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [rawName, rawValue] of entries) {
    const name = rawName.trim();
    if (!ENV_VAR_NAME_RE.test(name) || name.length > MAX_ENV_VAR_NAME_LENGTH) {
      return { ok: false, rejection: { reason: "invalid_name", name: rawName } };
    }
    if (!isAllowedEnvVarName(name)) {
      return { ok: false, rejection: { reason: "reserved_name", name } };
    }
    // Case matters to a shell, so `Path` and `PATH` are different names — but
    // two entries differing only in surrounding whitespace collapse to one here
    // and the loser would vanish without a word.
    if (seen.has(name)) return { ok: false, rejection: { reason: "duplicate_name", name } };
    seen.add(name);
    const value = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
    if (value.length > MAX_ENV_VAR_VALUE_LENGTH) {
      return { ok: false, rejection: { reason: "value_too_long", name } };
    }
    vars[name] = value;
  }

  const names = Object.keys(vars).sort();
  const ordered: Record<string, string> = {};
  for (const name of names) ordered[name] = vars[name];
  if (Buffer.byteLength(JSON.stringify(ordered), "utf8") > MAX_ENV_VARS_TOTAL_BYTES) {
    return { ok: false, rejection: { reason: "too_large" } };
  }
  return { ok: true, vars: ordered, names };
}

/** The sentence a rejection becomes for the person who submitted it. */
export function describeEnvVarRejection(rejection: EnvVarRejection): string {
  switch (rejection.reason) {
    case "invalid_name":
      return `"${rejection.name}" is not a valid environment variable name. Use letters, digits and underscores, starting with a letter or an underscore.`;
    case "reserved_name":
      return `${rejection.name} decides how the runner starts its own processes, so an environment cannot set it.`;
    case "duplicate_name":
      return `${rejection.name} is listed twice.`;
    case "value_too_long":
      return `The value of ${rejection.name} is longer than ${MAX_ENV_VAR_VALUE_LENGTH} characters.`;
    case "too_many":
      return `An environment holds at most ${MAX_ENV_VARS} variables.`;
    case "too_large":
      return `Those variables are larger than ${Math.floor(MAX_ENV_VARS_TOTAL_BYTES / 1024)} KB in total.`;
  }
}

/**
 * Read a decrypted variable map back out of storage.
 *
 * Applied on the read side as well as the write side because the rules above
 * can tighten: a name that was acceptable when it was sealed must not reach a
 * shell just because it is already in the database. A rejected entry is dropped
 * rather than failing the run — the run can proceed without one variable, and
 * failing here would strand a task whose environment was written by an older
 * deploy.
 */
export function readStoredEnvVars(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isAllowedEnvVarName(name)) continue;
    if (typeof value !== "string") continue;
    if (value.length > MAX_ENV_VAR_VALUE_LENGTH) continue;
    out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Request shapes
// ---------------------------------------------------------------------------

const nameSchema = z.string().trim().min(1).max(60);
const setupScriptSchema = z.string().max(MAX_SETUP_SCRIPT_LENGTH);
const envVarsSchema = z.record(z.string(), z.string());

export const createEnvironmentSchema = z.object({
  name: nameSchema,
  network: z.enum(CODE_NETWORK_ACCESS).optional(),
  setupScript: setupScriptSchema.optional(),
  envVars: envVarsSchema.optional(),
  isDefault: z.boolean().optional(),
});

/**
 * A patch replaces the whole variable map when it names one.
 *
 * Per-key patching is the obvious alternative and it is wrong for a column that
 * is one ciphertext: merging requires unsealing the stored map, and a client
 * that cannot read the values back (the list deliberately returns names only)
 * cannot construct a correct partial edit. Sending the whole map is the only
 * form where what the caller sees and what it writes are the same thing.
 */
export const patchEnvironmentSchema = z
  .object({
    name: nameSchema.optional(),
    network: z.enum(CODE_NETWORK_ACCESS).optional(),
    setupScript: setupScriptSchema.nullable().optional(),
    envVars: envVarsSchema.optional(),
    isDefault: z.literal(true).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: "empty_patch" });

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/** The columns any serialiser here needs; a structural type so this module
 *  stays importable without the Prisma client. */
export interface CodeEnvironmentRow {
  id: string;
  name: string;
  network: string;
  envVarNames: string[];
  setupScript: string | null;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * What an environment looks like over the API.
 *
 * `envVarNames` and never `envVars`: the values are secrets the user pasted
 * once, sealed with the connector cipher, and there is no read path back to a
 * browser for them — not on the list, not on the detail, not for their owner.
 * A client that needs to show the user what a run will carry shows the names.
 * The only consumer of the values is runner-context, which refuses a browser
 * session outright.
 *
 * The setup script is not a secret in the same sense — it is a shell script the
 * user wrote and has to be able to edit — so it rides the single-environment
 * read. It is left off the list, where a screen that draws a chip per
 * environment would otherwise pull down 25 scripts to render 25 names.
 */
export function serializeCodeEnvironment(
  row: CodeEnvironmentRow,
  opts: { includeSetupScript?: boolean } = {},
) {
  return {
    id: row.id,
    name: row.name,
    network: isCodeNetworkAccess(row.network) ? row.network : DEFAULT_CODE_NETWORK_ACCESS,
    envVarNames: row.envVarNames,
    hasSetupScript: !!row.setupScript && row.setupScript.trim().length > 0,
    ...(opts.includeSetupScript ? { setupScript: row.setupScript ?? "" } : {}),
    isDefault: row.isDefault,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
