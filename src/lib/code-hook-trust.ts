import { createHash } from "node:crypto";

/**
 * PROJECT HOOK TRUST FOR CLOUD RUNS.
 *
 * A repository can carry `.alevr/hooks.json` (runner/agent-core/src/hooks.ts).
 * Agent-core runs those commands only when a person has reviewed the exact
 * bytes. On a Mac a person is attached and answers the prompt; a cloud run has
 * nobody, so the owner reviews the file here ahead of time and runner-context
 * hands the reviewed hashes to the runner as `hooks.trustedHashes`.
 *
 * The hash is SHA-256 over the file's raw bytes, exactly as agent-core's
 * `readProjectHooks` computes it, so an edit of any byte (a command, a space,
 * a line ending) is a different hash and asks again.
 *
 * Approval is never taken from a hash the browser sends on its own: the route
 * reads the file from GitHub again and approves only if what it read now hashes
 * to what the person was shown.
 */

export const HOOKS_PATH = ".alevr/hooks.json";
/** agent-core refuses a larger file. */
export const HOOKS_MAX_BYTES = 32_768;
/** Reviewed versions kept per repository; approving another drops the oldest. */
export const MAX_HOOK_TRUSTS_PER_REPO = 10;

export type HookEvent = "PreToolUse" | "PostToolUse" | "Stop";
export const HOOK_EVENTS: readonly HookEvent[] = ["PreToolUse", "PostToolUse", "Stop"];

export interface ProjectHook {
  command: string;
  matcher?: string[];
  timeoutMs?: number;
}

export interface ProjectHookConfig {
  version: 1;
  hooks: Partial<Record<HookEvent, ProjectHook[]>>;
}

export type HooksParse =
  | { ok: true; config: ProjectHookConfig }
  | { ok: false; message: string };

const HASH_RE = /^[0-9a-f]{64}$/;
const MATCHER_RE = /^[a-zA-Z0-9_*:-]{1,128}$/;

/**
 * The same strict rules as agent-core's `parseProjectHooks` (a parity test
 * compares the two), with a sentence instead of a bare throw so the page can
 * say what to fix. A file agent-core would refuse is never offered for review.
 */
export function parseHooksConfig(raw: string): HooksParse {
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return { ok: false, message: "The file is not valid JSON." };
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, message: "The file must be a JSON object with version and hooks." };
  }
  const root = input as Record<string, unknown>;
  if (root.version !== 1) return { ok: false, message: "version must be 1." };
  if (Object.keys(root).some((k) => k !== "version" && k !== "hooks")) {
    return { ok: false, message: "Only version and hooks are allowed at the top level." };
  }
  const hooks = root.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return { ok: false, message: "hooks must be an object of events." };
  }
  for (const [event, entries] of Object.entries(hooks as Record<string, unknown>)) {
    if (!HOOK_EVENTS.includes(event as HookEvent)) {
      return { ok: false, message: `${event} is not a hook event. Use PreToolUse, PostToolUse or Stop.` };
    }
    if (!Array.isArray(entries) || entries.length > 12) {
      return { ok: false, message: `${event} must be a list of at most 12 hooks.` };
    }
    for (const hook of entries as unknown[]) {
      if (!hook || typeof hook !== "object" || Array.isArray(hook)) {
        return { ok: false, message: `Each ${event} hook must be an object.` };
      }
      const h = hook as Record<string, unknown>;
      if (Object.keys(h).some((k) => !["command", "matcher", "timeoutMs"].includes(k))) {
        return { ok: false, message: `A ${event} hook may only have command, matcher and timeoutMs.` };
      }
      if (typeof h.command !== "string" || !h.command.trim() || h.command.length > 4096) {
        return { ok: false, message: `Each ${event} hook needs a command of at most 4096 characters.` };
      }
      if (
        h.matcher !== undefined &&
        (!Array.isArray(h.matcher) ||
          h.matcher.length > 32 ||
          h.matcher.some((s: unknown) => typeof s !== "string" || !MATCHER_RE.test(s)))
      ) {
        return { ok: false, message: `A ${event} matcher must be a list of tool names or *.` };
      }
      if (
        h.timeoutMs !== undefined &&
        (!Number.isInteger(h.timeoutMs) || (h.timeoutMs as number) < 100 || (h.timeoutMs as number) > 60_000)
      ) {
        return { ok: false, message: `A ${event} timeoutMs must be a whole number from 100 to 60000.` };
      }
    }
  }
  return { ok: true, config: input as ProjectHookConfig };
}

/** SHA-256 of the raw file bytes, lower-case hex: agent-core's hash. */
export function hashHooksBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isHookHash(value: unknown): value is string {
  return typeof value === "string" && HASH_RE.test(value);
}

/** One row per command, in run order, for the review list. */
export interface HookSummaryRow {
  event: HookEvent;
  command: string;
  matcher: string[] | null;
  timeoutMs: number;
}

export function summarizeHooks(config: ProjectHookConfig): HookSummaryRow[] {
  const rows: HookSummaryRow[] = [];
  for (const event of HOOK_EVENTS) {
    for (const hook of config.hooks[event] ?? []) {
      rows.push({
        event,
        command: hook.command,
        matcher: hook.matcher?.length ? [...hook.matcher] : null,
        timeoutMs: hook.timeoutMs ?? 10_000,
      });
    }
  }
  return rows;
}

/** Repository identity as stored: GitHub names are case-insensitive. */
export function hookTrustRepoKey(owner: string, name: string): { repoOwner: string; repoName: string } {
  return { repoOwner: owner.toLowerCase(), repoName: name.toLowerCase() };
}

/** What a cloud run of this repository may run without a person, newest first. */
export async function trustedHookHashesFor(
  db: { codeHookTrust: { findMany(args: unknown): Promise<Array<{ configHash: string }>> } },
  userId: string,
  owner: string,
  name: string,
): Promise<string[]> {
  const rows = await db.codeHookTrust.findMany({
    where: { userId, ...hookTrustRepoKey(owner, name) },
    orderBy: { createdAt: "desc" },
    take: MAX_HOOK_TRUSTS_PER_REPO,
    select: { configHash: true },
  });
  return rows.map((r) => r.configHash).filter(isHookHash);
}
