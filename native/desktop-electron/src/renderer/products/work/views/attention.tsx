/**
 * Where Juno stops and asks.
 *
 * This is the defining interaction of Work, and the one the rest of the surface
 * is arranged around. A run that stops to ask is doing the right thing; a run
 * that guesses is not. Everything here is built so that stopping is cheap for
 * the user to resolve and impossible to miss:
 *
 *   · **It is announced, assertively, once.** "Juno needs your input" is the one
 *     thing on this surface that interrupts. A user who has tabbed away from a
 *     twenty-minute task and is waited on has to be told; a polite region that
 *     waits for a gap in speech is not good enough for a state that blocks all
 *     progress.
 *   · **Every choice says what it does.** A question shows *why* Juno cannot
 *     continue without it. An approval shows the exact action, the exact detail
 *     the digest was computed over, and the consequence of each button.
 *   · **The refusing button comes first, and nothing steals focus.** "Don't do
 *     it" is the leftmost control on an approval, and at `sensitive` or
 *     `irreversible` the affirmative loses its emphasis colour so the eye is not
 *     led to it. No card autofocuses: an approval can arrive while somebody is
 *     midway through typing an answer to a different question.
 *   · **Nothing is offered that cannot work.** An approval with no usable digest
 *     gets a sentence instead of two buttons the server is guaranteed to refuse,
 *     and an expired one is dropped upstream in `deriveAttention`.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { WorkApproval, WorkQuestion } from '../contract.js';
import { cn } from '../lib/cn.js';
import { formatDuration, parseInstant } from '../lib/format.js';
import type { FreshnessVerdict } from '../lib/freshness.js';
import { stalenessCaveat } from '../lib/freshness.js';
import {
  APPROVAL_UNANSWERABLE_REASON,
  approvalIsAnswerable,
  type AttentionQueue,
} from '../lib/derive.js';
import {
  isAlwaysConfirmed,
  riskPresentation,
  TONE_TEXT,
  type WorkApprovalAnswer,
} from '../lib/vocabulary.js';
import { Action, Eyebrow, Fact, Note, Panel, StatusLabel } from '../components/primitives.js';
import { IconAlert, IconBan, IconShieldAlert } from '../components/icons.js';

type Feedback = { readonly tone: 'notice' | 'danger'; readonly message: string } | null;

export function AttentionPanel({
  queue,
  freshness,
  now,
  onAnswer,
  onDecide,
}: {
  readonly queue: AttentionQueue;
  readonly freshness: FreshnessVerdict;
  readonly now: number;
  readonly onAnswer: (
    questionId: string,
    text: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  readonly onDecide: (
    approval: WorkApproval,
    decision: WorkApprovalAnswer,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
}): ReactNode {
  const announcement = useAssertiveAnnouncement(queue.announcement);

  if (queue.total === 0) return null;

  return (
    <section aria-labelledby="work-attention-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 id="work-attention-heading" className="text-heading text-warning">
          Juno needs you
        </h2>
        <span className="font-mono text-label uppercase text-muted-foreground">
          {queue.total === 1 ? '1 open' : `${queue.total} open`}
        </span>
      </div>
      <p className="text-caption text-muted-foreground">
        Nothing else happens on this task until these are answered.
        {queue.questions.length > 1
          ? ' Two questions can be open at once — answering one does not close the other.'
          : ''}
      </p>

      {queue.questions.map((question) => (
        <QuestionCard
          key={question.id}
          question={question}
          freshness={freshness}
          onAnswer={onAnswer}
        />
      ))}

      {queue.approvals.map((approval) => (
        <ApprovalCard
          key={approval.id}
          approval={approval}
          freshness={freshness}
          now={now}
          onDecide={onDecide}
        />
      ))}

      <span role="alert" aria-live="assertive" className="sr-only">
        {announcement}
      </span>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Questions                                                                   */
/* -------------------------------------------------------------------------- */

