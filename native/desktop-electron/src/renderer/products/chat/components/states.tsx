/**
 * The states that are not "a transcript with messages in it".
 *
 * Every one of these is designed rather than defaulted, because they are what
 * the user sees at the worst moments: the first time they open the app, and
 * every time something breaks. The rules they follow:
 *
 *   · **Say what happened, then what to do.** "Something went wrong" is not a
 *     state, it is an apology. Each of these names the failure and offers the
 *     one action that addresses it.
 *   · **No indeterminate spinners.** A spinner says "wait" without saying how
 *     long or for what. Where there is a wait, there is a countdown; where
 *     there is no number to show, there is a sentence.
 *   · **Do not overclaim.** Offline says what still works — the transcript is
 *     local and remains fully readable — rather than presenting the whole app
 *     as broken.
 *   · **No illustration, no emoji, no giant card.** A quiet icon, a serif line,
 *     a sentence of explanation. The empty state of a writing tool should look
 *     like the first page of a notebook.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { AlertIcon, ConversationIcon, OfflineIcon, ReconnectIcon } from './icons.js';
import { Button, Eyebrow } from './primitives.js';

/* -------------------------------------------------------------------------- */
/* Shell                                                                       */
/* -------------------------------------------------------------------------- */

function StateShell({
  icon,
  eyebrow,
  title,
  children,
  action,
  tone = 'neutral',
}: {
  icon?: ReactNode;
  eyebrow?: string;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  tone?: 'neutral' | 'error';
}): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-8 py-16">
      <div className="max-w-[46ch] text-center">
        {icon ? (
          <div
            className={cn(
              'mx-auto mb-5 flex size-10 items-center justify-center',
              tone === 'error' ? 'text-destructive-ink' : 'text-muted-foreground',
            )}
          >
            {icon}
          </div>
        ) : null}
        {eyebrow !== undefined ? (
          <div className="mb-2">
            <Eyebrow>{eyebrow}</Eyebrow>
          </div>
        ) : null}
        <h2 className="font-serif text-title text-foreground">{title}</h2>
        {children ? <div className="mt-2 text-body text-muted-foreground">{children}</div> : null}
        {action ? <div className="mt-5 flex justify-center gap-2">{action}</div> : null}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Empty                                                                       */
/* -------------------------------------------------------------------------- */

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * A new, unstarted conversation.
 *
 * No suggestion chips. Prompt suggestions are a confession that the product
 * does not know what it is for, they are almost never what the user wanted,
 * and they push the composer — the only thing on this screen that matters —
 * further from the centre.
 */
export function EmptyConversation(): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-8 pb-48">
      <h2 className="font-serif text-display text-foreground">{greeting()}.</h2>
      <p className="mt-2 text-body text-muted-foreground">What are we working on?</p>
    </div>
  );
}

/** No conversations at all, in the sidebar. */
export function EmptyConversationList({ onNew }: { onNew: () => void }): ReactNode {
  return (
    <div className="px-3 py-8 text-center">
      <ConversationIcon className="mx-auto mb-3 size-6 text-muted-foreground" />
      <p className="text-body text-foreground">No conversations yet</p>
      <p className="mt-1 text-caption text-muted-foreground">Anything you start will be listed here.</p>
      <Button variant="outline" size="sm" onClick={onNew} className="mt-4">
        New conversation
      </Button>
    </div>
  );
}

