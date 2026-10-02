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
 * closes. An entry is also dropped after 30 minutes without use (the
 * registry's TTL in src/lib/exec/mounts.ts), so a turn that died without
 * closing cannot leak bundles into memory forever. The registry is keyed by
 * account as well as session: a chat session id is a client-chosen generation id.
 */

import "server-only";

import { loadSkillBundleTar } from "@/lib/skills/bundle-store";

import type { SkillMount } from "@/lib/exec/types";

export type { SkillMount };

const MOUNT_SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

/** The execution lane's registry (keyed by surface, account and session): the one run_code reads. */
export { mountSkill, skillMountsFor, clearSkillMounts } from "@/lib/exec/mounts";
