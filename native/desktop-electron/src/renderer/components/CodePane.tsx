/**
 * Code mode.
 *
 * The one surface in this shell with a live backend behind it, so it is where
 * the "every state matters" rule has to be paid rather than described. The
 * order of the checks below is the order the user hits them, and each one is a
 * different screen:
 *
 *   1. no workspace chosen        → point at the sidebar, offer the picker
 *   2. workspace not trusted      → the trust decision, stated plainly
 *   3. agent host not running     → say so, and disable Start *with the reason*
 *   4. no session yet             → Start, with its own pending state
 *   5. session live               → transcript, approvals, composer
 *   6. session failed             → the error, and a way back to 4
 *
 * The transcript itself is deliberately opaque and dense: no cards, no bubbles,
 * no rounded box per row. Tool calls are mono because they are technical
 * metadata; assistant prose is serif because it is prose. That contrast is the
 * whole visual system here, and it does more for scanability than any amount of
 * chrome would.
 *
 * Approvals are the exception that earns a box. A blocked turn waiting on a
 * decision is the one moment the user must not scroll past.
 */

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { useShell } from '../state/shell-state.js';
import { useSystem } from '../state/system-state.js';
import { useWorkspaces } from '../state/workspaces.js';
import {
  useCodeSession,
  type ApprovalRequest,
  type PermissionMode,
  type TimelineEntry,
} from '../state/code-session.js';
import { Composer } from './Composer.js';
import { SegmentedControl, type SegmentedOption } from './SegmentedControl.js';
import { Button } from './primitives/Button.js';
import { EmptyState, Meta, Spinner, StatusDot } from './primitives/atoms.js';
import { AlertIcon, CodeIcon, FolderIcon, PlayIcon, ShieldIcon } from './icons.js';

const MODE_OPTIONS: readonly SegmentedOption<PermissionMode>[] = [
  { value: 'plan', label: 'Plan' },
  { value: 'ask', label: 'Ask' },
  { value: 'auto-edit', label: 'Auto-edit' },
  { value: 'full', label: 'Full' },
];

