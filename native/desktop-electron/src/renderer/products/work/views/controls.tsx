/**
 * Pause, resume, cancel, retry, intervene.
 *
 * Every one of these is either live or carries a sentence saying why it is not.
 * `deriveControls` computes both together so there is no path to a disabled
 * control without a reason — the reason is the `disabledReason` prop, it reaches
 * assistive technology through `aria-describedby`, and for the primary row it is
 * also drawn.
 *
 * Two behaviours worth naming:
 *
 * **Cancel confirms in place.** It is the only control here that ends work
 * somebody is waiting on, and a misplaced click on it costs the whole attempt.
 * It does not open a dialog — a modal for a two-word question is heavier than
 * the question — it becomes its own confirmation, and the confirming button is
 * not where the first one was.
 *
 * **Intervening is honest about when it lands.** Steering is the single
 * exception to "changes take effect next attempt", and the copy says exactly
 * that: Juno reads it before its next step, and what it has already done stands.
 * A run stopped on a question refuses steering outright, so the control is
 * disabled there with the reason that points at the answer box instead.
 */

import { useState, type ReactNode } from 'react';
import type { ControlStates } from '../lib/derive.js';
import { NEXT_ATTEMPT_CAVEAT } from '../lib/derive.js';
import type { WorkControl } from '../lib/derive.js';
import { Action, Eyebrow, Note, Panel } from '../components/primitives.js';
import { IconAlert, IconMessage, IconPause, IconPlay, IconRetry, IconStop } from '../components/icons.js';

export function ControlsPanel({
  controls,
  busy,
  canSteer,
  onControl,
  onRetry,
  onSteer,
}: {
  readonly controls: ControlStates;
  readonly busy: WorkControl | null;
  /** Mirrors `controls.steer.enabled`; kept separate so the box can collapse. */
  readonly canSteer: boolean;
  readonly onControl: (control: 'pause' | 'resume' | 'cancel') => void;
  readonly onRetry: () => void;
  readonly onSteer: (text: string) => Promise<{ ok: true } | { ok: false; message: string }>;
}): ReactNode {
  const [confirmingCancel, setConfirmingCancel] = useState(false);

  return (
    <Panel className="p-4" aria-label="Run controls">
      <Eyebrow>Controls</Eyebrow>

      <div className="mt-2 flex flex-wrap items-start gap-2">
        <Action
          icon={<IconPause className="size-4" />}
          disabledReason={controls.pause.reason}
          busy={busy === 'pause'}
          onClick={() => {
            onControl('pause');
          }}
        >
          Pause
        </Action>

        <Action
          icon={<IconPlay className="size-4" />}
          disabledReason={controls.resume.reason}
          busy={busy === 'resume'}
          onClick={() => {
            onControl('resume');
          }}
        >
          Resume
        </Action>

        {confirmingCancel ? (
          <span className="inline-flex items-center gap-2 rounded-control border border-destructive/50 px-2 py-1">
            <span className="text-caption text-destructive">Stop this attempt?</span>
            <Action
              size="sm"
              variant="danger-outline"
              busy={busy === 'cancel'}
              onClick={() => {
                setConfirmingCancel(false);
                onControl('cancel');
              }}
            >
              Yes, stop it
            </Action>
            <Action
              size="sm"
              variant="quiet"
              onClick={() => {
                setConfirmingCancel(false);
              }}
            >
              Keep going
            </Action>
          </span>
        ) : (
          <Action
            icon={<IconStop className="size-4" />}
            disabledReason={controls.cancel.reason}
            onClick={() => {
              setConfirmingCancel(true);
            }}
          >
            Cancel
          </Action>
        )}

        <Action
          icon={<IconRetry className="size-4" />}
          disabledReason={controls.retry.reason}
          busy={busy === 'retry'}
          onClick={onRetry}
        >
          Run again
        </Action>
      </div>

      <DisabledReasons controls={controls} />

      <div className="mt-4 border-t border-border pt-3">
        <SteerBox canSteer={canSteer} reason={controls.steer.reason} onSteer={onSteer} />
      </div>
    </Panel>
  );
}

/**
 * The reasons, drawn once and deduplicated.
 *
 * Repeating "this run is over" under four buttons is noise; saying it once
 * under the row is the same information at a quarter of the weight.
 */
function DisabledReasons({ controls }: { readonly controls: ControlStates }): ReactNode {
  const reasons = new Set<string>();
  for (const key of ['pause', 'resume', 'cancel', 'retry'] as const) {
    const reason = controls[key].reason;
    if (reason !== null) reasons.add(reason);
  }
  if (reasons.size === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-0.5">
      {[...reasons].map((reason) => (
        <li key={reason} className="text-caption text-muted-foreground">
          {reason}
        </li>
      ))}
    </ul>
  );
}

function SteerBox({
  canSteer,
  reason,
  onSteer,
}: {
  readonly canSteer: boolean;
  readonly reason: string | null;
  readonly onSteer: (text: string) => Promise<{ ok: true } | { ok: false; message: string }>;
}): ReactNode {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const submit = async (): Promise<void> => {
    const text = draft.trim();
    if (text.length === 0 || sending) return;
    setSending(true);
    setError(null);
    const result = await onSteer(text);
    setSending(false);
    if (result.ok) {
      setDraft('');
      setSent(true);
    } else {
      setError(result.message);
    }
  };

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Eyebrow>Intervene</Eyebrow>
      <p className="mt-1 max-w-prose text-caption text-muted-foreground">
        Juno reads this before its next step and works to it from there. What it has already done
        stands.
      </p>
      <label className="sr-only" htmlFor="work-steer">
        An instruction for the attempt now running
      </label>
      <textarea
        id="work-steer"
        rows={2}
        value={draft}
        disabled={!canSteer}
        onChange={(event) => {
          setDraft(event.target.value);
          setSent(false);
        }}
        placeholder={canSteer ? 'Tell Juno something it did not ask for' : ''}
        className="mt-2 w-full resize-y rounded-field border border-input bg-background px-2.5 py-2 text-body text-foreground placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-45"
      />
      <div className="mt-2 flex items-center gap-2">
        <Action
          type="submit"
          size="sm"
          icon={<IconMessage className="size-4" />}
          busy={sending}
          disabledReason={
            !canSteer ? reason : draft.trim().length === 0 ? 'Write something to send first.' : null
          }
          showReason={!canSteer}
        >
          Send to this attempt
        </Action>
        {sent ? (
          <span className="text-caption text-success" role="status">
            Sent. Juno picks it up at its next step.
          </span>
        ) : null}
      </div>

      {error === null ? null : (
        <Note tone="danger" icon={<IconAlert className="size-3.5" />} className="mt-2">
          {error}
        </Note>
      )}

      <Note tone="quiet" className="mt-3">
        {NEXT_ATTEMPT_CAVEAT}
      </Note>
    </form>
  );
}