function QuestionCard({
  question,
  freshness,
  onAnswer,
}: {
  readonly question: WorkQuestion;
  readonly freshness: FreshnessVerdict;
  readonly onAnswer: (
    questionId: string,
    text: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
}): ReactNode {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const caveat = stalenessCaveat(freshness);

  const send = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed.length === 0 || sending) return;
    setSending(true);
    setFeedback(null);
    const result = await onAnswer(question.id, trimmed);
    setSending(false);
    if (result.ok) setDraft('');
    else setFeedback({ tone: 'danger', message: result.message });
  };

  return (
    <Panel tone="notice" className="p-4">
      <Eyebrow tone="notice">Juno stopped to ask</Eyebrow>
      <h3 className="mt-1.5 text-body-lg text-foreground">{question.question}</h3>

      <p className="mt-2 max-w-prose text-caption text-muted-foreground">
        <span className="font-mono text-label uppercase">Why it matters:</span> {question.why}
      </p>

      {question.options !== undefined && question.options.length > 0 ? (
        <div className="mt-3">
          <Eyebrow>Answers Juno offered</Eyebrow>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {question.options.map((option) => (
              <Action
                key={option}
                size="sm"
                onClick={() => {
                  void send(option);
                }}
                busy={sending}
                aria-label={`Answer “${option}” to: ${question.question}`}
              >
                {option}
              </Action>
            ))}
          </div>
          <p className="mt-1.5 text-caption text-muted-foreground">
            Picking one answers the question and the run continues from its next step. What it has
            already done stands.
          </p>
        </div>
      ) : null}

      <form
        className="mt-3 flex items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <label className="sr-only" htmlFor={`work-answer-${question.id}`}>
          {`Answer: ${question.question}`}
        </label>
        <input
          id={`work-answer-${question.id}`}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          placeholder={
            question.options === undefined || question.options.length === 0
              ? 'Type your answer'
              : 'Or answer in your own words'
          }
          className="h-9 min-w-0 flex-1 rounded-field border border-input bg-background px-2.5 text-body text-foreground placeholder:text-muted-foreground"
        />
        <Action
          type="submit"
          variant="primary"
          busy={sending}
          disabledReason={draft.trim().length === 0 ? 'Type an answer first.' : null}
        >
          Send answer
        </Action>
      </form>

      {caveat === null ? null : <Note tone="notice" className="mt-2">{caveat}</Note>}
      {feedback === null ? null : (
        <Note tone={feedback.tone} icon={<IconAlert className="size-3.5" />} className="mt-2">
          {feedback.message}
        </Note>
      )}
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Approvals                                                                   */
/* -------------------------------------------------------------------------- */

function ApprovalCard({
  approval,
  freshness,
  now,
  onDecide,
}: {
  readonly approval: WorkApproval;
  readonly freshness: FreshnessVerdict;
  readonly now: number;
  readonly onDecide: (
    approval: WorkApproval,
    decision: WorkApprovalAnswer,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
}): ReactNode {
  const [pending, setPending] = useState<WorkApprovalAnswer | null>(null);
  const [feedback, setFeedback] = useState<Feedback>(null);
  const risk = riskPresentation(approval.risk);
  const answerable = approvalIsAnswerable(approval);
  const caveat = stalenessCaveat(freshness);
  const alwaysConfirmed = isAlwaysConfirmed(approval.action, approval.risk);

  const expiresAt = parseInstant(approval.expiresAt);
  const remaining = expiresAt === null ? null : expiresAt - now;

  const decide = async (decision: WorkApprovalAnswer): Promise<void> => {
    if (pending !== null) return;
    setPending(decision);
    setFeedback(null);
    const result = await onDecide(approval, decision);
    setPending(null);
    if (!result.ok) setFeedback({ tone: 'danger', message: result.message });
  };

  const detailEntries = Object.entries(approval.detail);

  return (
    <Panel tone={risk.tone === 'danger' ? 'danger' : 'notice'} className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="inline-flex items-center gap-2">
          <IconShieldAlert className={cn('size-4', TONE_TEXT[risk.tone])} />
          <Eyebrow tone={risk.tone}>Your decision</Eyebrow>
          <StatusLabel tone={risk.tone} label={risk.label} />
        </span>
        {remaining === null ? null : (
          <span className="font-mono text-label uppercase text-muted-foreground">
            {remaining > 0 ? `expires in ${formatDuration(remaining)}` : 'expiring now'}
          </span>
        )}
      </div>

      <h3 className="mt-1.5 text-body-lg text-foreground">{approval.summary}</h3>
      <p className="mt-1 max-w-prose text-caption text-muted-foreground">{risk.why}</p>

      {alwaysConfirmed ? (
        <p className="mt-1 text-caption text-muted-foreground">
          This one is confirmed under every permission mode. No setting skips it.
        </p>
      ) : null}

      <dl className="mt-3 border-t border-border pt-2">
        <Fact label="Action" mono>
          {approval.action}
        </Fact>
        <Fact label="Tool" mono>
          {approval.tool}
        </Fact>
        {detailEntries.map(([key, value]) => (
          <Fact key={key} label={key}>
            {renderDetailValue(value)}
          </Fact>
        ))}
      </dl>

      {answerable ? (
        <>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {/* Refusal first, and never the autofocused control. */}
            <Action
              variant="danger-outline"
              icon={<IconBan className="size-4" />}
              busy={pending === 'denied'}
              onClick={() => {
                void decide('denied');
              }}
            >
              Don’t do it
            </Action>
            <Action
              variant={risk.affirmativeMayLead ? 'primary' : 'default'}
              busy={pending === 'allowed'}
              onClick={() => {
                void decide('allowed');
              }}
            >
              Allow this once
            </Action>
            {risk.standingAllowable ? (
              <Action
                variant="quiet"
                size="sm"
                busy={pending === 'allowed_always'}
                onClick={() => {
                  void decide('allowed_always');
                }}
              >
                Allow this and stop asking
              </Action>
            ) : null}
          </div>
          {risk.standingAllowable ? null : (
            <p className="mt-1.5 text-caption text-muted-foreground">
              This can be allowed this time only. Juno will ask again the next time it comes up.
            </p>
          )}
          {expiresAt === null ? null : (
            <p className="mt-1 text-caption text-muted-foreground">
              Unanswered, this expires and Juno stops rather than acting on a stale approval.
            </p>
          )}
        </>
      ) : (
        <Note tone="notice" icon={<IconAlert className="size-3.5" />} className="mt-3">
          {APPROVAL_UNANSWERABLE_REASON}
        </Note>
      )}

      {caveat === null ? null : <Note tone="notice" className="mt-2">{caveat}</Note>}
      {feedback === null ? null : (
        <Note tone={feedback.tone} icon={<IconAlert className="size-3.5" />} className="mt-2">
          {feedback.message}
        </Note>
      )}
    </Panel>
  );
}

/**
 * The approval detail bag is `Record<string, unknown>` by contract — it is
 * whatever the executor put in the bytes the digest was taken over. Rendering
 * it means rendering exactly that, so a user can see what they are agreeing to,
 * without letting a nested object become an unreadable `[object Object]`.
 */
function renderDetailValue(value: unknown): ReactNode {
  if (value === null || value === undefined) return <span className="text-muted-foreground">—</span>;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="font-mono">{String(value)}</span>;
  }
  if (Array.isArray(value)) {
    return (
      <ul className="list-inside list-disc">
        {value.slice(0, 12).map((entry, index) => (
          /* Position is the only identity these have: the detail bag is opaque, its
             entries are unordered-but-positional, and two identical strings in it
             are two genuinely distinct facts about the action. */
          // eslint-disable-next-line react/no-array-index-key
          <li key={index}>{renderDetailValue(entry)}</li>
        ))}
        {value.length > 12 ? (
          <li className="text-muted-foreground">and {value.length - 12} more</li>
        ) : null}
      </ul>
    );
  }
  return <span className="font-mono">{JSON.stringify(value)}</span>;
}

/* -------------------------------------------------------------------------- */
/* Announcement                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Say it once, when it becomes true.
 *
 * Holding the text in the region permanently would have it re-read on every
 * unrelated DOM change in some screen readers; clearing it after a beat means
 * the same sentence can be announced again if a *new* request arrives later.
 */
function useAssertiveAnnouncement(message: string | null): string {
  const [live, setLive] = useState('');
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (message === previous.current) return undefined;
    previous.current = message;
    if (message === null) {
      setLive('');
      return undefined;
    }
    setLive(message);
    const id = window.setTimeout(() => {
      setLive('');
    }, 3000);
    return () => {
      window.clearTimeout(id);
    };
  }, [message]);

  return live;
}