export function CodePane(): ReactNode {
  const { setActiveWorkspace } = useShell();
  const { active, items, choose, choosing, setTrust, trustPendingId } = useWorkspaces();
  const { host } = useSystem();
  const session = useCodeSession();

  /* 1 — nothing selected */
  if (!active) {
    return (
      <CenteredState
        icon={<CodeIcon className="h-4 w-4" />}
        title="Choose a workspace"
        body="Code sessions run inside a folder on this Mac. Pick one from the sidebar, or open another."
        action={
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              icon={<FolderIcon className="h-3.5 w-3.5" />}
              onClick={choose}
              loading={choosing}
            >
              Open folder…
            </Button>
            {items.length > 0 ? (
              <Button
                variant="ghost"
                onClick={() => {
                  const first = items[0];
                  if (first) setActiveWorkspace(first.id);
                }}
              >
                Use {items[0]?.name}
              </Button>
            ) : null}
          </div>
        }
      />
    );
  }

  /* 2 — trust gate */
  if (!active.trusted) {
    return (
      <CenteredState
        icon={<ShieldIcon className="h-4 w-4" />}
        title={`Trust ${active.name}?`}
        body="Juno will not read files, run commands or start an agent in a folder you have not trusted. Repository content can be written by anyone who can open a pull request, so this decision is per folder and can be revoked at any time."
        meta={active.path}
        action={
          <Button
            variant="primary"
            icon={<ShieldIcon className="h-3.5 w-3.5" />}
            loading={trustPendingId === active.id}
            onClick={() => setTrust(active.id, true)}
          >
            Trust this folder
          </Button>
        }
      />
    );
  }

  const hostDown = host.status !== 'running';
  const hostReason =
    host.status === 'crashed'
      ? `The agent host stopped unexpectedly.${host.detail ? ` ${host.detail}` : ''}`
      : host.status === 'starting'
        ? 'The agent host is still starting.'
        : 'The agent host is not running.';

  /* 3–4 — no session yet */
  if (session.phase === 'idle' || session.phase === 'starting') {
    return (
      <CenteredState
        icon={<PlayIcon className="h-4 w-4" />}
        title="Start a session"
        body={`A session gives the agent a working directory, a model and a permission mode. Everything it does in ${active.name} is recorded in the transcript.`}
        meta={active.path}
        action={
          <Button
            variant="primary"
            icon={<PlayIcon className="h-3.5 w-3.5" />}
            loading={session.phase === 'starting'}
            disabledReason={hostDown ? hostReason : undefined}
            onClick={() => session.start(active.id)}
          >
            Start session
          </Button>
        }
      />
    );
  }

  /* 5–6 — live */
  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-2">
        <span className="flex min-w-0 items-center gap-2">
          <StatusDot tone={session.phase === 'busy' ? 'pending' : session.phase === 'error' ? 'critical' : 'active'} />
          <span className="truncate text-[13px] text-foreground">{active.name}</span>
          <Meta className="truncate">{session.sessionId ?? '—'}</Meta>
        </span>

        <span className="ml-auto flex items-center gap-2">
          <SegmentedControl
            options={MODE_OPTIONS}
            value={session.mode}
            onChange={session.setMode}
            label="Permission mode"
            layoutId="permission-mode-thumb"
            pattern="radio"
            size="sm"
          />
          <Meta>
            {session.tokensIn.toLocaleString()} in · {session.tokensOut.toLocaleString()} out
          </Meta>
        </span>
      </header>

      <Transcript timeline={session.timeline} approvals={session.approvals} busy={session.phase === 'busy'} />

      {session.phase === 'error' && session.error ? (
        <div className="mx-4 mb-2 flex items-start gap-2 rounded-card border border-border bg-card px-3 py-2">
          <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
          <p className="min-w-0 flex-1 text-xs leading-relaxed text-foreground">{session.error}</p>
          <Button size="sm" variant="secondary" onClick={() => session.start(active.id)}>
            Restart
          </Button>
        </div>
      ) : null}

      <Composer
        label={`Message the agent working in ${active.name}`}
        placeholder="Describe the change…"
        busy={session.phase === 'busy'}
        onStop={session.abort}
        onSubmit={session.sendPrompt}
        disabledReason={hostDown ? hostReason : undefined}
        footer={<span className="font-mono">{session.mode} · Enter to send</span>}
      />
    </>
  );
}

/* -------------------------------------------------------------------------- */

function Transcript({
  timeline,
  approvals,
  busy,
}: {
  timeline: readonly TimelineEntry[];
  approvals: readonly ApprovalRequest[];
  busy: boolean;
}): ReactNode {
  const scroller = useRef<HTMLDivElement | null>(null);
  const stuck = useRef(true);

  /* Follow the tail only while the user is already at the tail. Yanking a
     transcript back down while someone is reading three screens up is the most
     reliably infuriating behaviour a streaming UI can have. */
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    function onScroll(): void {
      if (!node) return;
      stuck.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    }
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  useLayoutEffect(() => {
    const node = scroller.current;
    if (node && stuck.current) node.scrollTop = node.scrollHeight;
  }, [timeline, approvals]);

  return (
    <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {timeline.length === 0 && approvals.length === 0 ? (
        <EmptyState
          title="Session ready"
          description="Nothing has run yet. Describe a change below and the agent's work appears here as it happens — every tool call, every file it touches."
        />
      ) : null}

      <div className="flex flex-col gap-2">
        {timeline.map((entry) => (
          <TimelineRow key={entry.id} entry={entry} />
        ))}

        {approvals.map((request) => (
          <ApprovalCard key={request.callId} request={request} />
        ))}

        {busy && approvals.length === 0 ? (
          <p className="flex items-center gap-2 py-1 text-xs text-muted-foreground" aria-live="off">
            <Spinner className="h-3 w-3" />
            Working…
          </p>
        ) : null}
      </div>
    </div>
  );
}

