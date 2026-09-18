import { redirect } from "next/navigation";

/**
 * `/tasks` — kept as a redirect, not deleted.
 *
 * Scheduled tasks were Juno's first answer to "run this for me later", and
 * Automations are the only one now: they do everything this page could — a
 * prompt on a cadence — plus event triggers, real daylight-saving arithmetic, a
 * missed-run policy, a budget and a run history that records the fires that did
 * NOT happen. The rows themselves have already moved
 * (`scripts/work-scheduler.ts` adopts each one into a `WorkSchedule` that fires
 * at the same wall-clock time), so the person arriving here finds their tasks
 * rather than an explanation of where they went.
 *
 * A redirect rather than a 404 for the same reason `/code/new` is one: this URL
 * is in the sidebar of an older build, in the command palette, in bookmarks and
 * in whatever somebody pasted into a message months ago, and a 404 tells all of
 * them the feature is gone rather than moved.
 *
 * `redirect()` issues a 307, so no browser caches this as permanent and the
 * route can become something else later without a 308 held for ever.
 */
export default function TasksRedirect(): never {
  redirect("/automations");
}
