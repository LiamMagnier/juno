/**
 * The states that are not a running task.
 *
 * Each of these is a real state with a real cause, and each says which cause it
 * is. The distinction that matters most on this surface is between *nothing to
 * show* and *could not be read*: they look identical if you only draw an empty
 * box, and they call for opposite actions. "You have no tasks" invites writing
 * one; "this list could not be refreshed" invites trying again, and warns that
 * anything created in the last few seconds may be missing.
 *
 * None of these blanks the screen when there is older data available. A stale
 * screen that admits it is stale carries strictly more information than an
 * empty one, and the freshness strip is already there to label it.
 */

import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { Action, Eyebrow, Panel } from '../components/primitives.js';
import { IconAlert, IconOffline, IconPlus, IconRefresh } from '../components/icons.js';

function StateShell({
  eyebrow,
  title,
  children,
  action,
  icon,
  tone = 'quiet',
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly icon?: ReactNode;
  readonly tone?: 'quiet' | 'notice' | 'danger';
}): ReactNode {
  return (
    <Panel
      level="flat"
      className="flex flex-col items-start gap-2 border-dashed p-6"
      role="status"
    >
      <span className="inline-flex items-center gap-2">
        {icon === undefined ? null : (
          <span
            className={cn(
              tone === 'danger'
                ? 'text-destructive'
                : tone === 'notice'
                  ? 'text-warning'
                  : 'text-muted-foreground',
            )}
          >
            {icon}
          </span>
        )}
        <Eyebrow tone={tone}>{eyebrow}</Eyebrow>
      </span>
      <h2 className="text-heading text-foreground">{title}</h2>
      <div className="max-w-prose text-caption text-muted-foreground">{children}</div>
      {action === undefined ? null : <div className="mt-1">{action}</div>}
    </Panel>
  );
}

/** Nothing selected, and nothing to select. */
export function NoTasksState({ onCompose }: { readonly onCompose: () => void }): ReactNode {
  return (
    <StateShell
      eyebrow="Work"
      title="No tasks yet"
      action={
        <Action variant="primary" icon={<IconPlus className="size-4" />} onClick={onCompose}>
          Write a task
        </Action>
      }
    >
      Work is for everything that is not code: you write a goal, Juno plans it, works it, stops to
      ask when only you can decide, and hands back a deliverable.
    </StateShell>
  );
}

/** A task is open but nothing has been read for it yet. */
export function FirstReadState(): ReactNode {
  return (
    <StateShell eyebrow="Reading" title="Reading this task">
      Juno is asking the server for this task’s current state. Nothing here is known until it
      answers.
    </StateShell>
  );
}

/**
 * Main cannot reach the backend.
 *
 * Named for the cause, not the symptom. "Offline" here means *this app cannot
 * reach Juno*, which is a different thing from the run having stopped — a cloud
 * run keeps going perfectly well while this window is disconnected, and the copy
 * says so rather than implying the work has halted.
 */
export function OfflineState({
  lastReadLabel,
  onRetry,
}: {
  readonly lastReadLabel: string | null;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <StateShell
      eyebrow="Offline"
      tone="danger"
      icon={<IconOffline className="size-4" />}
      title="Juno cannot be reached"
      action={
        <Action icon={<IconRefresh className="size-4" />} onClick={onRetry}>
          Try again
        </Action>
      }
    >
      {lastReadLabel === null
        ? 'Nothing has been read for this task, so nothing below is known.'
        : `Everything shown is from ${lastReadLabel} and will not change until the connection comes back.`}{' '}
      A task running in Juno’s cloud carries on regardless — this window simply cannot see it.
    </StateShell>
  );
}

/** The IPC bridge itself is missing. A developer-facing state, said plainly. */
export function DisconnectedState(): ReactNode {
  return (
    <StateShell
      eyebrow="Not connected"
      tone="danger"
      icon={<IconAlert className="size-4" />}
      title="Not connected to the Juno host process"
    >
      This window has no bridge to the part of Juno that talks to the network, so it cannot read or
      change anything. Nothing has been lost; reopening the window is the fix.
    </StateShell>
  );
}

/** A task that could not be read at all — as distinct from a task that failed. */
export function UnreadableState({
  detail,
  onRetry,
}: {
  readonly detail: string;
  readonly onRetry: () => void;
}): ReactNode {
  return (
    <StateShell
      eyebrow="Could not read"
      tone="notice"
      icon={<IconAlert className="size-4" />}
      title="This task could not be read"
      action={
        <Action icon={<IconRefresh className="size-4" />} onClick={onRetry}>
          Try again
        </Action>
      }
    >
      {detail} The task itself is unaffected — this is about reading it, not about running it.
    </StateShell>
  );
}
