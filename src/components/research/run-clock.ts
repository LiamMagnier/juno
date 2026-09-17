import { isWorkingResearchState, type ResearchEventDTO, type ResearchState } from "@/lib/research/domain";

/**
 * How long a live run has actually been WORKING, from its own event log.
 *
 * The obvious clock — `now - createdAt` — is wrong for this product in the one
 * place it would be shown. A web run parks at the clarify gate and again at the
 * plan gate until a person answers, which can be overnight, and it parks again
 * whenever they press pause. A figure that counts that idle time would tell a
 * reader who came back after lunch that their four-minute investigation had
 * taken ninety, and it would keep climbing while the run sat waiting for them.
 * That is not a duration; it is the time since they asked.
 *
 * So the clock sums only the stretches the run spent in a working state, read
 * off the `state_changed` events the engine appends on every transition, and
 * counts the current stretch against `now` only when the run is working right
 * now. It is a pure function of the log so a resumed page shows the same
 * number as the tab that watched the run live, and so the arithmetic can be
 * tested against a hand-written log rather than a live engine.
 *
 * The one fallback: a log with no `state_changed` at all but a run that says it
 * is working. That is a page that has not yet received the transition (the
 * event page is capped and a poll can lag the row) or a run from before the
 * event existed. It anchors on `createdAt` rather than showing nothing, because
 * a working run with no clock looks stalled — the exact impression this whole
 * surface exists to prevent.
 */
export function workingElapsedMs(
  events: readonly ResearchEventDTO[],
  run: { state: ResearchState; createdAt?: string | null },
  now: number
): number | null {
  let total = 0;
  let current: string | null = null;
  let since = 0;
  let transitions = 0;
  for (const event of events) {
    if (event.kind !== "state_changed") continue;
    const at = Date.parse(event.createdAt);
    const to = typeof event.payload.state === "string" ? event.payload.state : null;
    if (!Number.isFinite(at) || !to) continue;
    if (current !== null && isWorkingResearchState(current)) total += Math.max(0, at - since);
    current = to;
    since = at;
    transitions += 1;
  }

  if (transitions === 0) {
    if (!isWorkingResearchState(run.state)) return null;
    const created = run.createdAt ? Date.parse(run.createdAt) : Number.NaN;
    return Number.isFinite(created) ? Math.max(0, now - created) : null;
  }

  // The live tail is counted only when the LOG says the run is working, not
  // when the row does: a row that has moved on but whose transition has not
  // reached this page would otherwise count parked time as work until the
  // event landed. Frozen for one poll beats wrong for one poll.
  if (current !== null && isWorkingResearchState(current)) total += Math.max(0, now - since);
  if (total === 0 && !isWorkingResearchState(run.state)) return null;
  return total;
}
