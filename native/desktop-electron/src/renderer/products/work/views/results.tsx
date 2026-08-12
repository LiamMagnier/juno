/**
 * What the run produced, and the record of how it got there.
 *
 * The section that matters most here is the smallest: `judged`. A run passes
 * `structuralValidation` by having concluded every step, explained every skip
 * and produced *something* — it is checked against the record of the run, not
 * against the goal. A validator that did compare the deliverable to the goal
 * sets `judged`, and only then may this surface say the result answers what was
 * asked. Everywhere else it says exactly what was checked. Claiming more would
 * be worse than claiming nothing, because a user who believes the work was
 * judged stops reading it.
 *
 * The audit trail is built from two sources on purpose. `WorkActionRecord` says
 * what the run touched; `WorkAuditEvent` says what security-relevant thing
 * happened. A trail with only the first omits every refusal; a trail with only
 * the second lets a run read forty files and report nothing.
 */

import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import type {
  WorkApproval,
  WorkArtifactRef,
  WorkAuditEntry,
  WorkCitation,
  WorkDecisionRecord,
  WorkRun,
  WorkValidationResult,
} from '../contract.js';
import type { AuditRow, DerivedCall, DerivedDegradation, DerivedOutputs } from '../lib/derive.js';
import {
  elapsedBetween,
  formatBytes,
  formatDuration,
  formatInstant,
  formatMicroUsd,
  formatTokens,
  plural,
  prose,
  safeHttpUrl,
} from '../lib/format.js';
import {
  actorLabel,
  approvalDecisionLabel,
  approvalDecisionTone,
  artifactExtension,
  artifactKindLabel,
  auditKindLabel,
  auditSeverityTone,
  degradationCopy,
  sourceKindLabel,
  statusLabel,
  UNREPORTED_CALL_EXPLANATION,
  statusTone,
  terminalReasonCopy,
  TONE_TEXT,
  trustLabel,
} from '../lib/vocabulary.js';
import {
  Action,
  Disclosure,
  Divider,
  Eyebrow,
  Fact,
  Note,
  Panel,
  SectionHeader,
  StatusLabel,
} from '../components/primitives.js';
import {
  IconAlert,
  IconBan,
  IconCheck,
  IconExternal,
  IconFile,
  IconShieldCheck,
} from '../components/icons.js';
/* One-way: the plan owns the call-state glyph because that is where a call's
   state is first drawn, and the results panel reuses it so a refused call looks
   the same in both places. `plan.tsx` imports nothing from here. */
import { CallStateIcon } from './plan.js';

