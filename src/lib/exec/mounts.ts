/**
 * Skill bundles armed for a session, so run_code mounts them.
 *
 * The skill lane's `use_skill` (L3) calls `mountSkill` when it loads a skill
 * that carries scripts; every later run_code call in the same session (chat
 * generation or Work run) uploads the registered bundles (the host skips a
 * digest it already holds) and mounts them read-only at /skills/<slug>. Both
 * tools run in the same process within one turn, so an in-process map is the
 * whole mechanism; entries expire with the session's workspace (30 minutes).
 *
 * Keyed by ACCOUNT as well as session, like the host workspace (ids.ts): a
 * chat session id is the generation id, which the client may choose. Keyed by
 * (surface, session) alone, another account sending the same generation id
 * got this turn's mounts, and its run uploaded this account's skill bundles
 * into its own sandbox, where its code could read them.
 */
import type { ExecSurface, SkillMount } from "@/lib/exec/types";

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TTL_MS = 30 * 60_000;
const MAX_PER_SESSION = 8;

const sessions = new Map<string, { at: number; mounts: Map<string, SkillMount> }>();

function key(surface: ExecSurface, userId: string, sessionId: string): string {
  return JSON.stringify([surface, userId, sessionId]);
}

function sweep(now: number): void {
  for (const [name, entry] of sessions) {
    if (now - entry.at > TTL_MS) sessions.delete(name);
  }
}

/** Arm a skill bundle for this session. Returns false when the slug is invalid or the session is full. */
export function mountSkill(surface: ExecSurface, userId: string, sessionId: string, mount: SkillMount): boolean {
  if (!SLUG.test(mount.slug) || !/^[0-9a-f]{64}$/.test(mount.bundleDigest)) return false;
  const now = Date.now();
  sweep(now);
  if (!userId) return false;
  const entry = sessions.get(key(surface, userId, sessionId)) ?? { at: now, mounts: new Map<string, SkillMount>() };
  if (!entry.mounts.has(mount.slug) && entry.mounts.size >= MAX_PER_SESSION) return false;
  entry.mounts.set(mount.slug, mount);
  entry.at = now;
  sessions.set(key(surface, userId, sessionId), entry);
  return true;
}

/** The bundles armed for this session, in the order they were armed. */
export function skillMountsFor(surface: ExecSurface, userId: string, sessionId: string): SkillMount[] {
  const entry = sessions.get(key(surface, userId, sessionId));
  if (!entry || Date.now() - entry.at > TTL_MS) return [];
  return [...entry.mounts.values()];
}

export function clearSkillMounts(surface: ExecSurface, userId: string, sessionId: string): void {
  sessions.delete(key(surface, userId, sessionId));
}
