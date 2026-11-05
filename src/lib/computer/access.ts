/**
 * Who may have an agent computer (docs/design/agents-v2/COMPUTERS_2026-10.md §S1.1).
 *
 * Three gates on top of the provider switch, checked in this order, the first
 * failure winning:
 *
 *   1. A provider is configured (`server_off` otherwise). Production ships
 *      with none, so nothing here exposes anyone today.
 *   2. The rollout (`AGENT_COMPUTER_ROLLOUT`): `allowlist` (the default) admits
 *      only the accounts in `AGENT_COMPUTER_ALLOWLIST`, so setting a provider
 *      alone exposes nobody; `plans` admits every plan that includes one; `off`
 *      admits nobody. Any other value reads as `off`, and says so once.
 *   3. The plan: `PLAN_AGENT_COMPUTER[plan]` non-null and both caps above 0,
 *      after the env overrides. The upgrade it offers is worked out from the
 *      same effective caps, and is left out when no plan above the account's
 *      includes a computer.
 *      Checked after the allowlist on purpose: under `allowlist`, upgrading
 *      would not give an unlisted account a computer, so telling it to upgrade
 *      would be untrue.
 *   4. The provider answers `available()` (`unavailable`), cached 30 s per
 *      process and checked last, so an account that is not entitled never
 *      waits on the host.
 *
 * The account's plan, email and email verification come from the database,
 * never from the session. An allowlist entry with `@` matches only a verified
 * email (credentials sign-up leaves `emailVerified` null, so anyone could
 * otherwise register the address the owner meant to list); an id entry
 * matches exactly.
 *
 * No `server-only` import: the store's tests reach it through a reader seam.
 */

import type { Plan } from "@prisma/client";
import { PLAN_AGENT_COMPUTER, PLAN_LIST, planRank, type AgentComputerEntitlement } from "@/lib/plans";
import { computerProvider } from "./provider";
import { COMPUTER_ACCESS_COPY, apiPlanSentence, panelPlanSentence } from "./access-copy";
import { ComputerAccessError } from "./errors";

export type ComputerRollout = "allowlist" | "plans" | "off";
export type ComputerAccessReason = "server_off" | "rollout_off" | "not_in_rollout" | "plan" | "unavailable";
export type ComputerAccess =
  | { ok: true; plan: Plan; caps: AgentComputerEntitlement }
  | { ok: false; reason: ComputerAccessReason; message: string; upgradePlan: Plan | null };

/** What a client may see of the access verdict (the agent panel). */
export interface PublicComputerAccess {
  ok: boolean;
  reason: ComputerAccessReason | null;
  message: string | null;
  upgradePlan: Plan | null;
}

export function publicComputerAccess(access: ComputerAccess): PublicComputerAccess {
  return access.ok
    ? { ok: true, reason: null, message: null, upgradePlan: null }
    : { ok: false, reason: access.reason, message: access.message, upgradePlan: access.upgradePlan };
}