export function ResultsPanel({
  run,
  outputs,
  calls,
  approvals,
  validation,
  decisions,
  uncertainties,
  degradations,
  auditRows,
  auditEntries,
  auditLoading,
  auditError,
  onOpenAudit,
  onOpenArtifact,
}: {
  readonly run: WorkRun | null;
  readonly outputs: DerivedOutputs;
  readonly calls: readonly DerivedCall[];
  readonly approvals: readonly WorkApproval[];
  readonly validation: WorkValidationResult | null;
  readonly decisions: readonly WorkDecisionRecord[];
  readonly uncertainties: readonly string[];
  readonly degradations: readonly DerivedDegradation[];
  readonly auditRows: readonly AuditRow[];
  readonly auditEntries: readonly WorkAuditEntry[] | null;
  readonly auditLoading: boolean;
  readonly auditError: string | null;
  readonly onOpenAudit: () => void;
  readonly onOpenArtifact: (artifactId: string, version: number, reveal: boolean) => void;
}): ReactNode {
  const hasOutputs =
    outputs.artifacts.length > 0 || outputs.changedFileCount > 0 || outputs.answer !== null;

  return (
    <Panel className="p-4">
      <SectionHeader title="Result" />

      {run === null ? (
        <p className="text-caption text-muted-foreground">
          This task has never been dispatched, so there is nothing to report.
        </p>
      ) : (
        <Outcome run={run} />
      )}

      {degradations.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1">
          <Eyebrow tone="notice">Ran with less than you asked for</Eyebrow>
          {degradations.map((degradation) => (
            <Note key={`${degradation.kind}-${degradation.at}`} tone="notice">
              {degradationCopy(degradation.kind)}
              {degradation.detail.trim().length === 0 ? '' : ` ${degradation.detail}`}
            </Note>
          ))}
        </div>
      ) : null}

      {outputs.answer === null ? null : (
        <div className="mt-4">
          <Eyebrow>What Juno said</Eyebrow>
          <p className="mt-1 max-w-prose whitespace-pre-wrap text-body text-foreground">
            {outputs.answer}
          </p>
        </div>
      )}

      <Verification validation={validation} />

      {hasOutputs ? (
        <Outputs outputs={outputs} onOpenArtifact={onOpenArtifact} />
      ) : (
        <p className="mt-4 text-caption text-muted-foreground">
          Nothing was produced or changed on this attempt.
        </p>
      )}

      <Troubles calls={calls} />
      <Sources citations={outputs.citations} />
      <Decisions decisions={decisions} uncertainties={uncertainties} />

      <div className="mt-4 border-t border-border pt-3">
        <Disclosure summary="Audit trail — everything this task did" onOpen={onOpenAudit}>
          <AuditTrail
            rows={auditRows}
            approvals={approvals}
            entries={auditEntries}
            loading={auditLoading}
            error={auditError}
          />
        </Disclosure>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Outcome                                                                     */
/* -------------------------------------------------------------------------- */

function Outcome({ run }: { readonly run: WorkRun }): ReactNode {
  const duration = elapsedBetween(run.startedAt, run.endedAt);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StatusLabel tone={statusTone(run.status)} label={statusLabel(run.status)} />
        <span className="font-mono text-label uppercase text-muted-foreground">
          attempt {run.attempt} · {run.target === 'local' ? 'this Mac' : 'Juno cloud'} · {run.model}
        </span>
      </div>
      {run.terminalReason === null ? null : (
        <p className="mt-1 max-w-prose text-caption text-muted-foreground">
          {terminalReasonCopy(run.terminalReason)}
          {run.terminalDetail === null || run.terminalDetail.trim().length === 0
            ? ''
            : ` ${run.terminalDetail}`}
        </p>
      )}
      <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-0.5 font-mono text-label uppercase text-muted-foreground">
        <span>
          <dt className="inline">Took</dt>{' '}
          <dd className="inline text-foreground">
            {duration === null ? 'not recorded' : formatDuration(duration)}
          </dd>
        </span>
        <span>
          <dt className="inline">Cost</dt>{' '}
          <dd className="inline text-foreground">{formatMicroUsd(run.usage.costMicroUsd)}</dd>
        </span>
        <span>
          <dt className="inline">Tokens</dt>{' '}
          <dd className="inline text-foreground">{formatTokens(run.usage.tokens)}</dd>
        </span>
      </dl>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Verification                                                                */
/* -------------------------------------------------------------------------- */

function Verification({ validation }: { readonly validation: WorkValidationResult | null }): ReactNode {
  if (validation === null) return null;
  const judged = validation.judged === true;

  return (
    <div className="mt-4">
      <Eyebrow>Checks</Eyebrow>
      <p className="mt-1 max-w-prose text-caption text-muted-foreground">
        {judged
          ? 'These checks compared the result against the goal.'
          : 'These are checks on the record of the run — that every step reached a conclusion, that ' +
            'anything skipped says why, and that something was actually produced. Nothing here has ' +
            'judged whether the result is any good.'}
      </p>

      <ul className="mt-2 flex flex-col gap-1">
        {validation.checks.map((check) => (
          <li key={check.claim} className="flex gap-2">
            {check.satisfied ? (
              <IconCheck className="mt-0.5 size-3.5 shrink-0 text-success" />
            ) : (
              <IconAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />
            )}
            <span className="min-w-0">
              <span className={cn('text-caption', check.satisfied ? 'text-foreground' : 'text-destructive')}>
                {check.claim}
              </span>
              <span className="block text-caption text-muted-foreground">{check.evidence}</span>
            </span>
          </li>
        ))}
      </ul>

      {validation.unmet.length > 0 ? (
        <Note tone="danger" className="mt-2">
          Not established: {validation.unmet.join('; ')}.
        </Note>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Outputs                                                                     */
/* -------------------------------------------------------------------------- */

function Outputs({
  outputs,
  onOpenArtifact,
}: {
  readonly outputs: DerivedOutputs;
  readonly onOpenArtifact: (artifactId: string, version: number, reveal: boolean) => void;
}): ReactNode {
  return (
    <div className="mt-4">
      <Eyebrow>Produced</Eyebrow>

      {outputs.artifacts.length === 0 ? null : (
        <ul className="mt-1.5 flex flex-col">
          {outputs.artifacts.map((artifact) => (
            <ArtifactRow key={artifact.id} artifact={artifact} onOpen={onOpenArtifact} />
          ))}
        </ul>
      )}

      {outputs.changedFileCount === 0 ? null : (
        <div className="mt-2">
          <p className="text-caption text-foreground">
            {plural(outputs.changedFileCount, 'file')} changed
          </p>
          {outputs.changedFiles.length > 0 ? (
            <ul className="mt-1 flex flex-col gap-0.5">
              {outputs.changedFiles.map((file, index) => {
                const label = prose(file);
                if (label === null) return null;
                return (
                  // eslint-disable-next-line react/no-array-index-key -- the same file may legitimately appear twice; order is its identity
                  <li key={`${file}-${index}`} className="font-mono text-label text-muted-foreground">
                    {label}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-caption text-muted-foreground">
              The executor did not record display names for these, so they are counted rather than
              listed.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ArtifactRow({
  artifact,
  onOpen,
}: {
  readonly artifact: WorkArtifactRef;
  readonly onOpen: (artifactId: string, version: number, reveal: boolean) => void;
}): ReactNode {
  return (
    <li className="flex items-center gap-2.5 border-t border-border py-2 first:border-t-0">
      <IconFile className="size-4 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-body text-foreground">{artifact.title}</span>
        <span className="font-mono text-label uppercase text-muted-foreground">
          {artifactKindLabel(artifact.kind)} · .{artifactExtension(artifact.kind)} · v
          {artifact.version} · {formatBytes(artifact.byteSize)}
        </span>
      </span>
      <Action
        size="sm"
        onClick={() => {
          onOpen(artifact.id, artifact.version, false);
        }}
      >
        Open
      </Action>
      <Action
        size="sm"
        variant="quiet"
        onClick={() => {
          onOpen(artifact.id, artifact.version, true);
        }}
      >
        Show in Finder
      </Action>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* What did not go to plan                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The calls that failed, were refused, or never came back.
 *
 * Separated from the audit trail because they are the part somebody reads
 * *first* when a result looks thin. `unreported` is the one that has to be here:
 * a call that was started and never closed is not a failure and not a success,
 * and a surface that quietly folded it into either would be inventing the one
 * fact the log does not contain.
 */
function Troubles({ calls }: { readonly calls: readonly DerivedCall[] }): ReactNode {
  const troubled = calls.filter(
    (call) => call.state === 'failed' || call.state === 'refused' || call.state === 'unreported',
  );
  if (troubled.length === 0) return null;

  return (
    <div className="mt-4">
      <Eyebrow tone="notice">Did not go to plan</Eyebrow>
      <ul className="mt-1.5 flex flex-col">
        {troubled.map((call) => (
          <li key={call.callId} className="flex gap-2 border-t border-border py-1.5 first:border-t-0">
            <span className="mt-0.5">
              <CallStateIcon call={call} />
            </span>
            <span className="min-w-0">
              <span className="block text-caption text-foreground">{call.summary}</span>
              <span className="block text-caption text-muted-foreground">
                {call.state === 'unreported'
                  ? UNREPORTED_CALL_EXPLANATION
                  : call.state === 'refused'
                    ? `Refused. ${call.failureReason ?? 'No reason was recorded.'}`
                    : 'The tool reported an error.'}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sources and decisions                                                       */
/* -------------------------------------------------------------------------- */

function Sources({ citations }: { readonly citations: readonly WorkCitation[] }): ReactNode {
  if (citations.length === 0) return null;
  return (
    <div className="mt-4">
      <Eyebrow>Sources</Eyebrow>
      <ul className="mt-1.5 flex flex-col gap-2">
        {citations.map((citation, index) => (
          // eslint-disable-next-line react/no-array-index-key -- one source can be cited more than once; the log order is the identity
          <CitationRow key={`${citation.source}-${index}`} citation={citation} />
        ))}
      </ul>
    </div>
  );
}

function CitationRow({ citation }: { readonly citation: WorkCitation }): ReactNode {
  const href = safeHttpUrl(citation.source);
  return (
    <li>
      {href === null ? (
        <span className="text-caption text-foreground">{citation.title}</span>
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex items-center gap-1 text-caption text-source underline-offset-2 hover:underline"
        >
          {citation.title}
          <IconExternal className="size-3" />
        </a>
      )}
      <span className="ml-2 font-mono text-label uppercase text-muted-foreground">
        {formatInstant(citation.retrievedAt)}
      </span>
      {citation.quote === undefined ? null : (
        <p className="mt-0.5 line-clamp-2 border-l-2 border-border pl-2 text-caption text-muted-foreground">
          {citation.quote}
        </p>
      )}
    </li>
  );
}

function Decisions({
  decisions,
  uncertainties,
}: {
  readonly decisions: readonly WorkDecisionRecord[];
  readonly uncertainties: readonly string[];
}): ReactNode {
  if (decisions.length === 0 && uncertainties.length === 0) return null;
  return (
    <div className="mt-4">
      {decisions.length > 0 ? (
        <>
          <Eyebrow>Choices Juno made</Eyebrow>
          <ul className="mt-1.5 flex flex-col gap-2">
            {decisions.map((decision, index) => (
                // eslint-disable-next-line react/no-array-index-key -- decisions are an append-only list with no id; position is the identity
              <li key={`${decision.summary}-${index}`}>
                <p className="text-caption text-foreground">{decision.summary}</p>
                <p className="text-caption text-muted-foreground">Because: {decision.because}</p>
                {decision.alternatives === undefined || decision.alternatives.length === 0 ? null : (
                  <p className="text-caption text-muted-foreground">
                    Instead of: {decision.alternatives.join('; ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {/*
       * An empty uncertainty list is itself a claim, so it is printed rather
       * than omitted: "nothing was left unresolved" is a much stronger statement
       * than a missing section, and the reader is entitled to see which one the
       * run actually made.
       */}
      <div className="mt-3">
        <Eyebrow>Left unresolved</Eyebrow>
        {uncertainties.length === 0 ? (
          <p className="mt-1 text-caption text-muted-foreground">
            The run recorded nothing it was unsure of.
          </p>
        ) : (
          <ul className="mt-1 list-inside list-disc">
            {uncertainties.map((item) => (
              <li key={item} className="text-caption text-muted-foreground">
                {item}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Audit trail                                                                 */
/* -------------------------------------------------------------------------- */

const AUTHORITY_COPY: Record<NonNullable<AuditRow['authority']>, string> = {
  approved_once: 'You allowed it once',
  approved_standing: 'You allowed it, standing',
  denied: 'You refused it',
  policy: 'Permitted by the task’s permission mode',
};

function AuditTrail({
  rows,
  approvals,
  entries,
  loading,
  error,
}: {
  readonly rows: readonly AuditRow[];
  readonly approvals: readonly WorkApproval[];
  readonly entries: readonly WorkAuditEntry[] | null;
  readonly loading: boolean;
  readonly error: string | null;
}): ReactNode {
  return (
    <div className="flex flex-col gap-4">
      {/*
       * Every request for permission and what became of it — including the ones
       * that expired unanswered, which are the interesting ones. An approval
       * that timed out is a place the run stopped rather than acted, and it is
       * dropped from the *decision* surface precisely so it cannot be answered
       * late; dropping it from the record as well would erase the moment Juno
       * asked and nobody was there.
       */}
      {approvals.length === 0 ? null : (
        <div>
          <Eyebrow>Permissions asked for</Eyebrow>
          <ul className="mt-1.5 flex flex-col">
            {approvals.map((approval) => (
              <li
                key={approval.id}
                className="flex flex-wrap items-baseline justify-between gap-x-3 border-t border-border py-1.5 first:border-t-0"
              >
                <span className="min-w-0 text-caption text-foreground">{approval.summary}</span>
                <StatusLabel
                  tone={approvalDecisionTone(approval.decision)}
                  label={approvalDecisionLabel(approval.decision)}
                />
              </li>
            ))}
          </ul>
        </div>
      )}

      <div>
        <Eyebrow>What was done</Eyebrow>
        {rows.length === 0 ? (
          <p className="mt-1 text-caption text-muted-foreground">
            The run recorded no actions on anything outside itself.
          </p>
        ) : (
          <ul className="mt-1.5 flex flex-col">
            {rows.map((row) => (
              <li key={row.key} className="border-t border-border py-2 first:border-t-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="inline-flex items-center gap-1.5">
                    {row.isError ? (
                      <IconAlert className="size-3.5 text-destructive" />
                    ) : row.authority === 'denied' ? (
                      <IconBan className="size-3.5 text-warning" />
                    ) : row.authority === null ? (
                      <IconCheck className="size-3.5 text-muted-foreground" />
                    ) : (
                      <IconShieldCheck className="size-3.5 text-success" />
                    )}
                    <span className="text-caption text-foreground">{row.what}</span>
                  </span>
                  <span className="font-mono text-label uppercase text-muted-foreground">
                    {formatInstant(row.at)}
                  </span>
                </div>
                <dl className="ml-5">
                  <Fact label="Tool" mono>
                    {row.tool}
                  </Fact>
                  <Fact label="Action" mono>
                    {row.action}
                  </Fact>
                  <Fact label="Source">
                    {sourceKindLabel(row.sourceKind)} · {row.source}
                  </Fact>
                  <Fact label="Output">{trustLabel(row.trust)}</Fact>
                  <Fact label="Permission">
                    {row.authority === null ? (
                      <span className="text-muted-foreground">
                        Not recorded — the log does not say which permission covered this.
                      </span>
                    ) : (
                      AUTHORITY_COPY[row.authority]
                    )}
                  </Fact>
                </dl>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Divider />

      <div>
        <Eyebrow>Security log</Eyebrow>
        {loading ? (
          <p className="mt-1 text-caption text-muted-foreground">Reading the security log…</p>
        ) : error !== null ? (
          <Note tone="danger" icon={<IconAlert className="size-3.5" />} className="mt-1">
            {error} The log exists on the server; this window could not read it just now.
          </Note>
        ) : entries === null ? (
          <p className="mt-1 text-caption text-muted-foreground">Not read yet.</p>
        ) : entries.length === 0 ? (
          <p className="mt-1 text-caption text-muted-foreground">
            Nothing security-relevant was recorded for this task.
          </p>
        ) : (
          <ul className="mt-1.5 flex flex-col">
            {entries.map((entry) => (
              <li key={entry.id} className="border-t border-border py-2 first:border-t-0">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className={cn('text-caption', TONE_TEXT[auditSeverityTone(entry.severity)])}>
                    {auditKindLabel(entry.kind)}
                  </span>
                  <span className="font-mono text-label uppercase text-muted-foreground">
                    {actorLabel(entry.actor)} · {formatInstant(entry.at)}
                  </span>
                </div>
                <dl className="ml-0">
                  {Object.entries(entry.detail).map(([key, value]) => (
                    <Fact key={key} label={key} mono>
                      {String(value)}
                    </Fact>
                  ))}
                </dl>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
