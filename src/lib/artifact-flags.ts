/**
 * The switches for Artifacts R1, as environment variables.
 *
 * There is no flag plumbing yet (the merge plan's FeatureFlag table is
 * deferred), so these follow `publicShareProfile` in sandbox-policy.ts: read
 * the env on every call, with the value injectable so tests need not touch
 * `process.env`. Rolling a behaviour back is `JUNO_…=0` and
 * `pm2 restart juno-backend --update-env`, no deploy.
 *
 * Each "off" returns exactly the behaviour before R1, and only that behaviour:
 * reads keep hiding the anchor and trashed rows whatever the flags say, so
 * turning a flag off never leaks a half-state (a trashed artifact reappearing,
 * the anchor listed as a chat).
 *
 * Server-side only in effect: none of these is `NEXT_PUBLIC_`, so in a browser
 * they read undefined, which is "on" for the first three. The UI never asks;
 * it reads what the server answered (e.g. `kept` from kept-artifacts).
 */

/**
 * `lifecycle.detachOnDelete`, on unless `JUNO_LIFECYCLE_DETACH_ON_DELETE=0`.
 * Off: deleting a conversation deletes its artifacts with it again. The anchor
 * stays hidden and refused either way.
 */
export function detachOnDeleteEnabled(flag: string | undefined = process.env.JUNO_LIFECYCLE_DETACH_ON_DELETE): boolean {
  return flag !== "0";
}

/**
 * `ai.reemitGuard`, on unless `JUNO_AI_REEMIT_GUARD=0`. Off: every re-emit
 * appends a version, even over a person's edit.
 */
export function reemitGuardEnabled(flag: string | undefined = process.env.JUNO_AI_REEMIT_GUARD): boolean {
  return flag !== "0";
}

/**
 * `artifacts.trash`, on unless `JUNO_ARTIFACTS_TRASH=0`. Off:
 * `DELETE /api/artifacts/[id]` hard-deletes, as before R1.
 */
export function artifactTrashEnabled(flag: string | undefined = process.env.JUNO_ARTIFACTS_TRASH): boolean {
  return flag !== "0";
}

/**
 * Whether the purge job really deletes. OFF unless `JUNO_ARTIFACTS_PURGE=1`,
 * the one flag here that defaults off. It is a hard gate: until the deletion
 * ledger lands (04-MERGE-PLAN §3.4, §13.5), the job only logs what it would
 * purge, and nothing becomes eligible before R1 plus 30 days anyway.
 */
export function artifactPurgeArmed(flag: string | undefined = process.env.JUNO_ARTIFACTS_PURGE): boolean {
  return flag === "1";
}
