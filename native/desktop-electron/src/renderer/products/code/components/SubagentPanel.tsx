/**
 * Subagents.
 *
 * Delegation is the part of an agent session users understand least, and a
 * force-directed graph does not help — it is a picture of the topology when the
 * questions are "what is it doing", "did it touch my files" and "is its work in
 * my tree yet". So: a list with one level of indentation under the root agent,
 * and a push-detail view inside the same rail.
 *
 * Inspecting a subagent must not cost the parent conversation. The detail view
 * replaces only the contents of this rail; the timeline keeps rendering to the
 * left of it, and a Back control returns without any state loss.
 *
 * Two fields get top billing because they are the ones with consequences:
 *
 *  • `isolation` — `git_worktree` means the subagent is writing in a separate
 *    checkout on `worktreeBranch`, so its edits are NOT in your working tree.
 *    `shared_read_only` means it cannot write at all.
 *  • `applied` — whether a worktree agent's work has been merged back. A
 *    completed subagent whose changes were never applied is a common and
 *    expensive misunderstanding, so "completed" and "applied" are never
 *    collapsed into one status.
 */

import { useMemo, type JSX, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { GIT_WORKTREE, isKnownSubagentStatus, type WireSubagentSnapshot } from '../lib/contract.js';
import { formatTokens, relativeTo } from '../lib/format.js';
import { Badge, Button, Mono, StatusDot, type StatusTone } from './primitives.js';
import { AgentsIcon, AlertIcon, BranchIcon, CheckIcon, ChevronRight, LockIcon } from './icons.js';

export interface SubagentPanelProps {
  agents: readonly WireSubagentSnapshot[];
  cwd: string;
  /** Null shows the list; an id shows that agent's detail. */
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Root-agent context so the hierarchy has a visible root. */
  rootModel: string | null;
  rootBusy: boolean;
  className?: string;
}

function toneFor(status: string): StatusTone {
  switch (status) {
    case 'failed':
      return 'error';
    case 'completed':
      return 'done';
    case 'cancelled':
    case 'interrupted':
      return 'done';
    case 'waiting_approval':
      return 'waiting';
    case 'queued':
      return 'idle';
    default:
      return 'active';
  }
}

/**
 * `status` is a wire-level string. A value this build has never heard of still
 * renders — marked, so the UI is honest that it does not know what it means,
 * rather than silently showing it as if it were understood.
 */
function statusWord(status: string): string {
  const word = status.replace(/_/g, ' ');
  return isKnownSubagentStatus(status) ? word : `${word} (unrecognised)`;
}

function IsolationChip({ agent }: { agent: WireSubagentSnapshot }): JSX.Element {
  if (agent.isolation === GIT_WORKTREE) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-px"
        title={`Writes in an isolated git worktree${
          agent.worktreeBranch !== undefined ? ` on ${agent.worktreeBranch}` : ''
        }`}
      >
        <BranchIcon className="h-3 w-3 text-muted-foreground" />
        <Mono className="text-muted-foreground">
          {agent.worktreeBranch ?? 'worktree'}
        </Mono>
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 rounded border border-border bg-muted px-1.5 py-px"
      title="Shared checkout, read-only — this agent cannot write."
    >
      <LockIcon className="h-3 w-3 text-muted-foreground" />
      <Mono className="text-muted-foreground">read-only</Mono>
    </span>
  );
}

