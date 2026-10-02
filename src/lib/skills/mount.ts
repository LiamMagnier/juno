/**
 * Skill bundles mounted into a sandbox session: the `SkillMount` provider for
 * the execution runtime's client (src/lib/exec, design §6.3 and §6.8).
 *
 * A turn (a chat generation, or a Work run) is one sandbox session. The skills
 * it loads, whether the person armed one with `/slug` or the model loaded one
 * through `use_skill`, are registered here under the session id, and the
 * execution runtime reads `skillMountsFor(sessionId)` when it builds each
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
const MOUNT_TTL_MS = 2 * 60 * 60 * 1000;

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

interface SessionMounts {
  mounts: Map<string, SkillMount>;
  touchedAt: number;
}

const sessions = new Map<string, SessionMounts>();

function sweep(now: number): void {
  for (const [sessionId, entry] of sessions) {
    if (now - entry.touchedAt > MOUNT_TTL_MS) sessions.delete(sessionId);
  }
}

/**
 * Registers a mount for a session. A second skill under the same slug in one
 * session replaces nothing: slugs are unique per account, and a mount already
 * there for that slug is the one the session's earlier runs used.
 */
export function addSkillMount(sessionId: string, mount: SkillMount): void {
  const now = Date.now();
  sweep(now);
  const entry = sessions.get(sessionId) ?? { mounts: new Map(), touchedAt: now };
  entry.touchedAt = now;
  if (!entry.mounts.has(mount.slug)) entry.mounts.set(mount.slug, mount);
  sessions.set(sessionId, entry);
}

/** Every mount registered for a session, in the order the skills were loaded. */
export function skillMountsFor(sessionId: string): SkillMount[] {
  const entry = sessions.get(sessionId);
  if (!entry) return [];
  entry.touchedAt = Date.now();
  return [...entry.mounts.values()];
}

/** Forgets a session's mounts. Called when its tool session closes. */
export function clearSkillMounts(sessionId: string): void {
  sessions.delete(sessionId);
}