/** A search with no matches — distinct from having nothing at all. */
export function NoSearchResults({ query, onClear }: { query: string; onClear: () => void }): ReactNode {
  return (
    <div className="px-3 py-8 text-center">
      <p className="text-body text-foreground">Nothing matches “{query}”</p>
      <p className="mt-1 text-caption text-muted-foreground">
        {/* Honest about the limitation rather than leaving the user to conclude
            the search is broken: message bodies are encrypted at rest, so only
            titles can be matched. */}
        Search covers conversation titles. Message contents are encrypted and are not searched.
      </p>
      <Button variant="ghost" size="sm" onClick={onClear} className="mt-3">
        Clear search
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                  */
/* -------------------------------------------------------------------------- */

export function OfflineState({ detail, onRetry }: { detail: string | null; onRetry: () => void }): ReactNode {
  return (
    <StateShell
      icon={<OfflineIcon className="size-6" />}
      eyebrow="Offline"
      title="Juno can’t reach the network"
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {detail ?? 'Your conversations are stored on this Mac and stay readable. New messages will send once you are back online.'}
    </StateShell>
  );
}

/**
 * Reconnecting, with a number.
 *
 * The countdown is local: it is handed a starting value from main and counts it
 * down here rather than requiring a push per second. When it reaches zero it
 * says "Reconnecting now" rather than sitting at 0, because a counter stuck on
 * zero reads as a hang.
 */
export function ReconnectingBanner({
  detail,
  retryInSeconds,
  onRetryNow,
}: {
  detail: string | null;
  retryInSeconds: number | null;
  onRetryNow: () => void;
}): ReactNode {
  const [remaining, setRemaining] = useState(retryInSeconds);

  useEffect(() => {
    setRemaining(retryInSeconds);
    if (retryInSeconds === null) return undefined;
    const handle = window.setInterval(() => {
      setRemaining((value) => (value === null || value <= 0 ? 0 : value - 1));
    }, 1000);
    return () => window.clearInterval(handle);
  }, [retryInSeconds]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2.5 border-b border-border bg-secondary px-4 py-2 text-caption text-muted-foreground"
    >
      <ReconnectIcon className="size-3.5 animate-icon-breathe" />
      <span className="text-foreground">{detail ?? 'Reconnecting to Juno'}</span>
      <span className="tabular-nums">
        {remaining === null || remaining <= 0 ? 'Reconnecting now…' : `Retrying in ${remaining}s`}
      </span>
      <Button variant="ghost" size="sm" onClick={onRetryNow} className="ml-auto">
        Retry now
      </Button>
    </div>
  );
}

/** The offline equivalent of the banner, for when the transcript is still usable. */
export function OfflineBanner({ detail, onRetry }: { detail: string | null; onRetry: () => void }): ReactNode {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center gap-2.5 border-b border-border bg-secondary px-4 py-2 text-caption"
    >
      <OfflineIcon className="size-3.5 text-muted-foreground" />
      <span className="text-foreground">Offline</span>
      <span className="text-muted-foreground">
        {detail ?? 'Past conversations are readable. Sending is paused.'}
      </span>
      <Button variant="ghost" size="sm" onClick={onRetry} className="ml-auto">
        Try again
      </Button>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Failure                                                                     */
/* -------------------------------------------------------------------------- */

export function ConversationError({ message, onRetry }: { message: string; onRetry: () => void }): ReactNode {
  return (
    <StateShell
      tone="error"
      icon={<AlertIcon className="size-6" />}
      eyebrow="Could not open"
      title="This conversation didn’t load"
      action={
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      }
    >
      {message}
    </StateShell>
  );
}

/**
 * The bridge is missing entirely.
 *
 * Distinct from offline, and worth its own state: this is a broken build or a
 * renderer running outside Electron, and "try again" will never fix it. Saying
 * so is more respectful than a retry button that cannot work.
 */
export function DisconnectedState(): ReactNode {
  return (
    <StateShell
      tone="error"
      icon={<AlertIcon className="size-6" />}
      eyebrow="Not connected"
      title="Juno isn’t attached to its host process"
      >
      This window is running without its bridge to the application, so nothing can load. Restarting
      Juno usually resolves it.
    </StateShell>
  );
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The wait while a conversation opens.
 *
 * Bars in the proportions of a real exchange — a short user turn, a longer
 * reply — rather than a spinner. It reserves the right amount of space, so the
 * transcript does not jump when it lands, and it says nothing it does not know.
 */
export function TranscriptSkeleton(): ReactNode {
  return (
    <div aria-hidden="true" className="mx-auto w-full max-w-[72ch] px-8 pt-10">
      {[0, 1].map((turn) => (
        <div key={turn} className="mb-10">
          <div className="mb-3 h-3 w-16 rounded-xs bg-muted" />
          <div className="mb-2 h-4 w-3/5 rounded-xs bg-muted" />
          <div className="mb-6 h-4 w-2/5 rounded-xs bg-muted" />
          <div className="mb-3 h-3 w-24 rounded-xs bg-muted" />
          <div className="mb-2 h-4 w-full rounded-xs bg-muted" />
          <div className="mb-2 h-4 w-11/12 rounded-xs bg-muted" />
          <div className="h-4 w-4/6 rounded-xs bg-muted" />
        </div>
      ))}
      <span className="sr-only" role="status" aria-live="polite">
        Loading the conversation.
      </span>
    </div>
  );
}
