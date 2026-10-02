/**
 * Skill bundles mounted into a sandbox session: the `SkillMount` provider for
 * the execution runtime's client (src/lib/exec, design §6.3 and §6.8).
 *
 * A turn (a chat generation, or a Work run) is one sandbox session. The skills
 * it loads, whether the person armed one with `/slug` or the model loaded one
 * through `use_skill`, are registered here under the session id, and the
 * execution runtime reads `skillMountsFor(surface, sessionId)` when it builds each
 * `run_code` call, so a skill loaded earlier in the turn is present at
 * `/skills/<slug>` for every run after it. The runtime uploads each bundle once
 * per session (the host keys it by digest) and records which mount a run's
 * code named (`ToolRun.skillVersionId`, `skillBundleDigest`).
 *
 * A mount is read-only and never widens anything: the sandbox profile (no
 * network, no credentials, nothing but /work and the mounts) is the turn's,
 * whatever the skill asked for. Only a version that passed every check
 * (scanned, consented, enabled) is ever registered, and only on a turn that
 * carries `run_code`.
 *
 * Process-local by design: a turn runs in one process from its first token to
 * its last, and the registry entry is cleared when the turn's tool session
 * closes. An entry is also dropped after `MOUNT_TTL_MS` without use, so a turn
 * that died without closing cannot leak bundles into memory forever.
 */

import "server-only";

import { loadSkillBundleTar } from "@/lib/skills/bundle-store";

/**
 * A skill bundle that may be mounted read-only at /skills/<slug>.
 *
 * Structurally identical to `SkillMount` in `src/lib/exec/types.ts` (the
 * execution lane's file), which is what the runtime consumes; repeated here so
 * this lane compiles before that one lands.
 */
export interface SkillMount {
  /** Mount name, /^[a-z0-9][a-z0-9-]{0,63}$/: the files appear under /skills/<slug>. */
  slug: string;
  skillVersionId: string;
  /** sha256 (hex) of the bundle tar, checked by the host. */
  bundleDigest: string;
  /** The bundle as a tar (≤ 5 MB): regular files only. */
  openBundle(): Promise<Uint8Array>;
}

const MOUNT_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** As long as the sandbox keeps the session's workspace. */
const MOUNT_TTL_MS = 30 * 60 * 1000;

/**
 * A mount for one stored bundle. The bytes are read (and verified against the
 * digest) only when the runtime uploads them, and at most once per mount.
 */
export function skillMountFor(input: {
  slug: string;
  skillVersionId: string;
  bundleKey: string;
  bundleDigest: string;
  load?: (columns: { bundleKey: string; bundleDigest: string }) => Promise<Uint8Array>;
}): SkillMount {
  if (!MOUNT_SLUG.test(input.slug)) throw new Error("invalid skill mount name");
  const load = input.load ?? loadSkillBundleTar;
  let pending: Promise<Uint8Array> | null = null;
  return {
    slug: input.slug,
    skillVersionId: input.skillVersionId,
    bundleDigest: input.bundleDigest,
    openBundle() {
      pending ??= load({ bundleKey: input.bundleKey, bundleDigest: input.bundleDigest }).catch((error) => {
        pending = null;
        throw error;
      });
      return pending;
    },
  };
}

/*
 * The per-session registry below has the exact signatures of the execution
 * lane's `src/lib/exec/mounts.ts` (`mountSkill`, `skillMountsFor`,
 * `clearSkillMounts`, keyed by surface, ACCOUNT and session, at most 8
 * mounts), which is the one `run_code` reads. It stands in until that file is
 * on the trunk; when it is, these three are deleted and this module re-exports
 * that one, so there is exactly one registry and `run_code` sees every mount.
 *
 * KEYED BY ACCOUNT. A chat session id is the generation id, which the client
 * may choose. Keyed by (surface, session) alone, another account sending the
 * same generation id would read this turn's mounts (and its run would upload
 * this account's bundles into its own sandbox), or clear them when its own
 * turn closed.
 */

type MountSurface = "chat" | "work" | "voice";

const MAX_MOUNTS_PER_SESSION = 8;

interface SessionMounts {
  mounts: Map<string, SkillMount>;
  touchedAt: number;
}

const sessions = new Map<string, SessionMounts>();

function key(surface: MountSurface, userId: string, sessionId: string): string {
  return JSON.stringify([surface, userId, sessionId]);
}

function sweep(now: number): void {
  for (const [name, entry] of sessions) {
    if (now - entry.touchedAt > MOUNT_TTL_MS) sessions.delete(name);
  }
}

/**
 * Arms a skill bundle for a session. False when the mount name, digest or
 * account is invalid or the session already holds the maximum. A slug already
 * mounted is replaced by the same skill's mount: slugs are unique per account.
 */
export function mountSkill(surface: MountSurface, userId: string, sessionId: string, mount: SkillMount): boolean {
  if (!MOUNT_SLUG.test(mount.slug) || !/^[0-9a-f]{64}$/.test(mount.bundleDigest)) return false;
  if (!userId) return false;
  const now = Date.now();
  sweep(now);
  const entry = sessions.get(key(surface, userId, sessionId)) ?? { mounts: new Map<string, SkillMount>(), touchedAt: now };
  if (!entry.mounts.has(mount.slug) && entry.mounts.size >= MAX_MOUNTS_PER_SESSION) return false;
  entry.mounts.set(mount.slug, mount);
  entry.touchedAt = now;
  sessions.set(key(surface, userId, sessionId), entry);
  return true;
}

/** Every mount registered for an account's session, in the order the skills were loaded. */
export function skillMountsFor(surface: MountSurface, userId: string, sessionId: string): SkillMount[] {
  const entry = sessions.get(key(surface, userId, sessionId));
  if (!entry || Date.now() - entry.touchedAt > MOUNT_TTL_MS) return [];
  return [...entry.mounts.values()];
}

/** Forgets an account's session mounts. Called when its tool session closes. */
export function clearSkillMounts(surface: MountSurface, userId: string, sessionId: string): void {
  sessions.delete(key(surface, userId, sessionId));
}