/** The applied/unapplied fact, stated rather than implied. */
function AppliedState({ agent }: { agent: WireSubagentSnapshot }): JSX.Element | null {
  if (!agent.writes) return null;
  const conflicts = agent.conflictedFiles ?? [];
  if (conflicts.length > 0) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/60 bg-destructive/5 px-2 py-1.5">
        <AlertIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-destructive">
            {conflicts.length} conflicted {conflicts.length === 1 ? 'file' : 'files'}
          </p>
          <ul className="mt-0.5 space-y-px">
            {conflicts.map((path) => (
              <li key={path}>
                <Mono className="block truncate text-foreground">{path}</Mono>
              </li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  if (agent.applied === true) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-2 py-1.5">
        <CheckIcon className="h-3.5 w-3.5 shrink-0 text-foreground" />
        <p className="text-[12px] text-foreground">Changes applied to your working tree.</p>
      </div>
    );
  }
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-card px-2 py-1.5">
      <BranchIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <p className="text-[12px] leading-snug text-muted-foreground">
        Not applied. Work stays on{' '}
        <Mono className="text-foreground">{agent.worktreeBranch ?? 'its worktree branch'}</Mono>{' '}
        until it is merged back.
      </p>
    </div>
  );
}

function AgentRow({
  agent,
  onSelect,
}: {
  agent: WireSubagentSnapshot;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(agent.id)}
        className={cn(
          'group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left',
          'transition-colors duration-100 hover:bg-muted active:bg-accent',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        )}
      >
        <StatusDot tone={toneFor(agent.status)} className="mt-1.5" />
        <span className="min-w-0 flex-1">
          <span className="flex items-baseline gap-1.5">
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
              {agent.title}
            </span>
            <Badge tone="neutral" className="shrink-0">
              {agent.role}
            </Badge>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            <Mono className="truncate text-muted-foreground">
              {agent.status === 'running' ? agent.currentActivity || 'working' : statusWord(agent.status)}
            </Mono>
          </span>
        </span>
        <ChevronRight className="mt-1 h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </button>
    </li>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className="w-[70px] shrink-0 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className="min-w-0 flex-1 text-[12px] text-foreground">{children}</span>
    </div>
  );
}

