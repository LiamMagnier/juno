/**
 * How old this screen is, and how to say so.
 *
 * ---------------------------------------------------------------------------
 * THE CONSTRAINT THIS MODULE EXISTS FOR
 *
 * Work state does not arrive on its own. `src/main/sync/types.ts` enumerates the
 * 22 entity types the server's change-capture triggers emit — profile, folder,
 * conversation, message, artifact, connection, `code_task`, and so on — and
 * **no `work_*` type is among them**. Work, Knowledge, Research and Import are
 * all absent from the account change feed. There is therefore no push path by
 * which a Work run's status, plan, question or approval can reach this app.
 * Main polls `/api/work/*` on an interval and pushes what it got.
 *
 * That has a consequence a UI can either hide or state:
 *
 *   **Everything on the Work surface is as of the last successful poll.**
 *
 * Hiding it is easy and is the default failure. A pulsing dot, a "live" badge,
 * a step row that animates — all of them are cheap, all of them imply a
 * subscription, and all of them are false. Worse, they are *convincingly* false
 * exactly when they are most harmful: a run that is sitting on an approval looks
 * identical to a run that is working, and a poller that has been failing for
 * four minutes looks identical to one that succeeded a second ago.
 *
 * So this module turns the poller's own state into a freshness verdict, and the
 * UI renders that verdict everywhere it makes a claim about the present tense.
 * The rule the components follow:
 *
 *   · Never say "is". Say "was, as of N seconds ago".
 *   · Never animate to imply arrival. Motion marks a change we actually saw.
 *   · When the poll is failing, keep the last known data on screen and label it,
 *     rather than blanking the surface. A blank screen is less informative than
 *     stale data that admits it is stale.
 *
 * If a Work SSE relay is ever added in main, none of this changes shape — the
 * ages simply get very small, and `stale` stops being reachable in practice.
 */

import type { WorkPollState } from '../contract.js';
import { parseInstant, timeAgo, timeUntil } from './format.js';
import type { Tone } from './vocabulary.js';

/**
 * The verdict.
 *
 *   never     nothing has ever been fetched for this task
 *   fresh     within about one interval — what you see is what there is
 *   ageing    a poll or two has been missed, or the interval is long
 *   stale     old enough that acting on it could be acting on the past
 *   offline   main cannot reach the backend at all
 */
export type Freshness = 'never' | 'fresh' | 'ageing' | 'stale' | 'offline';

export interface FreshnessVerdict {
  readonly level: Freshness;
  readonly tone: Tone;
  /** Age of the newest successful poll, in ms. Null when there has never been one. */
  readonly ageMs: number | null;
  /** "12s ago". Safe to render as-is. */
  readonly ageLabel: string;
  /** "in 4s" / "now" / "unscheduled". */
  readonly nextLabel: string;
  /** True while a request is actually in flight — the only honest "busy". */
  readonly refreshing: boolean;
  /** One sentence a reader can act on. */
  readonly sentence: string;
}

/**
 * Two intervals is the boundary of `fresh`, not one.
 *
 * One interval would flip to `ageing` on every single tick for a moment before
 * the next response lands, which trains the reader to ignore the label — and a
 * freshness indicator nobody reads is worse than none, because it still occupies
 * the space where a real one would go.
 */
const FRESH_INTERVALS = 2;
/** Beyond this many intervals, the screen is old enough to say so plainly. */
const STALE_INTERVALS = 5;
/** A floor, for the case where main reports an implausibly small interval. */
const MIN_STALE_MS = 60_000;

export function assessFreshness(state: WorkPollState, now: number): FreshnessVerdict {
  const lastSucceeded = parseInstant(state.lastSucceededAt);
  const ageMs = lastSucceeded === null ? null : Math.max(0, now - lastSucceeded);
  const ageLabel = timeAgo(state.lastSucceededAt, now);
  const nextLabel = timeUntil(state.nextAttemptAt, now);
  const refreshing = state.phase === 'polling';

  const interval = state.intervalMs > 0 ? state.intervalMs : 15_000;
  const freshCeiling = interval * FRESH_INTERVALS;
  const staleCeiling = Math.max(interval * STALE_INTERVALS, MIN_STALE_MS);

  if (!state.online) {
    return {
      level: 'offline',
      tone: 'danger',
      ageMs,
      ageLabel,
      nextLabel,
      refreshing,
      sentence:
        ageMs === null
          ? 'Juno cannot be reached, and this task has never been read. Nothing below is known.'
          : `Juno cannot be reached. Everything below is from ${ageLabel} and will not change until the connection comes back.`,
    };
  }

  if (ageMs === null) {
    return {
      level: 'never',
      tone: 'quiet',
      ageMs,
      ageLabel,
      nextLabel,
      refreshing,
      sentence: refreshing
        ? 'Reading this task for the first time.'
        : 'This task has not been read yet.',
    };
  }

  if (state.consecutiveFailures >= 2) {
    return {
      level: 'stale',
      tone: 'notice',
      ageMs,
      ageLabel,
      nextLabel,
      refreshing,
      sentence: `The last ${state.consecutiveFailures} refreshes failed${
        state.error === null ? '' : ` — ${state.error}`
      }. Everything below is from ${ageLabel}.`,
    };
  }

  if (ageMs > staleCeiling) {
    return {
      level: 'stale',
      tone: 'notice',
      ageMs,
      ageLabel,
      nextLabel,
      refreshing,
      sentence: `This has not been refreshed since ${ageLabel}. It may already be out of date — refresh before acting on it.`,
    };
  }

  if (ageMs > freshCeiling) {
    return {
      level: 'ageing',
      tone: 'quiet',
      ageMs,
      ageLabel,
      nextLabel,
      refreshing,
      sentence: `Read ${ageLabel}. Juno checks again ${nextLabel}.`,
    };
  }

  return {
    level: 'fresh',
    tone: 'quiet',
    ageMs,
    ageLabel,
    nextLabel,
    refreshing,
    sentence: `Read ${ageLabel}. Juno checks again ${nextLabel}.`,
  };
}

/**
 * The standing explanation, shown behind a disclosure rather than as a banner.
 *
 * Stated once, in the user's terms, and never softened into "syncing". It is
 * also the honest answer to the question the surface provokes — *why is there a
 * refresh button on a page about a thing that is running right now?*
 */
export const FRESHNESS_EXPLANATION =
  'Work does not stream to this app. Juno asks the server for this task on a timer and shows you what came back, ' +
  'so everything here is as of the time above rather than as of this second. Nothing arrives on its own between checks.';

/** The short version, for a tooltip. */
export const FRESHNESS_EXPLANATION_SHORT = 'Polled, not streamed. Everything here is as of the last check.';

/**
 * The sentence attached to a decision control while the screen is stale.
 *
 * Approving an action described by a five-minute-old card is approving
 * something that may already have expired or been superseded. The server
 * refuses exactly that (digest mismatch, expired, already decided); this is the
 * client saying so first, in a sentence, rather than letting the user find out
 * through a refusal. Returns null when the screen is fresh enough to need no
 * caveat.
 */
export function stalenessCaveat(verdict: FreshnessVerdict): string | null {
  if (verdict.level === 'offline') {
    return 'Juno cannot be reached, so this cannot be sent. It will still be waiting when the connection comes back.';
  }
  if (verdict.level === 'stale') {
    return `This was read ${verdict.ageLabel}. If it has already been answered elsewhere, or has expired, Juno will refuse it and say so.`;
  }
  return null;
}
