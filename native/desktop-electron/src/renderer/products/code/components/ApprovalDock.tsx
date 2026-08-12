/**
 * Approvals.
 *
 * A permission prompt is the one moment where the UI is the security boundary,
 * so this component refuses to render the thing every agent tool ships with —
 * "Allow command? [Allow] [Deny]". A user who cannot tell what they are
 * agreeing to learns to agree to everything, and at that point the prompt is
 * worse than useless because it launders the risk.
 *
 * Every card answers five questions, in this order:
 *
 *   WHAT   the exact action, verbatim, in monospace — the command as it will
 *          run, or the path as it will be written.
 *   WHO    the requesting agent. `agentLabel` means a SUBAGENT is asking, and
 *          that is displayed prominently: "builder · Implement auth API wants
 *          to…" is a materially different decision from the root agent asking.
 *   WHY    the risk class the host assigned, in the user's terms.
 *   IMPACT what actually happens if this is allowed.
 *   SCOPE  what is being granted — and critically, how *wide* it is.
 *
 * The scope choices map onto the protocol's `ApprovalDecision` union, and the
 * copy is precise about what each one really does:
 *
 *   Once          -> 'allow'         this call only.
 *   This session  -> 'allow_always'  PermissionEngine.grantAlways() allowlists
 *                                    the TOOL NAME for the session — not this
 *                                    command. Granting `bash` once grants every
 *                                    later `bash` call. The label says so.
 *   This workspace-> (unwired)       would need a rule in the project's
 *                                    .juno/settings.json; no IPC channel writes
 *                                    that file, so the control is disabled with
 *                                    the reason visible rather than faked.
 *
 * `sensitive` is checked in `PermissionEngine.decide` *before* the mode and
 * before the allowlist, so a session grant on a sensitive action would not be
 * honoured — the host would ask again. Rather than let the UI imply otherwise,
 * "This session" is disabled for sensitive requests, with that as its reason.
 * The affirmative button never takes initial focus at that level either.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { cn } from '../lib/cn.js';
import type { ApprovalDecision, WireApprovalRequest } from '../lib/contract.js';
import { riskPresentation } from '../lib/risk.js';
import { impactOf, inputString, targetOf } from '../lib/tools.js';
import { relativeTo } from '../lib/format.js';
import { Badge, Button, FOCUS_RING, InertNote, Mono } from './primitives.js';
import { AgentsIcon, ChevronDown, ChevronRight, ShieldIcon } from './icons.js';

type Scope = 'once' | 'session' | 'workspace';

export interface ApprovalDockProps {
  requests: readonly WireApprovalRequest[];
  cwd: string;
  onResolve: (callId: string, decision: ApprovalDecision) => void;
  /** Focus target requested from the timeline's "Review" button. */
  focusCallId: string | null;
  className?: string;
}

function ActionHeadline({ request }: { request: WireApprovalRequest }): JSX.Element {
  const command = request.toolName === 'bash' ? inputString(request.input, 'command') : null;
  if (command !== null) {
    return (
      <pre className="overflow-x-auto rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[12px] leading-relaxed text-foreground">
        <span className="select-none text-muted-foreground">$ </span>
        {command}
      </pre>
    );
  }
  return (
    <pre className="overflow-x-auto rounded-md border border-border bg-background px-2.5 py-2 font-mono text-[12px] leading-relaxed text-foreground">
      {request.summary}
    </pre>
  );
}

function InputDetail({ input }: { input: unknown }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const serialized = useMemo(() => {
    try {
      return JSON.stringify(input, null, 2) ?? 'undefined';
    } catch {
      return '[input could not be serialised]';
    }
  }, [input]);

  if (serialized === 'undefined') return null;

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className={cn(
          'flex items-center gap-1 rounded px-1 py-0.5 text-[11px] text-muted-foreground',
          'transition-colors duration-100 hover:text-foreground',
          FOCUS_RING,
        )}
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        Full tool input
      </button>
      {open ? (
        <pre className="mt-1 max-h-56 overflow-auto rounded-md border border-border bg-background px-2 py-1.5 font-mono text-[11px] leading-relaxed text-foreground">
          {serialized}
        </pre>
      ) : null}
    </div>
  );
}

