/**
 * The artifact lifecycle's two switches, as environment variables (taken from
 * artifacts/r1-lifecycle, DECISIONS D-004).
 *
 * There is no flag plumbing, so these follow `publicShareProfile` in
 * sandbox-policy.ts: read the env on every call, with the value injectable so
 * tests need not touch `process.env`. Rolling a behaviour back is `JUNO_…=0`
 * and `pm2 restart juno-backend --update-env`, no deploy.
 */

/**
 * The re-emit guard, on unless `JUNO_AI_REEMIT_GUARD=0`. Off: every model
 * re-emit appends a version, even over a person's edit (the old behaviour).
 */
export function reemitGuardEnabled(flag: string | undefined = process.env.JUNO_AI_REEMIT_GUARD): boolean {
  return flag !== "0";
}

/**
 * Whether the scheduled trash purge really deletes. OFF unless
 * `JUNO_ARTIFACTS_PURGE=1`: until someone arms it the maintenance daemon only
 * logs what it would purge. The owner's explicit "Delete now" on one trashed
 * artifact is not gated by this; it is the person's own decision about their
 * own row.
 */
export function artifactPurgeArmed(flag: string | undefined = process.env.JUNO_ARTIFACTS_PURGE): boolean {
  return flag === "1";
}
