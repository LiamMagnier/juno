/**
 * Session header: where the agent is working, under what policy, and how to
 * stop it.
 *
 * Everything shown here is a fact from the contract, never a decoration:
 * workspace name and trust from `Workspace`, branch from the same, model and
 * provider from `session_started`, mode from `mode_changed`, run state from the
 * event stream, token totals from `turn_finished`.
 *
 * The two controls the brief asks for that the IPC contract does not support —
 * changing the model mid-session, and a reasoning-effort setting — are rendered
 * disabled with the reason attached. `code:start-session` accepts a model at
 * creation and there is no channel to change it afterwards; there is no
 * reasoning field anywhere in the contract. Showing them as working controls
 * would be a lie the first time someone used one.
 */

import type { JSX } from 'react';
import { cn } from '../lib/cn.js';
import type { PermissionMode, Usage } from '../lib/contract.js';
import { formatTokens } from '../lib/format.js';
import type { RunStatus } from '../state/timeline-store.js';
import type { HostStatus } from '../state/useCodeSession.js';
import { Badge, Button, Mono, StatusDot } from './primitives.js';
import { ModeSelector } from './ModeSelector.js';
import { AlertIcon, BranchIcon, FolderIcon, LockIcon, StopIcon } from './icons.js';

export interface SessionHeaderProps {
  workspaceName: string;
  workspacePath: string;
  branch: string | null;
  trusted: boolean;
  isGitRepository: boolean;
  provider: string | null;
  model: string | null;
  mode: PermissionMode | null;
  status: RunStatus;
  hostStatus: HostStatus;
  bridgeAvailable: boolean;
  usage: Usage;
  subagentUsage: Usage;
  onModeChange: (mode: PermissionMode) => void;
  onAbort: () => void;
  className?: string;
}

function statusCopy(status: RunStatus): { tone: 'idle' | 'active' | 'waiting' | 'error' | 'done'; label: string } {
  switch (status) {
    case 'idle':
      return { tone: 'idle', label: 'Idle' };
    case 'starting':
      return { tone: 'active', label: 'Starting' };
    case 'thinking':
      return { tone: 'active', label: 'Thinking' };
    case 'working':
      return { tone: 'active', label: 'Running tools' };
    case 'awaiting-approval':
      return { tone: 'waiting', label: 'Waiting for you' };
    case 'failed':
      return { tone: 'error', label: 'Failed' };
    case 'aborted':
      return { tone: 'done', label: 'Stopped' };
  }
}

function hostCopy(status: HostStatus): { label: string; danger: boolean } | null {
  switch (status) {
    case 'running':
      return null;
    case 'starting':
      return { label: 'Agent host starting', danger: false };
    case 'stopped':
      return { label: 'Agent host stopped', danger: false };
    case 'crashed':
      return { label: 'Agent host crashed', danger: true };
  }
}

export function SessionHeader({
  workspaceName,
  workspacePath,
  branch,
  trusted,
  isGitRepository,
  provider,
  model,
  mode,
  status,
  hostStatus,
  bridgeAvailable,
  usage,
  subagentUsage,
  onModeChange,
  onAbort,
  className,
}: SessionHeaderProps): JSX.Element {
  const run = statusCopy(status);
  const host = hostCopy(hostStatus);
  const running = status === 'thinking' || status === 'working' || status === 'starting';
  const totalTokens =
    usage.inputTokens + usage.outputTokens + subagentUsage.inputTokens + subagentUsage.outputTokens;

  return (
    <header
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-background px-3 py-2',
        className,
      )}
    >
      {/* Workspace identity */}
      <div className="flex min-w-0 items-center gap-1.5">
        <FolderIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate text-[13px] font-medium text-foreground" title={workspacePath}>
          {workspaceName}
        </span>
        {!trusted ? (
          <Badge tone="danger">
            <LockIcon className="h-2.5 w-2.5" />
            untrusted
          </Badge>
        ) : null}
      </div>

      {isGitRepository ? (
        <div className="flex items-center gap-1">
          <BranchIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
          <Mono className="text-muted-foreground">{branch ?? 'detached'}</Mono>
        </div>
      ) : (
        <Mono className="text-muted-foreground" title="Not a git repository">
          no git
        </Mono>
      )}

      <span className="h-4 w-px bg-border" />

      {/* Policy */}
      <ModeSelector
        mode={mode}
        onChange={onModeChange}
        disabled={!trusted || !bridgeAvailable}
        disabledReason={
          !bridgeAvailable
            ? 'Not connected to the Juno host process.'
            : 'Trust this workspace before changing its permission mode.'
        }
      />

      <span className="flex-1" />

      {/* Model + reasoning: read-only, with the reason they are read-only. */}
      <div className="flex items-center gap-1.5">
        <Mono className="text-muted-foreground">{provider ?? '—'}</Mono>
        <Mono
          className="rounded border border-border bg-muted px-1.5 py-px text-foreground"
          title="The model is fixed for the life of a session: code:start-session takes it at creation and no channel changes it afterwards."
        >
          {model ?? 'no model'}
        </Mono>
        <Button
          size="sm"
          variant="ghost"
          disabled
          disabledReason="Reasoning effort is not part of the agent contract — no field on code:start-session or any other channel carries it."
        >
          reasoning: n/a
        </Button>
      </div>

      {totalTokens > 0 ? (
        <Mono className="text-muted-foreground" title="Tokens this session, including subagents">
          {formatTokens(totalTokens)} tok
        </Mono>
      ) : null}

      <span className="h-4 w-px bg-border" />

      {/* Run state, announced. */}
      <div className="flex items-center gap-1.5" aria-live="polite" aria-atomic="true">
        <StatusDot tone={run.tone} />
        <span
          className={cn(
            'text-[12px]',
            run.tone === 'error' ? 'text-destructive' : 'text-muted-foreground',
          )}
        >
          {run.label}
        </span>
      </div>

      {host !== null ? (
        <span
          className={cn(
            'inline-flex items-center gap-1 rounded border px-1.5 py-px',
            host.danger
              ? 'border-destructive/50 bg-destructive/10 text-destructive'
              : 'border-border bg-muted text-muted-foreground',
          )}
        >
          <AlertIcon className="h-3 w-3" />
          <Mono>{host.label}</Mono>
        </span>
      ) : null}

      {/* Stop is always mounted — disabled when there is nothing to stop, never
          absent, so its position never moves. */}
      <Button
        variant="danger"
        size="sm"
        icon={<StopIcon className="h-3 w-3" />}
        onClick={onAbort}
        disabled={!running}
        disabledReason="Nothing is running."
        aria-label="Stop the agent"
      >
        Stop
      </Button>
    </header>
  );
}
