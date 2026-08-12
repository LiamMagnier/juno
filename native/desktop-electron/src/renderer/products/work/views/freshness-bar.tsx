/**
 * How old this screen is.
 *
 * This strip is not chrome. It is the load-bearing honesty of the whole
 * surface: Work is absent from the account change feed (see
 * `lib/freshness.ts`), so nothing on this page arrives on its own, and every
 * present-tense claim below it is really a past-tense one. The strip says so,
 * gives the user the manual refresh that is the only way to make it newer, and
 * goes loud when the state is old enough that acting on it is a bad idea.
 *
 * What it deliberately does not do:
 *
 *   · It never animates while waiting. A spinner here would imply data is on
 *     the way in the sense of *streaming*, which is the exact misconception the
 *     strip exists to correct. The refresh control shows a busy state on its own
 *     control, for as long as one request takes, and nothing else moves.
 *   · It never hides. A fresh screen still says how fresh, because a freshness
 *     indicator that only appears when things are bad teaches the reader that
 *     its absence means "live".
 *
 * The live region announces the *level*, not the age. A polite region carrying
 * "read 3 seconds ago" would re-announce every second and be switched off by the
 * first screen-reader user who met it.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { assessFreshness, FRESHNESS_EXPLANATION, type Freshness } from '../lib/freshness.js';
import type { WorkPollState } from '../contract.js';
import { TONE_TEXT } from '../lib/vocabulary.js';
import { Disclosure, IconAction, Note, StatusDot } from '../components/primitives.js';
import { IconAlert, IconOffline, IconRefresh } from '../components/icons.js';

const LEVEL_ANNOUNCEMENT: Record<Freshness, string | null> = {
  never: null,
  fresh: null,
  ageing: null,
  stale: 'This task’s state is out of date. Refresh before acting on it.',
  offline: 'Juno cannot be reached. This task’s state is frozen at its last reading.',
};

export function FreshnessBar({
  poll,
  now,
  onRefresh,
  className,
}: {
  readonly poll: WorkPollState;
  readonly now: number;
  readonly onRefresh: () => void;
  readonly className?: string;
}): ReactNode {
  const verdict = assessFreshness(poll, now);
  const announcement = useLevelAnnouncement(verdict.level);

  const refreshReason =
    verdict.refreshing
      ? 'A refresh is already in flight.'
      : !poll.online
        ? 'Juno cannot be reached from this Mac right now.'
        : poll.sessionId === null
          ? 'No task is open.'
          : null;

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center gap-2">
        <StatusDot tone={verdict.tone} />
        <p className={cn('font-mono text-label uppercase', TONE_TEXT[verdict.tone])}>
          {verdict.level === 'offline' ? 'Offline' : verdict.level === 'stale' ? 'Out of date' : 'As of'}
        </p>
        <p className="min-w-0 flex-1 truncate text-caption text-muted-foreground">
          {verdict.level === 'never'
            ? verdict.sentence
            : `Read ${verdict.ageLabel}${poll.online ? ` · next check ${verdict.nextLabel}` : ''}`}
        </p>
        <IconAction
          label={verdict.refreshing ? 'Refreshing this task' : 'Refresh this task now'}
          onClick={onRefresh}
          busy={verdict.refreshing}
          disabledReason={refreshReason}
        >
          <IconRefresh className={cn('size-4', verdict.refreshing ? 'animate-spin' : null)} />
        </IconAction>
      </div>

      {verdict.level === 'stale' || verdict.level === 'offline' ? (
        <Note
          tone={verdict.tone}
          icon={
            verdict.level === 'offline' ? (
              <IconOffline className="size-3.5" />
            ) : (
              <IconAlert className="size-3.5" />
            )
          }
        >
          {verdict.sentence}
        </Note>
      ) : null}

      <Disclosure summary="Why does this need refreshing?">
        <p className="max-w-prose text-caption text-muted-foreground">{FRESHNESS_EXPLANATION}</p>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-caption text-muted-foreground">
          <dt className="font-mono text-label uppercase">Every</dt>
          <dd>{Math.round(poll.intervalMs / 1000)}s</dd>
          <dt className="font-mono text-label uppercase">Last try</dt>
          <dd>
            {poll.lastAttemptedAt === null ? 'never' : verdict.ageLabel}
            {poll.consecutiveFailures > 0 ? ` · ${poll.consecutiveFailures} failed in a row` : ''}
          </dd>
          {poll.error === null ? null : (
            <>
              <dt className="font-mono text-label uppercase">Error</dt>
              <dd className="text-destructive">{poll.error}</dd>
            </>
          )}
        </dl>
      </Disclosure>

      <span role="status" aria-live="polite" className="sr-only">
        {announcement}
      </span>
    </div>
  );
}

/**
 * Announce a freshness level once, when it becomes true.
 *
 * Returns the empty string for levels that are not worth interrupting for, and
 * clears immediately after announcing so the same message can be announced again
 * if the state returns to it later.
 */
function useLevelAnnouncement(level: Freshness): string {
  const [message, setMessage] = useState('');
  const previous = useRef<Freshness | null>(null);

  useEffect(() => {
    if (previous.current === level) return undefined;
    previous.current = level;
    const next = LEVEL_ANNOUNCEMENT[level];
    if (next === null) {
      setMessage('');
      return undefined;
    }
    setMessage(next);
    const id = window.setTimeout(() => {
      setMessage('');
    }, 2000);
    return () => {
      window.clearTimeout(id);
    };
  }, [level]);

  return message;
}
