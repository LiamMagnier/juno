/**
 * Skill bundles mounted into a sandbox session: the `SkillMount` provider for
 * the execution runtime's client (src/lib/exec, design §6.3 and §6.8).
 *
 * A turn (a chat generation, or a Work run) is one sandbox session. The skills
 * it loads, whether the person armed one with `/slug` or the model loaded one
 * through `use_skill`, are registered in the execution lane's registry
 * (`mountSkill(surface, sessionId, mount)` in src/lib/exec/mounts.ts), which
 * `run_code` reads on every call, so a skill loaded earlier in the turn is at
 * `/skills/<slug>` for every run after it. The runtime uploads each bundle once
 * per session (the host keys it by digest) and records which mount a run's code
 * named (`ToolRun.skillVersionId`, `skillBundleDigest`).
 *
 * A mount is read-only and never widens anything: the sandbox profile (no
 * network, no credentials, nothing but /work and the mounts) is the turn's,
 * whatever the skill asked for. Only a version that passed every check
 * (scanned, consented, enabled) is ever registered.
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
