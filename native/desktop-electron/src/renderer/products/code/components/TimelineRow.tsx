/**
 * One timeline entry.
 *
 * Memoized on entry identity. Because `CodeSessionStore` never mutates an entry
 * object in place — it replaces the one entry that changed and leaves the rest
 * alone — this `memo` is a true short-circuit: an event at the tail of a
 * 10,000-entry session re-renders exactly one row.
 *
 * Rows are dense by construction: one line per fact, monospace for anything the
 * user could paste into a terminal, and detail behind a disclosure rather than
 * on screen by default.
 */

import { memo, type JSX, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { formatDuration, formatTokens, relativeTo, firstLine } from '../lib/format.js';
import { describeCategory, splitPath, type ToolCategory } from '../lib/tools.js';
import { riskPresentation } from '../lib/risk.js';
import type {
  ApprovalEntry,
  ChangeEntry,
  CodeSessionStore,
  MessageEntry,
  NoticeEntry,
  PromptEntry,
  SubagentEntry,
  TimelineEntry,
  ToolCall,
  ToolGroupEntry,
  TurnEntry,
} from '../state/timeline-store.js';
import { Badge, Button, Mono, StatusDot } from './primitives.js';
import { MessageMarkdown, StreamingText } from './MessageBody.js';
import {
  AgentsIcon,
  AlertIcon,
  BeakerIcon,
  BranchIcon,
  CheckIcon,
  ChevronDown,
  ChevronRight,
  CloseIcon,
  FileIcon,
  PencilIcon,
  SearchIcon,
  ShieldIcon,
  SpinnerIcon,
  TerminalIcon,
} from './icons.js';

export interface TimelineRowProps {
  entry: TimelineEntry;
  expanded: boolean;
  onToggle: (id: string) => void;
  store: CodeSessionStore;
  cwd: string;
  onReviewApproval: (callId: string) => void;
  onReviewChanges: () => void;
  onInspectSubagent: (id: string) => void;
}

function categoryIcon(category: ToolCategory): ReactNode {
  const className = 'h-3.5 w-3.5';
  switch (category) {
    case 'read':
      return <FileIcon className={className} />;
    case 'search':
      return <SearchIcon className={className} />;
    case 'edit':
      return <PencilIcon className={className} />;
    case 'test':
      return <BeakerIcon className={className} />;
    case 'git':
      return <BranchIcon className={className} />;
    case 'delegate':
      return <AgentsIcon className={className} />;
    case 'shell':
    case 'build':
    case 'other':
    default:
      return <TerminalIcon className={className} />;
  }
}

function CallStatusGlyph({ call }: { call: ToolCall }): JSX.Element {
  switch (call.status) {
    case 'running':
      return <SpinnerIcon className="h-3 w-3 text-primary" />;
    case 'ok':
      return <CheckIcon className="h-3 w-3 text-muted-foreground" />;
    case 'error':
      return <AlertIcon className="h-3 w-3 text-destructive" />;
    case 'denied':
      return <CloseIcon className="h-3 w-3 text-muted-foreground" />;
  }
}

function PathText({ path, cwd }: { path: string; cwd: string }): JSX.Element {
  const relative = relativeTo(cwd, path);
  const { dir, base } = splitPath(relative);
  return (
    <Mono className="truncate">
      <span className="text-muted-foreground">{dir}</span>
      <span className="text-foreground">{base}</span>
    </Mono>
  );
}

/* -------------------------------------------------------------------------- */

function AgentAttribution({ label }: { label: string | null }): JSX.Element | null {
  if (label === null) return null;
  return (
    <Badge tone="primary" className="shrink-0 normal-case">
      {label}
    </Badge>
  );
}

/* -------------------------------------------------------------------------- */

function ToolCallRow({ call, cwd }: { call: ToolCall; cwd: string }): JSX.Element {
  const isPath = call.name === 'read_file' || call.name === 'edit_file' || call.name === 'write_file';
  const failed = call.status === 'error' || call.status === 'denied';
  return (
    <li
      className={cn(
        'flex items-start gap-2 rounded px-1.5 py-1',
        failed && 'bg-destructive/5',
      )}
    >
      <span className="mt-[3px] shrink-0">
        <CallStatusGlyph call={call} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          {isPath && call.target !== null ? (
            <PathText path={call.target} cwd={cwd} />
          ) : (
            <Mono className="truncate text-foreground">{call.summary}</Mono>
          )}
          {call.risk !== 'safe' ? (
            <Badge tone={call.risk === 'sensitive' ? 'danger' : 'neutral'} className="shrink-0">
              {riskPresentation(call.risk).label}
            </Badge>
          ) : null}
        </span>
        {failed && call.output !== null ? (
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded border border-destructive/30 bg-card px-2 py-1 font-mono text-[11px] leading-relaxed text-foreground">
            {call.output}
          </pre>
        ) : call.output !== null && call.output.length > 0 ? (
          <p className="truncate font-mono text-[11px] text-muted-foreground">
            {firstLine(call.output)}
          </p>
        ) : null}
      </span>
      <Mono className="shrink-0 pt-[2px] text-muted-foreground">
        {call.durationMs === null ? '' : formatDuration(call.durationMs)}
      </Mono>
    </li>
  );
}

function ToolGroupRow({
  entry,
  expanded,
  onToggle,
  cwd,
}: {
  entry: ToolGroupEntry;
  expanded: boolean;
  onToggle: (id: string) => void;
  cwd: string;
}): JSX.Element {
  const descriptor = describeCategory(entry.category);
  const running = entry.calls.some((call) => call.status === 'running');
  const failures = entry.calls.filter(
    (call) => call.status === 'error' || call.status === 'denied',
  ).length;
  const totalMs = entry.calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0);
  const single = entry.calls.length === 1 ? entry.calls[0] : undefined;

  const headline =
    single !== undefined
      ? `${descriptor.verb} ${single.target ?? single.summary}`
      : descriptor.groupLabel(entry.calls.length);

  return (
    <div className="py-0.5">
      <button
        type="button"
        onClick={() => onToggle(entry.id)}
        aria-expanded={expanded}
        className={cn(
          'group flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left',
          'transition-colors duration-100 hover:bg-muted/60 active:bg-muted',
          'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        )}
      >
        <span className="shrink-0 text-muted-foreground">
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </span>
        <span className={cn('shrink-0', failures > 0 ? 'text-destructive' : 'text-muted-foreground')}>
          {categoryIcon(entry.category)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
          {single !== undefined && single.target !== null ? (
            <span className="flex items-baseline gap-1.5">
              <span className="shrink-0 text-muted-foreground">{descriptor.verb}</span>
              <PathText path={single.target} cwd={cwd} />
            </span>
          ) : (
            headline
          )}
        </span>
        <AgentAttribution label={entry.agentLabel} />
        {failures > 0 ? (
          <Badge tone="danger" className="shrink-0">
            {failures} failed
          </Badge>
        ) : null}
        {running ? (
          <SpinnerIcon className="h-3 w-3 shrink-0 text-primary" />
        ) : totalMs > 0 ? (
          <Mono className="shrink-0 text-muted-foreground">{formatDuration(totalMs)}</Mono>
        ) : null}
      </button>
      {expanded ? (
        <ul className="ml-[26px] mt-0.5 space-y-px border-l border-border pl-2">
          {entry.calls.map((call) => (
            <ToolCallRow key={call.callId} call={call} cwd={cwd} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function MessageRow({
  entry,
  store,
}: {
  entry: MessageEntry;
  store: CodeSessionStore;
}): JSX.Element {
  return (
    <div className="py-1.5 pl-[26px] pr-2">
      {entry.streaming ? (
        <StreamingText store={store} entryId={entry.id} />
      ) : (
        <MessageMarkdown text={entry.text} />
      )}
    </div>
  );
}

function PromptRow({ entry }: { entry: PromptEntry }): JSX.Element {
  return (
    <div className="my-2 border-l-2 border-primary pl-3">
      <p className="mb-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
        You
      </p>
      <p className="whitespace-pre-wrap break-words text-[13px] leading-[1.6] text-foreground">
        {entry.text}
      </p>
    </div>
  );
}

function TurnRow({ entry }: { entry: TurnEntry }): JSX.Element {
  const finished = entry.stopReason !== null;
  return (
    <div className="flex items-center gap-2 py-2">
      <span className="h-px flex-1 bg-border" />
      <Mono className="shrink-0 uppercase tracking-wide text-muted-foreground">
        Turn {entry.turnIndex + 1}
        {finished ? ` · ${entry.stopReason}` : ''}
        {entry.usage
          ? ` · ${formatTokens(entry.usage.inputTokens)} in / ${formatTokens(entry.usage.outputTokens)} out`
          : ''}
        {entry.subagentUsage
          ? ` · subagents ${formatTokens(
              entry.subagentUsage.inputTokens + entry.subagentUsage.outputTokens,
            )}`
          : ''}
      </Mono>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

function ApprovalRow({
  entry,
  onReviewApproval,
}: {
  entry: ApprovalEntry;
  onReviewApproval: (callId: string) => void;
}): JSX.Element {
  const risk = riskPresentation(entry.request.risk);
  const pending = entry.decision === null;
  return (
    <div
      className={cn(
        'my-1 flex items-start gap-2 rounded-md border px-2 py-1.5',
        risk.tone === 'danger'
          ? 'border-destructive/60 bg-destructive/5'
          : 'border-border bg-card',
      )}
    >
      <ShieldIcon
        className={cn('mt-0.5 h-3.5 w-3.5 shrink-0', risk.tone === 'danger' ? 'text-destructive' : 'text-primary')}
      />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[12.5px] font-medium text-foreground">
            {pending ? 'Approval required' : `Approval ${entry.decision}`}
          </span>
          <Badge tone={risk.tone === 'danger' ? 'danger' : 'neutral'}>{risk.label}</Badge>
          <AgentAttribution label={entry.agentLabel} />
        </div>
        <Mono className="mt-0.5 block truncate text-muted-foreground">
          {entry.request.summary}
        </Mono>
      </div>
      {pending ? (
        <Button size="sm" variant="primary" onClick={() => onReviewApproval(entry.request.callId)}>
          Review
        </Button>
      ) : null}
    </div>
  );
}

function ChangeRow({
  entry,
  cwd,
  expanded,
  onToggle,
  onReviewChanges,
}: {
  entry: ChangeEntry;
  cwd: string;
  expanded: boolean;
  onToggle: (id: string) => void;
  onReviewChanges: () => void;
}): JSX.Element {
  return (
    <div className="my-1 rounded-md border border-border bg-card">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <PencilIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
        <button
          type="button"
          onClick={() => onToggle(entry.id)}
          aria-expanded={expanded}
          className="min-w-0 flex-1 truncate text-left text-[12.5px] text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {entry.paths.length} {entry.paths.length === 1 ? 'file' : 'files'} changed
        </button>
        <Button size="sm" onClick={onReviewChanges}>
          Review diff
        </Button>
      </div>
      {expanded ? (
        <ul className="border-t border-border px-2 py-1">
          {entry.paths.map((path) => (
            <li key={path} className="py-px">
              <PathText path={path} cwd={cwd} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SubagentRow({
  entry,
  onInspectSubagent,
}: {
  entry: SubagentEntry;
  onInspectSubagent: (id: string) => void;
}): JSX.Element {
  const terminal =
    entry.status === 'completed' ||
    entry.status === 'failed' ||
    entry.status === 'cancelled' ||
    entry.status === 'interrupted';
  return (
    <button
      type="button"
      onClick={() => onInspectSubagent(entry.subagentId)}
      className={cn(
        'my-0.5 flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left',
        'transition-colors duration-100 hover:bg-muted/60 active:bg-muted',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
      )}
    >
      <AgentsIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <StatusDot
        tone={
          entry.status === 'failed'
            ? 'error'
            : terminal
              ? 'done'
              : entry.status === 'waiting_approval'
                ? 'waiting'
                : 'active'
        }
      />
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
        {entry.title}
      </span>
      <Badge tone="neutral" className="shrink-0">
        {entry.role}
      </Badge>
      <Mono className="shrink-0 text-muted-foreground">{entry.status.replace('_', ' ')}</Mono>
    </button>
  );
}

function NoticeRow({ entry }: { entry: NoticeEntry }): JSX.Element {
  if (entry.tone === 'error') {
    return (
      <div className="my-1 rounded-md border border-destructive/50 bg-destructive/5 px-2 py-1.5">
        <div className="flex items-center gap-2">
          <AlertIcon className="h-3.5 w-3.5 shrink-0 text-destructive" />
          <span className="text-[12.5px] font-medium text-destructive">{entry.title}</span>
        </div>
        {entry.detail !== null ? (
          <p className="mt-1 whitespace-pre-wrap break-words pl-[22px] font-mono text-[11px] leading-relaxed text-foreground">
            {entry.detail}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 py-1 pl-[26px]">
      <Mono className="text-muted-foreground">{entry.title}</Mono>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function rowLabel(entry: TimelineEntry): string {
  switch (entry.kind) {
    case 'message':
      return 'Assistant message';
    case 'prompt':
      return 'Your message';
    case 'tools':
      return `${describeCategory(entry.category).groupLabel(entry.calls.length)}`;
    case 'approval':
      return `Approval ${entry.decision ?? 'required'}: ${entry.request.summary}`;
    case 'changes':
      return `${entry.paths.length} files changed`;
    case 'subagent':
      return `Subagent ${entry.title} ${entry.status}`;
    case 'turn':
      return `Turn ${entry.turnIndex + 1}`;
    case 'notice':
      return entry.title;
  }
}

export const TimelineRow = memo(function TimelineRow(props: TimelineRowProps): JSX.Element {
  const { entry, expanded, onToggle, store, cwd } = props;

  let body: ReactNode;
  switch (entry.kind) {
    case 'message':
      body = <MessageRow entry={entry} store={store} />;
      break;
    case 'prompt':
      body = <PromptRow entry={entry} />;
      break;
    case 'tools':
      body = <ToolGroupRow entry={entry} expanded={expanded} onToggle={onToggle} cwd={cwd} />;
      break;
    case 'approval':
      body = <ApprovalRow entry={entry} onReviewApproval={props.onReviewApproval} />;
      break;
    case 'changes':
      body = (
        <ChangeRow
          entry={entry}
          cwd={cwd}
          expanded={expanded}
          onToggle={onToggle}
          onReviewChanges={props.onReviewChanges}
        />
      );
      break;
    case 'subagent':
      body = <SubagentRow entry={entry} onInspectSubagent={props.onInspectSubagent} />;
      break;
    case 'turn':
      body = <TurnRow entry={entry} />;
      break;
    case 'notice':
      body = <NoticeRow entry={entry} />;
      break;
  }

  return (
    <article role="article" aria-label={rowLabel(entry)} className="px-3">
      {body}
    </article>
  );
});
