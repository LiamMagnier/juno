/**
 * The plan, and where the run has got to in it.
 *
 * THE RULE THIS FILE EXISTS TO KEEP: **a complex task never gets an indefinite
 * spinner.** Not one, anywhere, under any state. What a reader gets instead is
 * a determinate fraction (step 4 of 9, 62% of the cost ceiling), a named current
 * action with a running elapsed time, and — when there is genuinely nothing to
 * report — a sentence saying so. "Working…" with a rotating arc is a promise
 * that something is happening, made by a component that has no idea whether it
 * is.
 *
 * The step marker follows from that. Every state has a distinct, static glyph;
 * only the step an executor is *actually moving right now* carries motion, and
 * `derive.ts` will not report that state unless the run itself is `running` or
 * `preparing`. A step that is `active` while the run waits on an approval is
 * drawn blocked, in warning, with the reason beside it.
 */

import type { ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import type { WorkRun } from '../contract.js';
import type { DerivedCall, DerivedPlan, DerivedStep, PlanRevision } from '../lib/derive.js';
import { describeRevision } from '../lib/derive.js';
import { formatDuration, formatMicroUsd, formatTokens, spellDuration, timeAgo } from '../lib/format.js';
import {
  stepPresentationIsActive,
  stepPresentationLabel,
  stepPresentationTone,
  tierLabel,
  TONE_TEXT,
  trustLabel,
  UNREPORTED_STEP_EXPLANATION,
  WORK_QUIET_AFTER_MS,
  injectionWarning,
  isLiveStatus,
  riskPresentation,
  type Tone,
  type WorkStatus,
  type WorkStepPresentation,
} from '../lib/vocabulary.js';
import { Eyebrow, Meter, Note, Panel, SectionHeader, StatusDot } from '../components/primitives.js';
import {
  IconAlert,
  IconBan,
  IconCheck,
  IconClock,
  IconDashedCircle,
  IconShieldAlert,
  IconTool,
} from '../components/icons.js';

export function PlanPanel({
  plan,
  revision,
  run,
  status,
  currentAction,
  lastActivityAt,
  now,
}: {
  readonly plan: DerivedPlan;
  readonly revision: PlanRevision | null;
  readonly run: WorkRun | null;
  readonly status: WorkStatus | null;
  readonly currentAction: DerivedCall | null;
  readonly lastActivityAt: string | null;
  readonly now: number;
}): ReactNode {
  const live = status !== null && isLiveStatus(status);
  const revisionSummary = revision === null ? null : describeRevision(revision);

  return (
    <Panel className="p-4">
      <SectionHeader
        title="Plan"
        trailing={
          plan.empty ? null : (
            <span className="font-mono text-label uppercase text-muted-foreground">
              v{plan.version} · {plan.concluded + plan.failed} of {plan.total} concluded
            </span>
          )
        }
      />

      {plan.empty ? (
        <p className="max-w-prose text-caption text-muted-foreground">
          {live
            ? 'Juno has not written a plan for this yet. One appears here as soon as it has decided how to approach the task.'
            : 'No plan was written for this attempt, so there is nothing to read back.'}
        </p>
      ) : (
        <>
          <Meter
            label="Steps concluded"
            valueLabel={`${plan.concluded + plan.failed} / ${plan.total}`}
            fraction={plan.total === 0 ? 0 : (plan.concluded + plan.failed) / plan.total}
            tone={plan.failed > 0 ? 'notice' : 'positive'}
          />

          {revision === null || revisionSummary === null ? null : (
            <Note tone="quiet" className="mt-3">
              Juno revised the plan to v{revision.toVersion} {timeAgo(revision.at, now)} —{' '}
              {revisionSummary}.
            </Note>
          )}

          <ol className="mt-3 flex flex-col">
            {plan.steps.map((step) => (
              <StepRow
                key={step.id}
                step={step}
                total={plan.total}
                currentAction={step.presentation === 'running' ? currentAction : null}
                now={now}
              />
            ))}
          </ol>
        </>
      )}

      <QuietNote status={status} lastActivityAt={lastActivityAt} now={now} />

      {run === null ? null : <Ceilings run={run} status={status} now={now} />}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Steps                                                                       */
/* -------------------------------------------------------------------------- */

function StepRow({
  step,
  total,
  currentAction,
  now,
}: {
  readonly step: DerivedStep;
  readonly total: number;
  readonly currentAction: DerivedCall | null;
  readonly now: number;
}): ReactNode {
  const tone = stepPresentationTone(step.presentation);
  const active = stepPresentationIsActive(step.presentation);
  const elapsed = stepElapsed(step, now);

  return (
    <li
      className={cn(
        'grid grid-cols-[1.25rem_1fr] gap-x-2.5 border-t border-border py-2 first:border-t-0',
        step.presentation === 'pending' ? 'opacity-70' : null,
      )}
    >
      <span className="pt-0.5">
        <StepMarker presentation={step.presentation} />
      </span>

      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <p
            className={cn(
              'min-w-0 text-body',
              step.presentation === 'done' || step.presentation === 'skipped'
                ? 'text-muted-foreground'
                : 'text-foreground',
              step.presentation === 'skipped' ? 'line-through decoration-border' : null,
            )}
          >
            <span className="mr-2 font-mono text-label text-muted-foreground">
              {step.position}/{total}
            </span>
            {step.title}
          </p>
          <span className={cn('font-mono text-label uppercase', TONE_TEXT[tone])}>
            {stepPresentationLabel(step.presentation)}
            {elapsed === null ? '' : ` · ${formatDuration(elapsed)}`}
          </span>
        </div>

        {step.reason === null ? null : (
          <p className={cn('mt-0.5 text-caption', TONE_TEXT[tone])}>{step.reason}</p>
        )}

        {step.presentation === 'unreported' ? (
          <p className="mt-0.5 text-caption text-muted-foreground">
            {UNREPORTED_STEP_EXPLANATION}
          </p>
        ) : null}

        {active && currentAction !== null ? (
          <CurrentAction call={currentAction} now={now} />
        ) : null}

        {active && currentAction === null ? (
          <p className="mt-1 text-caption text-muted-foreground">
            Working on this step. Nothing has been recorded since it started
            {step.startedAt === null ? '' : ` ${timeAgo(step.startedAt, now)}`}.
          </p>
        ) : null}
      </div>
    </li>
  );
}

const MARKER_CLASS = 'size-4';

function StepMarker({ presentation }: { readonly presentation: WorkStepPresentation }): ReactNode {
  const tone: Tone = stepPresentationTone(presentation);
  switch (presentation) {
    case 'done':
      return <IconCheck className={cn(MARKER_CLASS, 'text-success')} />;
    case 'failed':
      return <IconAlert className={cn(MARKER_CLASS, 'text-destructive')} />;
    case 'skipped':
      return (
        <span aria-hidden="true" className="mt-1.5 block h-px w-4 bg-muted-foreground/60" />
      );
    case 'unreported':
      return <IconDashedCircle className={cn(MARKER_CLASS, 'text-warning')} />;
    case 'awaiting_approval':
      return <IconShieldAlert className={cn(MARKER_CLASS, 'text-warning')} />;
    case 'awaiting_input':
      return <IconAlert className={cn(MARKER_CLASS, 'text-warning')} />;
    case 'blocked':
      return <IconClock className={cn(MARKER_CLASS, 'text-muted-foreground')} />;
    case 'running':
      /* The one place motion is permitted, and the one place coral is used as a
         state: an executor is moving this step right now. */
      return (
        <span className="mt-1 flex justify-center">
          <span aria-hidden="true" className="block size-2 rounded-full bg-primary animate-status-glow" />
        </span>
      );
    default:
      return (
        <span className="mt-1 flex justify-center">
          <StatusDot tone={tone} />
        </span>
      );
  }
}

function stepElapsed(step: DerivedStep, now: number): number | null {
  if (step.startedAt === null) return null;
  const started = Date.parse(step.startedAt);
  if (Number.isNaN(started)) return null;
  if (step.finishedAt !== null) {
    const finished = Date.parse(step.finishedAt);
    if (!Number.isNaN(finished)) return Math.max(0, finished - started);
  }
  if (step.presentation === 'running') return Math.max(0, now - started);
  return null;
}

/* -------------------------------------------------------------------------- */
/* The current action                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What Juno is doing this second — named, timed and sourced.
 *
 * This block is the replacement for the spinner. It is allowed to say "now"
 * because the step above it is only in the `running` presentation when the run
 * itself is live, and the freshness strip at the top of the surface says how old
 * "now" actually is.
 */
function CurrentAction({ call, now }: { readonly call: DerivedCall; readonly now: number }): ReactNode {
  const started = Date.parse(call.startedAt);
  const elapsed = Number.isNaN(started) ? null : Math.max(0, now - started);
  const risk = riskPresentation(call.risk);
  const injection = call.injectionSeverity === null ? null : injectionWarning(call.injectionSeverity);

  return (
    <div className="mt-1.5 rounded-menu border border-border bg-muted/50 px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <IconTool className="size-3.5 text-muted-foreground" />
        <span className="text-caption text-foreground">{call.summary}</span>
        {elapsed === null ? null : (
          <span className="font-mono text-label text-muted-foreground">{formatDuration(elapsed)}</span>
        )}
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-label uppercase text-muted-foreground">
        <span>{tierLabel(call.tier)}</span>
        <span>{call.intent}</span>
        <span className={TONE_TEXT[risk.tone]}>{risk.label}</span>
        <span>{call.source}</span>
      </div>
      <p className="mt-0.5 text-caption text-muted-foreground">{trustLabel(call.trust)}</p>
      {injection === null ? null : (
        <Note tone="notice" icon={<IconShieldAlert className="size-3.5" />} className="mt-1">
          {injection}
        </Note>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Quiet runs and ceilings                                                     */
/* -------------------------------------------------------------------------- */

/**
 * An observation, never a diagnosis.
 *
 * Nothing here knows whether a quiet run is stuck or is reading a very large
 * spreadsheet. "Nothing new has been recorded for 14 minutes" is true either
 * way, and it is the sentence a reader can act on — the controls to pause or
 * cancel are one panel away.
 */
function QuietNote({
  status,
  lastActivityAt,
  now,
}: {
  readonly status: WorkStatus | null;
  readonly lastActivityAt: string | null;
  readonly now: number;
}): ReactNode {
  if (status !== 'running' && status !== 'preparing') return null;
  if (lastActivityAt === null) return null;
  const last = Date.parse(lastActivityAt);
  if (Number.isNaN(last)) return null;
  const quietFor = now - last;
  if (quietFor < WORK_QUIET_AFTER_MS) return null;
  return (
    <Note tone="notice" icon={<IconClock className="size-3.5" />} className="mt-3">
      Nothing new has been recorded for {spellDuration(quietFor)}. The run has not reported
      finishing or failing, so it is still counted as live.
    </Note>
  );
}

/**
 * The three ceilings, as fractions rather than as trivia.
 *
 * A zero ceiling means "no explicit limit" in the budget contract, and a bar for
 * a limit that does not exist is a bar that is always empty and always
 * meaningless — so those are printed as a bare figure instead.
 */
function Ceilings({
  run,
  status,
  now,
}: {
  readonly run: WorkRun;
  readonly status: WorkStatus | null;
  readonly now: number;
}): ReactNode {
  /* The runtime clock suspends while the run waits on a person, so a live
     elapsed is only honest while it is actually executing. */
  const executing = status === 'running' || status === 'preparing';
  const startedAt = run.startedAt === null ? null : Date.parse(run.startedAt);
  const liveRuntime =
    executing && startedAt !== null && !Number.isNaN(startedAt)
      ? Math.max(run.usage.runtimeMs, now - startedAt)
      : run.usage.runtimeMs;

  return (
    <div className="mt-4 border-t border-border pt-3">
      <Eyebrow>Stops at</Eyebrow>
      <div className="mt-1.5 grid gap-3 sm:grid-cols-3">
        <CeilingMeter
          label="Cost"
          used={run.usage.costMicroUsd}
          limit={run.budget.maxCostMicroUsd}
          render={formatMicroUsd}
        />
        <CeilingMeter
          label="Tokens"
          used={run.usage.tokens}
          limit={run.budget.maxTokens}
          render={formatTokens}
        />
        <CeilingMeter
          label="Running time"
          used={liveRuntime}
          limit={run.budget.maxRuntimeMs}
          render={formatDuration}
        />
      </div>
      <p className="mt-2 text-caption text-muted-foreground">
        Whichever is reached first stops the run and reports where it got to. Time spent waiting for
        you does not count against the clock.
      </p>
    </div>
  );
}

function CeilingMeter({
  label,
  used,
  limit,
  render,
}: {
  readonly label: string;
  readonly used: number;
  readonly limit: number;
  readonly render: (value: number) => string;
}): ReactNode {
  if (limit <= 0) {
    return (
      <div>
        <Eyebrow>{label}</Eyebrow>
        <p className="mt-1 font-mono text-label text-foreground">{render(used)}</p>
        <p className="text-caption text-muted-foreground">No explicit ceiling</p>
      </div>
    );
  }
  return (
    <Meter
      label={label}
      valueLabel={`${render(used)} / ${render(limit)}`}
      fraction={used / limit}
    />
  );
}

/** Exported for the results panel, which lists refused calls the same way. */
export function CallStateIcon({ call }: { readonly call: DerivedCall }): ReactNode {
  switch (call.state) {
    case 'done':
      return <IconCheck className="size-3.5 text-success" />;
    case 'failed':
      return <IconAlert className="size-3.5 text-destructive" />;
    case 'refused':
      return <IconBan className="size-3.5 text-warning" />;
    case 'unreported':
      return <IconDashedCircle className="size-3.5 text-warning" />;
    default:
      return <IconTool className="size-3.5 text-muted-foreground" />;
  }
}
