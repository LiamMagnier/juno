/*
 * WHO CAN ACTUALLY BE STEERED — the one answer the composer and the hook share.
 *
 * `steer` is a control: the route appends it to the task's event stream and a
 * host picks it up on its next poll. Delivering the LIST is not the same as
 * acting on it, and only the cloud driver acts. The Mac host's control switch
 * (native/macOS/JunoDesktop/App/DesktopCodeHost.swift) handles
 * `approval_response` and `cancel_request` and drops everything else into
 * `default: break` — its executor has no steer seam to call — so a `steer` sent
 * to a device task is appended, never read, and never acked. The composer would
 * sit on "Juno Code has your instruction" forever while the run carried on
 * exactly as before.
 *
 * So the verb is offered for cloud only. That is a narrowing of the promise
 * rather than a feature being withheld: the same rule the rollback verbs
 * already follow ("the web and iOS surfaces therefore do not offer controls
 * this runtime cannot acknowledge truthfully"). When a host announces the verb,
 * `canSteerRun` is the one place that has to learn about it.
 *
 * Pure on purpose: the hook that uses it is a client module and the route that
 * mirrors it is server-only, so a test can only reach the decision if it lives
 * on its own.
 */

/**
 * The statuses in which a task row exists and a host is either holding it or on
 * its way to it.
 *
 * `queued` is in the set because the cloud driver reads its unconsumed `steer`
 * controls out of the single-use runner-context handoff and folds them into the
 * prompt it opens with — so words added during the minute a machine takes to
 * appear reach the run rather than being refused. `stopping` is out: that run is
 * being taken down. `submitting` is out too — there is no row yet for a control
 * to hang off.
 */
export const STEERABLE_STATUSES = ["queued", "running", "awaiting_approval"] as const;

export type SteerableStatus = (typeof STEERABLE_STATUSES)[number];

const STEERABLE: ReadonlySet<string> = new Set(STEERABLE_STATUSES);

/**
 * Whether a new instruction may be sent INTO this run.
 *
 * `target` is the task's own `target` column as `serializeTask` hands it over.
 * Anything that is not the string "cloud" — including a task frame that arrived
 * without the field — answers false, because the honest default for a runtime
 * we cannot identify is the one that acknowledges nothing.
 */
export function canSteerRun(status: string, target: string | null | undefined): boolean {
  return target === "cloud" && STEERABLE.has(status);
}

/**
 * How many unconsumed `steer` controls the runner-context handoff hands over.
 *
 * Mirrors `readPendingSteers` in scripts/cloud-code-runner.mjs, which reads the
 * first 20 entries and discards the rest. Sending more than the far side reads
 * is a payload nobody consumes.
 */
export const MAX_PENDING_STEERS = 20;

/**
 * Total characters of steer text one handoff may carry.
 *
 * A steer's text is the typed words with every attachment's extracted text
 * folded in, so one entry can be of the order of a megabyte. The runner
 * concatenates the whole list into the prompt it opens with, so an uncapped
 * handoff is both a multi-megabyte HTTP response and a first prompt no model
 * can use.
 */
export const MAX_PENDING_STEER_CHARS = 200_000;
