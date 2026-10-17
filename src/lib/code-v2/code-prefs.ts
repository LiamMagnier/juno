/**
 * The account's Code defaults: what a new session starts with, readable and
 * editable from Settings without a session open (Codex's Settings and Claude
 * Code's /config do the same). Stored on the account (`Settings.codePrefs`,
 * read and written through /api/code/prefs) so they follow the person to every
 * browser.
 *
 * Precedence, everywhere: a thread's own choice, then its project's last
 * choice (kept per browser), then these, then the built-in defaults. Nothing
 * here changes a session that already exists.
 *
 * Pure: the route validates with it, the client merges with it, the tests
 * import it.
 */
import { INTERACTION_MODE_VALUES, ROLE_PRESET_VALUES, RUNTIME_MODE_VALUES, type InteractionMode, type RolePreset, type RoleRouting, type RuntimeMode } from "./contracts";
import { DETAIL_LEVELS, type DetailLevel } from "./turns";

export interface CodeTeamDefault {
  preset: RolePreset;
  /** The run budget a new team run starts with (Alevr spend only). */
  maxUsd?: number;
}

export interface CodePrefs {
  runtimeMode?: RuntimeMode;
  interactionMode?: InteractionMode;
  detailLevel?: DetailLevel;
  team?: CodeTeamDefault;
}

/** A change: a key set to null goes back to the built-in default. */
export type CodePrefsPatch = { [K in keyof CodePrefs]?: CodePrefs[K] | null };

export const MAX_TEAM_BUDGET_USD = 10_000;

const isOneOf = <T extends string>(values: readonly T[], v: unknown): v is T => typeof v === "string" && (values as readonly string[]).includes(v);

function sanitizeTeam(raw: unknown): CodeTeamDefault | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { preset, maxUsd } = raw as { preset?: unknown; maxUsd?: unknown };
  if (!isOneOf(ROLE_PRESET_VALUES, preset)) return undefined;
  const budget = typeof maxUsd === "number" && Number.isFinite(maxUsd) && maxUsd >= 0 && maxUsd <= MAX_TEAM_BUDGET_USD ? Math.round(maxUsd * 100) / 100 : undefined;
  return budget === undefined ? { preset } : { preset, maxUsd: budget };
}

/** Whatever was stored or sent, as valid prefs: unknown keys and bad values are dropped, never kept. */
export function sanitizeCodePrefs(raw: unknown): CodePrefs {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: CodePrefs = {};
  if (isOneOf(RUNTIME_MODE_VALUES, r.runtimeMode)) out.runtimeMode = r.runtimeMode;
  if (isOneOf(INTERACTION_MODE_VALUES, r.interactionMode)) out.interactionMode = r.interactionMode;
  if (isOneOf(DETAIL_LEVELS, r.detailLevel)) out.detailLevel = r.detailLevel;
  const team = sanitizeTeam(r.team);
  if (team) out.team = team;
  return out;
}

/** Validates a patch: null clears a key; a present but invalid value is an error (the client sent something wrong). */
export function parseCodePrefsPatch(raw: unknown): { ok: true; patch: CodePrefsPatch } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Send an object of Code defaults." };
  const r = raw as Record<string, unknown>;
  const patch: CodePrefsPatch = {};
  for (const key of Object.keys(r)) {
    const value = r[key];
    if (key === "runtimeMode") {
      if (value !== null && !isOneOf(RUNTIME_MODE_VALUES, value)) return { ok: false, error: "Unknown access mode." };
      patch.runtimeMode = value as RuntimeMode | null;
    } else if (key === "interactionMode") {
      if (value !== null && !isOneOf(INTERACTION_MODE_VALUES, value)) return { ok: false, error: "Unknown interaction mode." };
      patch.interactionMode = value as InteractionMode | null;
    } else if (key === "detailLevel") {
      if (value !== null && !isOneOf(DETAIL_LEVELS, value)) return { ok: false, error: "Unknown work-log level." };
      patch.detailLevel = value as DetailLevel | null;
    } else if (key === "team") {
      if (value === null) patch.team = null;
      else {
        const team = sanitizeTeam(value);
        if (!team) return { ok: false, error: "Unknown team preset." };
        const sent = (value as { maxUsd?: unknown }).maxUsd;
        if (sent !== undefined && team.maxUsd === undefined) return { ok: false, error: `A budget is between $0 and $${MAX_TEAM_BUDGET_USD}.` };
        patch.team = team;
      }
    } else {
      return { ok: false, error: `Unknown Code default "${key}".` };
    }
  }
  return { ok: true, patch };
}

export function mergeCodePrefs(current: CodePrefs, patch: CodePrefsPatch): CodePrefs {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
  }
  return sanitizeCodePrefs(next);
}

/**
 * The team a fresh thread starts with from the account default, or null when
 * there is none (or it is Solo, which is what a thread has anyway). `build`
 * turns a preset into a full routing around the thread's lead
 * (orchestrate.ts `withPreset`), kept outside so this stays pure data.
 */
export function teamFromDefault(
  team: CodeTeamDefault | undefined,
  lead: RoleRouting["orchestrator"],
  build: (routing: RoleRouting, preset: RolePreset) => RoleRouting,
): RoleRouting | null {
  if (!team || team.preset === "solo") return null;
  const routing = build({ preset: "solo", orchestrator: lead }, team.preset);
  return team.maxUsd === undefined ? routing : { ...routing, budget: { ...routing.budget, maxUsd: team.maxUsd } };
}