function TimelineRow({ entry }: { entry: TimelineEntry }): ReactNode {
  switch (entry.kind) {
    case 'assistant':
      return (
        <p className="max-w-prose whitespace-pre-wrap font-serif text-body text-foreground">
          {entry.text}
        </p>
      );

    case 'tool':
      return (
        <div className="flex items-baseline gap-2 font-mono text-caption leading-relaxed">
          <StatusDot
            tone={
              entry.status === 'running'
                ? 'pending'
                : entry.status === 'ok'
                  ? 'active'
                  : entry.status === 'denied'
                    ? 'idle'
                    : 'critical'
            }
            className="translate-y-px"
          />
          <span className={cn('shrink-0', entry.status === 'error' ? 'text-destructive' : 'text-foreground/80')}>
            {entry.name}
          </span>
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{entry.detail}</span>
          <span className="shrink-0 text-muted-foreground">
            {/* The status word carries the meaning; the dot only repeats it. */}
            {entry.status === 'running'
              ? 'running'
              : entry.durationMs !== null
                ? `${Math.round(entry.durationMs)}ms`
                : entry.status}
          </span>
        </div>
      );

    case 'files':
      return (
        <div className="font-mono text-caption leading-relaxed text-muted-foreground">
          <span className="text-foreground/70">{entry.paths.length} file(s) changed</span>
          <ul className="mt-0.5">
            {entry.paths.map((path) => (
              <li key={path} className="truncate">
                {path}
              </li>
            ))}
          </ul>
        </div>
      );

    case 'notice':
      return (
        <p
          className={cn(
            'text-xs leading-relaxed',
            entry.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {entry.text}
        </p>
      );
  }
}

/**
 * A blocked turn.
 *
 * `Allow always` is separated from `Allow` and never made the primary action:
 * it is a standing grant, and standing grants should be chosen deliberately
 * rather than collected by someone clicking the biggest button repeatedly.
 */
function ApprovalCard({ request }: { request: ApprovalRequest }): ReactNode {
  const { resolveApproval } = useCodeSession();
  const risky = request.risk === 'command' || request.risk === 'sensitive';

  return (
    <div
      role="group"
      aria-label={`Approval required for ${request.toolName}`}
      className={cn(
        'rounded-card border bg-card p-3',
        risky ? 'border-primary' : 'border-border',
      )}
    >
      <div className="flex items-center gap-2">
        <ShieldIcon className={cn('h-3.5 w-3.5', risky ? 'text-primary' : 'text-muted-foreground')} />
        <span className="text-sm font-medium text-foreground">Approval required</span>
        <Meta className="ml-auto uppercase tracking-wide">{request.risk}</Meta>
      </div>

      <p className="mt-1.5 text-sm leading-relaxed text-foreground">{request.summary}</p>
      <Meta className="mt-1 block truncate">{request.toolName}</Meta>

      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={() => resolveApproval(request.callId, 'allow')}>
          Allow once
        </Button>
        <Button variant="secondary" size="sm" onClick={() => resolveApproval(request.callId, 'allow_always')}>
          Always allow
        </Button>
        <Button variant="danger" size="sm" onClick={() => resolveApproval(request.callId, 'deny')}>
          Deny
        </Button>
      </div>
    </div>
  );
}

function CenteredState({
  icon,
  title,
  body,
  meta,
  action,
}: {
  icon: ReactNode;
  title: string;
  body: string;
  meta?: string | undefined;
  action?: ReactNode;
}): ReactNode {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6">
      <div className="max-w-prose py-16">
        <span className="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-field border border-border bg-card text-muted-foreground">
          {icon}
        </span>
        <h1 className="font-serif text-title text-foreground">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{body}</p>
        {meta ? <Meta className="mt-3 block truncate">{meta}</Meta> : null}
        {action ? <div className="mt-5">{action}</div> : null}
      </div>
    </div>
  );
}