function SubagentDetail({
  agent,
  cwd,
  onBack,
}: {
  agent: WireSubagentSnapshot;
  cwd: string;
  onBack: () => void;
}): JSX.Element {
  const files = agent.filesChanged ?? [];
  const commands = agent.commandsExecuted ?? [];
  const warnings = agent.warnings ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex items-center gap-2 border-b border-border px-2 py-1.5">
        <Button size="sm" variant="ghost" onClick={onBack}>
          ← All agents
        </Button>
        <span className="flex-1" />
        <StatusDot tone={toneFor(agent.status)} />
        <Mono className="text-muted-foreground">{statusWord(agent.status)}</Mono>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">
        <h3 className="text-[13px] font-medium leading-snug text-foreground">{agent.title}</h3>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          <Badge tone="primary">{agent.role}</Badge>
          <IsolationChip agent={agent} />
          <Badge tone="neutral">{agent.writes ? 'writes' : 'read-only'}</Badge>
        </div>

        {agent.status === 'running' && agent.currentActivity.length > 0 ? (
          <p className="mt-2 rounded-md border border-border bg-card px-2 py-1.5 font-mono text-[11px] text-foreground">
            {agent.currentActivity}
          </p>
        ) : null}

        <div className="mt-3">
          <AppliedState agent={agent} />
        </div>

        <div className="mt-3 border-t border-border pt-2">
          <Field label="Model">
            <Mono className="text-foreground">{agent.model}</Mono>
          </Field>
          <Field label="Id">
            <Mono className="text-muted-foreground">{agent.id}</Mono>
          </Field>
          <Field label="Tokens">
            <Mono className="text-foreground">
              {formatTokens(agent.usage.inputTokens)} in / {formatTokens(agent.usage.outputTokens)} out
            </Mono>
          </Field>
          {agent.startedAt !== undefined ? (
            <Field label="Started">
              <Mono className="text-muted-foreground">{agent.startedAt}</Mono>
            </Field>
          ) : null}
          {agent.completedAt !== undefined ? (
            <Field label="Finished">
              <Mono className="text-muted-foreground">{agent.completedAt}</Mono>
            </Field>
          ) : null}
        </div>

        {agent.error !== undefined ? (
          <div className="mt-3 rounded-md border border-destructive/60 bg-destructive/5 px-2 py-1.5">
            <p className="text-[12px] font-medium text-destructive">Failed</p>
            <p className="mt-0.5 whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-foreground">
              {agent.error}
            </p>
          </div>
        ) : null}

        {agent.summary !== undefined ? (
          <section className="mt-3 border-t border-border pt-2">
            <h4 className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              Result
            </h4>
            <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground">
              {agent.summary}
            </p>
          </section>
        ) : null}

        {warnings.length > 0 ? (
          <section className="mt-3 border-t border-border pt-2">
            <h4 className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              Warnings
            </h4>
            <ul className="space-y-1">
              {warnings.map((warning) => (
                <li key={warning} className="flex items-start gap-1.5">
                  <AlertIcon className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="text-[12px] leading-snug text-muted-foreground">{warning}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {files.length > 0 ? (
          <section className="mt-3 border-t border-border pt-2">
            <h4 className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              Files changed · {files.length}
            </h4>
            <ul className="space-y-px">
              {files.map((path) => (
                <li key={path}>
                  <Mono className="block truncate text-foreground" title={path}>
                    {relativeTo(cwd, path)}
                  </Mono>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {commands.length > 0 ? (
          <section className="mt-3 border-t border-border pt-2">
            <h4 className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              Commands · {commands.length}
            </h4>
            <ul className="space-y-px">
              {commands.map((command, index) => (
                // eslint-disable-next-line react/no-array-index-key -- a subagent can run the same command twice; ordinal position is the identity
                <li key={`${index}-${command}`}>
                  <Mono className="block truncate text-foreground" title={command}>
                    <span className="select-none text-muted-foreground">$ </span>
                    {command}
                  </Mono>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

export function SubagentPanel({
  agents,
  cwd,
  selectedId,
  onSelect,
  rootModel,
  rootBusy,
  className,
}: SubagentPanelProps): JSX.Element {
  const selected = useMemo(
    () => agents.find((agent) => agent.id === selectedId) ?? null,
    [agents, selectedId],
  );

  const active = agents.filter(
    (agent) => agent.status === 'running' || agent.status === 'preparing' || agent.status === 'queued',
  ).length;

  if (selected !== null) {
    return (
      <aside
        aria-label={`Subagent ${selected.title}`}
        className={cn('flex min-h-0 flex-col border-l border-border bg-background', className)}
      >
        <SubagentDetail agent={selected} cwd={cwd} onBack={() => onSelect(null)} />
      </aside>
    );
  }

  return (
    <aside
      aria-label="Subagents"
      className={cn('flex min-h-0 flex-col border-l border-border bg-background', className)}
    >
      <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
        <AgentsIcon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-[12px] font-medium text-foreground">Agents</span>
        <span className="flex-1" />
        {active > 0 ? (
          <Mono className="text-muted-foreground" aria-live="polite">
            {active} running
          </Mono>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {/* The root, so the hierarchy has a visible parent rather than an
            implied one. Subagents indent under it; there is no deeper nesting
            in the contract, so none is invented. */}
        <div className="px-2 py-1.5">
          <div className="flex items-center gap-2">
            <StatusDot tone={rootBusy ? 'active' : 'idle'} />
            <span className="text-[12.5px] font-medium text-foreground">Root agent</span>
            <span className="flex-1" />
            {rootModel !== null ? <Mono className="text-muted-foreground">{rootModel}</Mono> : null}
          </div>
        </div>

        {agents.length === 0 ? (
          <div className="px-3 py-2">
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              No subagents have been started. When the agent delegates, each task appears here with
              its own isolation, files and result.
            </p>
          </div>
        ) : (
          <ul className="ml-3 space-y-px border-l border-border pl-1.5 pr-1">
            {agents.map((agent) => (
              <AgentRow key={agent.id} agent={agent} onSelect={onSelect} />
            ))}
          </ul>
        )}
      </div>
    </aside>
  );
}
