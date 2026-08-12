/**
 * The Work surface.
 *
 * One task at a time, arranged so that the answer to "what is happening, and
 * does it need me?" is available without scrolling and without inference:
 *
 *   1. the task and its status,
 *   2. how old that status is — because nothing here streams,
 *   3. anything Juno is waiting on the user for,
 *   4. the plan, and where the run has got to in it,
 *   5. what it produced, and the record of how,
 *
 * with the controls in a rail beside them. The order is not a layout
 * preference: a decision request placed below the plan is a decision request
 * somebody scrolls past, and a freshness label placed at the bottom is a
 * freshness label read after the reader has already believed the page.
 *
 * Everything in this component is derived once per render from the event log and
 * handed down. Nothing below it reduces events, reads the clock, or calls the
 * bridge except through the callbacks passed in.
 */

import { useMemo, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import {
  clockIntervalFor,
  useNow,
  useWorkAudit,
  useWorkCapabilities,
  useWorkTask,
} from '../lib/use-work.js';
import {
  currentCall,
  deriveAttention,
  deriveAuditRows,
  deriveControls,
  deriveDegradations,
  deriveCalls,
  deriveOutputs,
  derivePlan,
  lastActivityAt,
  latestPlanRevision,
} from '../lib/derive.js';
import { assessFreshness } from '../lib/freshness.js';
import type { WorkEmittedEvent, WorkReport, WorkValidationResult } from '../contract.js';
import {
  isEffectiveTarget,
  isTerminalStatus,
  policyPresentation,
  statusLabel,
  statusMeaning,
  statusTone,
  targetLabel,
  TONE_TEXT,
} from '../lib/vocabulary.js';
import { Eyebrow, Fact, Panel, StatusLabel } from '../components/primitives.js';
import { FreshnessBar } from './freshness-bar.js';
import { AttentionPanel } from './attention.js';
import { PlanPanel } from './plan.js';
import { ControlsPanel } from './controls.js';
import { ResultsPanel } from './results.js';
import { TaskComposer } from './composer.js';
import {
  DisconnectedState,
  FirstReadState,
  NoTasksState,
  OfflineState,
  UnreadableState,
} from './states.js';

export function WorkSurface({
  sessionId,
  onSelectTask,
  className,
}: {
  /** Null opens the composer. The shell owns which task is selected. */
  readonly sessionId: string | null;
  readonly onSelectTask: (sessionId: string | null) => void;
  readonly className?: string;
}): ReactNode {
  const task = useWorkTask(sessionId);
  const now = useNow(clockIntervalFor(task.status));
  const [auditOpened, setAuditOpened] = useState(false);
  const composing = sessionId === null;
  const capabilities = useWorkCapabilities(composing);
  const audit = useWorkAudit(sessionId, auditOpened);

  const freshness = assessFreshness(task.poll, now);

  const derived = useMemo(() => {
    const plan = derivePlan(task.events, task.status);
    const calls = deriveCalls(task.events, task.status);
    const outputs = deriveOutputs(task.events);
    const report = latestReport(task.events);
    return {
      plan,
      revision: latestPlanRevision(task.events),
      calls,
      current: currentCall(calls, task.status),
      outputs,
      degradations: deriveDegradations(task.events),
      lastActivity: lastActivityAt(task.events),
      auditRows: deriveAuditRows(task.events, report?.actions ?? []),
      report,
      validation: latestValidation(task.events),
    };
  }, [task.events, task.status]);

  const attention = useMemo(
    () => deriveAttention(task.questions, task.approvals, now),
    [task.questions, task.approvals, now],
  );

  const controls = useMemo(() => {
    if (task.session === null) return null;
    return deriveControls(task.session, task.run, { offline: !task.poll.online });
  }, [task.session, task.run, task.poll.online]);

  if (!task.bridgeAvailable) return <DisconnectedState />;

  if (composing) {
    return (
      <div className={cn('mx-auto w-full max-w-3xl p-4', className)}>
        <TaskComposer
          capabilities={capabilities.value}
          capabilitiesError={capabilities.error}
          capabilitiesLoading={capabilities.loading}
          onCreated={onSelectTask}
        />
      </div>
    );
  }

  if (task.session === null) {
    if (!task.poll.online) {
      return (
        <div className={cn('mx-auto w-full max-w-3xl p-4', className)}>
          <OfflineState
            lastReadLabel={freshness.ageMs === null ? null : freshness.ageLabel}
            onRetry={() => {
              void task.actions.refresh();
            }}
          />
        </div>
      );
    }
    if (task.loading) {
      return (
        <div className={cn('mx-auto w-full max-w-3xl p-4', className)}>
          <FirstReadState />
        </div>
      );
    }
    return (
      <div className={cn('mx-auto w-full max-w-3xl p-4', className)}>
        {task.actionError === null ? (
          <NoTasksState
            onCompose={() => {
              onSelectTask(null);
            }}
          />
        ) : (
          <UnreadableState
            detail={task.actionError}
            onRetry={() => {
              void task.actions.refresh();
            }}
          />
        )}
      </div>
    );
  }

  const { session } = task;
  const status = task.status ?? session.status;
  const terminal = isTerminalStatus(status);
  const showResults = terminal || derived.outputs.artifacts.length > 0 || derived.report !== null;

  return (
    <div className={cn('mx-auto flex w-full max-w-5xl flex-col gap-4 p-4', className)}>
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="min-w-0 text-title text-foreground">{session.title}</h1>
          <StatusLabel
            tone={statusTone(status)}
            label={statusLabel(status)}
            pulse={status === 'running'}
          />
        </div>
        <p className="max-w-prose text-caption text-muted-foreground">{statusMeaning(status)}</p>
        <p className="max-w-prose whitespace-pre-wrap text-body text-foreground">{session.goal}</p>
        <FreshnessBar
          poll={task.poll}
          now={now}
          onRefresh={() => {
            void task.actions.refresh();
          }}
        />
      </header>

      <AttentionPanel
        queue={attention}
        freshness={freshness}
        now={now}
        onAnswer={(questionId, text) => task.actions.answer(questionId, text)}
        onDecide={(approval, decision) => task.actions.resolveApproval(approval, decision)}
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <PlanPanel
            plan={derived.plan}
            revision={derived.revision}
            run={task.run}
            status={status}
            currentAction={derived.current}
            lastActivityAt={derived.lastActivity}
            now={now}
          />

          {showResults ? (
            <ResultsPanel
              run={task.run}
              outputs={derived.outputs}
              calls={derived.calls}
              approvals={task.approvals}
              validation={derived.validation}
              decisions={derived.report?.decisions ?? []}
              uncertainties={derived.report?.uncertainties ?? []}
              degradations={derived.degradations}
              auditRows={derived.auditRows}
              auditEntries={audit.value}
              auditLoading={audit.loading}
              auditError={audit.error}
              onOpenAudit={() => {
                setAuditOpened(true);
              }}
              onOpenArtifact={(artifactId, version, reveal) => {
                void task.actions.openArtifact(artifactId, version, reveal);
              }}
            />
          ) : null}
        </div>

        <aside className="flex min-w-0 flex-col gap-4">
          {controls === null ? null : (
            <ControlsPanel
              controls={controls}
              busy={task.busy}
              canSteer={controls.steer.enabled}
              onControl={(control) => {
                void task.actions.control(control);
              }}
              onRetry={() => {
                void task.actions.retry();
              }}
              onSteer={(text) => task.actions.answer(null, text)}
            />
          )}

          <Panel className="p-4" aria-label="How this task is set up">
            <Eyebrow>How it runs</Eyebrow>
            <dl className="mt-1.5">
              <Fact label="Where">
                {task.run !== null ? (
                  task.run.target === 'local' ? (
                    'This Mac'
                  ) : (
                    'Juno cloud'
                  )
                ) : isEffectiveTarget(session.target) ? (
                  targetLabel(session.target)
                ) : (
                  /* `automatic` is not a place. It resolves to one at dispatch,
                     and until then the honest answer is that nothing has been
                     decided — not a guess at what the server will pick. */
                  <span className="text-muted-foreground">Not placed yet</span>
                )}
              </Fact>
              <Fact label="Model" mono>
                {task.run?.model ?? session.model ?? 'chosen at dispatch'}
              </Fact>
              <Fact label="Asks">
                {policyPresentation(task.run?.permissionPolicy ?? session.permissionPolicy).label}
              </Fact>
              <Fact label="Attempt">{task.run === null ? '—' : `#${task.run.attempt}`}</Fact>
              <Fact label="Reaches">
                {session.grants.length === 0 && session.connectors.length === 0
                  ? 'Nothing on this Mac, no connected apps'
                  : `${session.grants.length} granted, ${session.connectors.length} app${
                      session.connectors.length === 1 ? '' : 's'
                    }`}
              </Fact>
              {session.skill === null ? null : <Fact label="Skill">{session.skill.name}</Fact>}
            </dl>
          </Panel>

          {task.actionError === null ? null : (
            <p className={cn('text-caption', TONE_TEXT.danger)} role="alert">
              {task.actionError}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}

/**
 * The report from the newest `run_finished`.
 *
 * Read from the log rather than from a field on the run, because a run that is
 * still going has no report at all and a run that was superseded has one that is
 * no longer the answer. The newest terminal event is the only honest source.
 */
function latestReport(events: readonly WorkEmittedEvent[]): WorkReport | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event !== undefined && event.kind === 'run_finished') return event.report;
  }
  return null;
}

/** The newest `validation_result`, which may exist before the run has finished. */
function latestValidation(events: readonly WorkEmittedEvent[]): WorkValidationResult | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.kind === 'validation_result') return event.result;
    if (event.kind === 'run_finished') return event.report.verification;
  }
  return null;
}