function ApprovalCard({
  request,
  cwd,
  onResolve,
  autoFocus,
}: {
  request: WireApprovalRequest;
  cwd: string;
  onResolve: (callId: string, decision: ApprovalDecision) => void;
  autoFocus: boolean;
}): JSX.Element {
  const risk = riskPresentation(request.risk);
  const sensitive = request.risk === 'sensitive';
  const [scope, setScope] = useState<Scope>('once');
  const allowRef = useRef<HTMLButtonElement | null>(null);
  const denyRef = useRef<HTMLButtonElement | null>(null);
  const [pending, setPending] = useState<ApprovalDecision | null>(null);

  useEffect(() => {
    if (!autoFocus) return;
    /* The destructive path is never one Return keypress away. */
    if (risk.affirmativeMayAutofocus) allowRef.current?.focus();
    else denyRef.current?.focus();
  }, [autoFocus, risk.affirmativeMayAutofocus, request.callId]);

  const target = targetOf(request.toolName, request.input);
  const impacts = impactOf(request.toolName, request.input);

  const resolve = (decision: ApprovalDecision): void => {
    setPending(decision);
    onResolve(request.callId, decision);
  };

  const scopeOptions: Array<{
    value: Scope;
    label: string;
    detail: string;
    disabled: boolean;
    reason?: string;
  }> = [
    {
      value: 'once',
      label: 'Once',
      detail: 'This call only.',
      disabled: false,
    },
    {
      value: 'session',
      label: 'This session',
      detail: `Every later ${request.toolName} call in this session, not just this one.`,
      disabled: sensitive,
      reason:
        'Destructive actions are confirmed every time. The agent host checks the ' +
        'sensitive class before any allowlist, so a session grant would not be honoured.',
    },
    {
      value: 'workspace',
      label: 'This workspace',
      detail: 'Persist as a project rule.',
      disabled: true,
      reason:
        'A workspace grant is a rule in the project’s .juno/settings.json. No IPC ' +
        'channel writes that file, so this cannot be honoured yet.',
    },
  ];

  const decisionForScope: ApprovalDecision = scope === 'session' ? 'allow_always' : 'allow';
  const resolved = pending !== null;

  return (
    <section
      aria-label={`Approval required: ${request.summary}`}
      className={cn(
        'rounded-lg border bg-card',
        sensitive ? 'border-destructive' : 'border-border',
      )}
    >
      {/* Header — WHO and WHY, before anything else. */}
      <header
        className={cn(
          'flex flex-wrap items-center gap-2 rounded-t-lg border-b px-3 py-2',
          sensitive ? 'border-destructive/60 bg-destructive/10' : 'border-border bg-muted',
        )}
      >
        <ShieldIcon
          className={cn('h-4 w-4 shrink-0', sensitive ? 'text-destructive' : 'text-primary')}
        />
        <span
          className={cn(
            'text-[13px] font-semibold',
            sensitive ? 'text-destructive' : 'text-foreground',
          )}
        >
          {sensitive ? 'Destructive action — confirm' : 'Approval required'}
        </span>
        <Badge tone={sensitive ? 'danger' : 'neutral'}>{risk.label}</Badge>
        <span className="flex-1" />
        {request.agentLabel !== undefined && request.agentLabel.length > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5">
            <AgentsIcon className="h-3 w-3 text-primary" />
            <span className="font-mono text-[10px] text-primary">{request.agentLabel}</span>
          </span>
        ) : (
          <Mono className="text-muted-foreground">root agent</Mono>
        )}
      </header>

      <div className="space-y-2.5 px-3 py-2.5">
        <ActionHeadline request={request} />

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
          <dt className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            Tool
          </dt>
          <dd className="font-mono text-[11px] text-foreground">{request.toolName}</dd>
          {target !== null ? (
            <>
              <dt className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                Target
              </dt>
              <dd className="truncate font-mono text-[11px] text-foreground" title={target}>
                {relativeTo(cwd, target)}
              </dd>
            </>
          ) : null}
          <dt className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            Why
          </dt>
          <dd className="text-muted-foreground">{risk.why}</dd>
          {impacts.length > 0 ? (
            <>
              <dt className="font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
                Impact
              </dt>
              <dd>
                <ul className="space-y-0.5 text-muted-foreground">
                  {impacts.map((impact) => (
                    <li key={impact}>{impact}</li>
                  ))}
                </ul>
              </dd>
            </>
          ) : null}
        </dl>

        <InputDetail input={request.input} />

        {/* SCOPE */}
        <fieldset className="rounded-md border border-border bg-background px-2.5 py-2">
          <legend className="px-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            Grant
          </legend>
          <div className="space-y-1">
            {scopeOptions.map((option) => (
              <label
                key={option.value}
                className={cn(
                  'flex cursor-pointer items-start gap-2 rounded px-1 py-0.5',
                  'hover:bg-muted',
                  option.disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
                )}
              >
                <input
                  type="radio"
                  name={`scope-${request.callId}`}
                  value={option.value}
                  checked={scope === option.value}
                  disabled={option.disabled || resolved}
                  onChange={() => setScope(option.value)}
                  className={cn('mt-[3px] h-3 w-3 accent-primary', FOCUS_RING)}
                />
                <span className="min-w-0">
                  <span className="block text-[12px] text-foreground">{option.label}</span>
                  <span className="block text-[11px] leading-snug text-muted-foreground">
                    {option.detail}
                  </span>
                  {option.disabled && option.reason !== undefined ? (
                    <InertNote>{option.reason}</InertNote>
                  ) : null}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <footer className="flex items-center gap-2 border-t border-border px-3 py-2">
        <Button
          ref={denyRef}
          variant={sensitive ? 'primary' : 'secondary'}
          onClick={() => resolve('deny')}
          disabled={resolved}
          disabledReason={resolved ? 'Already answered.' : undefined}
        >
          Deny
        </Button>
        <Button
          ref={allowRef}
          variant={sensitive ? 'danger' : 'primary'}
          onClick={() => resolve(decisionForScope)}
          disabled={resolved}
          disabledReason={resolved ? 'Already answered.' : undefined}
        >
          {sensitive
            ? 'Run it anyway'
            : scope === 'session'
              ? `Allow ${request.toolName} for this session`
              : 'Allow once'}
        </Button>
        <span className="flex-1" />
        {resolved ? (
          <Mono className="text-muted-foreground">sent · {pending}</Mono>
        ) : (
          <Mono className="text-muted-foreground">{request.callId.slice(0, 8)}</Mono>
        )}
      </footer>
    </section>
  );
}

export function ApprovalDock({
  requests,
  cwd,
  onResolve,
  focusCallId,
  className,
}: ApprovalDockProps): JSX.Element | null {
  const first = requests[0];
  const announcement = useMemo(() => {
    if (!first) return '';
    const who = first.agentLabel !== undefined ? `Subagent ${first.agentLabel}` : 'The agent';
    const level = first.risk === 'sensitive' ? 'A destructive action' : 'An action';
    return `${level} needs your approval. ${who} wants to run: ${first.summary}.${
      requests.length > 1 ? ` ${requests.length - 1} more approvals are waiting.` : ''
    }`;
  }, [first, requests.length]);

  if (!first) return null;

  const ordered = focusCallId
    ? [
        ...requests.filter((request) => request.callId === focusCallId),
        ...requests.filter((request) => request.callId !== focusCallId),
      ]
    : requests;
  const head = ordered[0] ?? first;
  const rest = ordered.slice(1);

  return (
    <div
      className={cn('border-t border-border bg-background px-3 py-2.5', className)}
      role="group"
      aria-label="Pending approvals"
    >
      {/* The announcement a screen-reader user needs: assertive, because the
          agent is blocked until this is answered. */}
      <div aria-live="assertive" aria-atomic="true" className="sr-only">
        {announcement}
      </div>

      <ApprovalCard request={head} cwd={cwd} onResolve={onResolve} autoFocus />

      {rest.length > 0 ? (
        <div className="mt-2">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {rest.length} more waiting
          </p>
          <ul className="space-y-1">
            {rest.map((request) => (
              <li key={request.callId}>
                <ApprovalCard
                  request={request}
                  cwd={cwd}
                  onResolve={onResolve}
                  autoFocus={false}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
