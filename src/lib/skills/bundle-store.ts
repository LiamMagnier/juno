/**
 * Skill bundles in object storage.
 *
 * One object per (account, digest): the key is the content's sha256, so a
 * re-import of an unchanged folder writes nothing new and two versions of one
 * skill that share their files share one object. Per account rather than
 * global, so erasing an account erases its bundles and no account can learn,
 * by deduplication, that another holds the same files.
 *
 * Every read is checked against the digest it was stored under. A bundle is
 * mounted into a sandbox that runs its scripts; bytes that do not hash to the
 * digest the version was scanned and consented under are not those scripts.
 */

import "server-only";

import { getObjectBytes, headObject, putObject } from "@/lib/storage";
import {
  bundleDigestMatches,
  skillBundleObjectKey,
  unpackTar,
  type SkillBundle,
  type SkillBundleManifest,
} from "@/lib/skills/bundle";

/** The three `WorkSkillVersion` columns a stored bundle fills. */
export interface SkillBundleColumns {
  bundleKey: string;
  bundleDigest: string;
  bundleManifest: SkillBundleManifest;
}

/** Writes a bundle (unless the same bytes are already there) and returns its columns. */
export async function storeSkillBundle(userId: string, bundle: SkillBundle): Promise<SkillBundleColumns> {
  const key = skillBundleObjectKey(userId, bundle.digest);
  const present = await headObject(key, 0).then((head) => head.size === bundle.tar.byteLength).catch(() => false);
  if (!present) await putObject(key, bundle.tar, "application/x-tar");
  return { bundleKey: key, bundleDigest: bundle.digest, bundleManifest: bundle.manifest };
}

export class SkillBundleIntegrityError extends Error {
  constructor() {
    super("The stored skill bundle does not match its digest.");
    this.name = "SkillBundleIntegrityError";
  }
}

/** The tar bytes, verified. Throws `SkillBundleIntegrityError` on a mismatch. */
export async function loadSkillBundleTar(columns: { bundleKey: string; bundleDigest: string }): Promise<Uint8Array> {
  const { bytes } = await getObjectBytes(columns.bundleKey);
  if (!bundleDigestMatches(bytes, columns.bundleDigest)) throw new SkillBundleIntegrityError();
  return bytes;
}

/** Every file of a stored bundle, verified. */
export async function loadSkillBundleFiles(columns: { bundleKey: string; bundleDigest: string }): Promise<Map<string, Uint8Array>> {
  return unpackTar(await loadSkillBundleTar(columns));
}