/** Per process, on purpose: each process logs a misconfiguration once; a restart logs it again. */
const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[agent-computer] ${message}`);
}

/** Test seam: forget which warnings were already logged. */
export function resetComputerAccessWarningsForTest(): void {
  warned.clear();
}

export function computerRollout(env: NodeJS.ProcessEnv = process.env): ComputerRollout {
  const raw = (env.AGENT_COMPUTER_ROLLOUT ?? "").trim().toLowerCase();
  if (raw === "" || raw === "allowlist") return "allowlist";
  if (raw === "plans" || raw === "off") return raw;
  warnOnce(`rollout:${raw}`, `AGENT_COMPUTER_ROLLOUT=${JSON.stringify(raw.slice(0, 40))} is not allowlist, plans or off; computers are off.`);
  return "off";
}

export interface AccessUser {
  id: string;
  email: string | null;
  emailVerified: Date | null;
  plan: Plan;
}

/** Whether the account is on AGENT_COMPUTER_ALLOWLIST: an id exactly, or a verified email case-insensitively. */
export function isAllowlisted(
  user: { id: string; email: string | null; emailVerified: Date | null },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const entries = (env.AGENT_COMPUTER_ALLOWLIST ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of entries) {
    if (entry.includes("@")) {
      if (user.emailVerified && user.email && user.email.trim().toLowerCase() === entry.toLowerCase()) return true;
    } else if (entry === user.id) {
      return true;
    }
  }
  return false;
}

/** A non-negative whole number, or null when the variable is unset or not one. */
function wholeNumber(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The caps for a plan: the defaults in `PLAN_AGENT_COMPUTER`, overridden by
 * `AGENT_COMPUTER_MAX_ENABLED_<PLAN>` and `AGENT_COMPUTER_WEEKLY_MINUTES_<PLAN>`.
 * Null for a plan without computers; an override set for FREE or LITE is
 * ignored with a warning (an env file cannot give a plan an entitlement it
 * does not have). 0 means none.
 */
export function computerCapsFor(plan: Plan, env: NodeJS.ProcessEnv = process.env): AgentComputerEntitlement | null {
  const defaults = PLAN_AGENT_COMPUTER[plan];
  const enabledKey = `AGENT_COMPUTER_MAX_ENABLED_${plan}`;
  const minutesKey = `AGENT_COMPUTER_WEEKLY_MINUTES_${plan}`;
  if (!defaults) {
    if (env[enabledKey] !== undefined || env[minutesKey] !== undefined) {
      warnOnce(`caps:${plan}`, `${enabledKey} and ${minutesKey} are ignored: the ${plan} plan does not include agent computers.`);
    }
    return null;
  }
  const maxEnabled = wholeNumber(env[enabledKey]);
  const weeklyMinutes = wholeNumber(env[minutesKey]);
  if (env[enabledKey] !== undefined && maxEnabled === null) warnOnce(`bad:${enabledKey}`, `${enabledKey} is not a whole number; using ${defaults.maxEnabled}.`);
  if (env[minutesKey] !== undefined && weeklyMinutes === null) warnOnce(`bad:${minutesKey}`, `${minutesKey} is not a whole number; using ${defaults.weeklyMinutes}.`);
  return {
    maxEnabled: maxEnabled ?? defaults.maxEnabled,
    weeklyMinutes: weeklyMinutes ?? defaults.weeklyMinutes,
  };
}

/** Caps that give an account at least one computer for at least one minute. */
function includesComputer(caps: AgentComputerEntitlement | null): caps is AgentComputerEntitlement {
  return caps !== null && caps.maxEnabled > 0 && caps.weeklyMinutes > 0;
}

/** Whether every plan from `plan` up includes a computer under the effective caps, so "and above" is true. */
export function everyPlanFromIncludesComputer(plan: Plan, env: NodeJS.ProcessEnv = process.env): boolean {
  return PLAN_LIST.filter((p) => planRank(p.id) >= planRank(plan)).every((p) => includesComputer(computerCapsFor(p.id, env)));
}

/**
 * Where an account refused for its plan can upgrade to: the cheapest plan
 * above its own whose caps, after the env overrides, include a computer. Null
 * when there is none, so an owner who set Pro's caps to 0 never tells a Pro
 * account to upgrade to Pro. `andAbove` says whether every dearer plan has one
 * too.
 */
export function computerUpgradeFor(
  plan: Plan,
  env: NodeJS.ProcessEnv = process.env,
): { plan: Plan; andAbove: boolean } | null {
  const target = PLAN_LIST.find((p) => planRank(p.id) > planRank(plan) && includesComputer(computerCapsFor(p.id, env)));
  return target ? { plan: target.id, andAbove: everyPlanFromIncludesComputer(target.id, env) } : null;
}

/**
 * The decision for an account, given what is already known, without the
 * availability check. Pure: tests drive every branch through it.
 */
export function decideComputerEntitlement(input: {
  providerConfigured: boolean;
  user: AccessUser | null;
  env?: NodeJS.ProcessEnv;
}): ComputerAccess {
  const env = input.env ?? process.env;
  if (!input.providerConfigured) {
    return { ok: false, reason: "server_off", message: COMPUTER_ACCESS_COPY.serverOff, upgradePlan: null };
  }
  const rollout = computerRollout(env);
  if (rollout === "off") {
    return { ok: false, reason: "rollout_off", message: COMPUTER_ACCESS_COPY.rolloutOff, upgradePlan: null };
  }
  if (rollout === "allowlist" && !(input.user && isAllowlisted(input.user, env))) {
    return { ok: false, reason: "not_in_rollout", message: COMPUTER_ACCESS_COPY.notInRollout, upgradePlan: null };
  }
  const plan: Plan = input.user?.plan ?? "FREE";
  const caps = computerCapsFor(plan, env);
  if (!includesComputer(caps)) {
    const upgrade = computerUpgradeFor(plan, env);
    return upgrade
      ? { ok: false, reason: "plan", message: panelPlanSentence(upgrade.plan, upgrade.andAbove), upgradePlan: upgrade.plan }
      : { ok: false, reason: "plan", message: COMPUTER_ACCESS_COPY.notInPlan, upgradePlan: null };
  }
  return { ok: true, plan, caps };
}

export type AccessUserReader = (userId: string) => Promise<AccessUser | null>;

async function databaseAccessUser(userId: string): Promise<AccessUser | null> {
  const [{ prisma }, { getUserPlan }] = await Promise.all([import("@/lib/db"), import("@/lib/usage")]);
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, emailVerified: true },
  });
  if (!user) return null;
  // The one plan rule (owner emails, a paying subscription), never the session's copy.
  return { id: user.id, email: user.email, emailVerified: user.emailVerified, plan: await getUserPlan(userId) };
}

let accessUserReader: AccessUserReader = databaseAccessUser;

/** Test seam (the store's in-memory persistence installs one). Null restores the database. */
export function setComputerAccessUserReaderForTest(reader: AccessUserReader | null): void {
  accessUserReader = reader ?? databaseAccessUser;
}

const AVAILABILITY_TTL_MS = 30_000;
let availability: { provider: string; ok: boolean; expiresAt: number } | null = null;

/** Test seam: forget the cached `available()` answer. */
export function resetComputerAvailabilityCacheForTest(): void {
  availability = null;
}

async function providerAvailable(): Promise<boolean> {
  const provider = computerProvider();
  if (!provider) return false;
  const now = Date.now();
  // The fake provider is tests and local demos only: never cached, so a test
  // that flips its answer sees the flip.
  if (provider.name !== "fake" && availability && availability.provider === provider.name && availability.expiresAt > now) {
    return availability.ok;
  }
  let ok = false;
  try {
    ok = (await provider.available()).ok;
  } catch {
    ok = false;
  }
  availability = { provider: provider.name, ok, expiresAt: now + AVAILABILITY_TTL_MS };
  return ok;
}

/**
 * The account's verdict. `checkAvailable: false` leaves out the host check:
 * the sweep and lease renewal use that form, because a host that does not
 * answer for a minute is not a reason to put an entitled account's computer
 * to sleep (S3 meters the outage instead).
 */
export async function computerAccessFor(
  userId: string,
  opts: { checkAvailable?: boolean } = {},
): Promise<ComputerAccess> {
  const providerConfigured = computerProvider() !== null;
  let user: AccessUser | null = null;
  if (providerConfigured) {
    try {
      user = await accessUserReader(userId);
    } catch (error) {
      // A database error is not a verdict about the account: refused for now
      // (fail closed) with a sentence that says so, as `unavailable`, which
      // every caller treats as transient. Never "not in your plan" to a
      // paying account, and never a reason to put its computer to sleep.
      console.error("[agent-computer] the account could not be read for access", { error: String(error) });
      return { ok: false, reason: "unavailable", message: COMPUTER_ACCESS_COPY.accountUnchecked, upgradePlan: null };
    }
  }
  const entitlement = decideComputerEntitlement({ providerConfigured, user });
  if (!entitlement.ok || opts.checkAvailable === false) return entitlement;
  if (!(await providerAvailable())) {
    return { ok: false, reason: "unavailable", message: COMPUTER_ACCESS_COPY.unavailable, upgradePlan: null };
  }
  return entitlement;
}

/** The entitlement alone (no host check). */
export function computerEntitlementFor(userId: string): Promise<ComputerAccess> {
  return computerAccessFor(userId, { checkAvailable: false });
}

/** A refusal as the error the store throws. The plan sentence names the agent when the caller knows it. */
export function computerAccessError(
  access: Extract<ComputerAccess, { ok: false }>,
  agentName?: string | null,
): ComputerAccessError {
  if (access.reason === "plan" && access.upgradePlan) {
    const andAbove = everyPlanFromIncludesComputer(access.upgradePlan);
    return new ComputerAccessError("plan", apiPlanSentence(access.upgradePlan, agentName?.trim() || "this agent", andAbove), {
      upgradePlan: access.upgradePlan,
    });
  }
  return new ComputerAccessError(access.reason, access.message);
}

/** Throws the refusal when the account may not have a computer right now. */
export async function requireComputerAccess(
  userId: string,
  opts: { checkAvailable?: boolean; agentName?: string | null } = {},
): Promise<Extract<ComputerAccess, { ok: true }>> {
  const access = await computerAccessFor(userId, { checkAvailable: opts.checkAvailable });
  if (!access.ok) throw computerAccessError(access, opts.agentName);
  return access;
}
