/**
 * The turn currently being generated.
 *
 * This component is the ONLY thing in the transcript that re-renders as tokens
 * arrive, and even inside it the work is partitioned so that a token touches as
 * little as possible:
 *
 *   `<StreamingMessage>`   subscribes to `live:meta` — model, status, error.
 *                          Re-renders a handful of times per turn.
 *   `<Elapsed>`            owns its own 1Hz interval. A ticking clock must not
 *                          be a reason to re-render prose.
 *   `<ReasoningPanel>`     subscribes to `live:reasoning` only.
 *   `<LiveBody>`           subscribes to `live:text` only.
 *
 * So a `delta` frame wakes `<LiveBody>` and nothing else; a `reasoning` frame
 * wakes `<ReasoningPanel>` and nothing else. Neither wakes the header, the stop
 * button, the clock, or any settled message.
 *
 * The reasoning display follows the shape of the actual event rather than a
 * generic "loading" idiom: while the model is thinking the panel is open and
 * the text scrolls, because that is the only thing happening and it is worth
 * watching. The moment the first answer token lands it collapses to a single
 * line stating how long it thought, because from then on the answer is the
 * thing and the reasoning is a receipt.
 */

import { memo, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '../lib/cn.js';
import { effortLabel } from '../lib/models.js';
import {
  useChatActions,
  useLiveMeta,
  useLiveReasoning,
  useLiveText,
  useModels,
} from '../state/use-chat.js';
import { AlertIcon, ChevronDownIcon, ChevronRightIcon, ReasoningIcon, StopIcon } from './icons.js';
import { Markdown } from './markdown-view.js';
import { Button, Eyebrow, IconButton } from './primitives.js';

/* -------------------------------------------------------------------------- */
/* Elapsed                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A seconds counter, isolated so its tick cannot reach anything else.
 *
 * It is also `aria-hidden`: a live region that re-announces a number every
 * second is the fastest way to make a screen-reader user switch the whole
 * application off. The status line below carries the state in words instead.
 */
const Elapsed = memo(function Elapsed({ startedAt }: { startedAt: number }): ReactNode {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, []);

  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return (
    <span aria-hidden="true" className="font-mono text-caption tabular-nums text-muted-foreground">
      {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}
    </span>
  );
});

/* -------------------------------------------------------------------------- */
/* Reasoning                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The thinking panel.
 *
 * Reasoning is rendered as plain pre-wrapped text, not markdown. It is a
 * stream of half-formed thought that frequently contains stray asterisks and
 * unbalanced backticks; running it through a markdown renderer produces
 * flickering bold runs and phantom code spans as the tokens land.
 */
const ReasoningPanel = memo(function ReasoningPanel({
  thinking,
  durationMs,
  effortText,
}: {
  thinking: boolean;
  durationMs: number | null;
  effortText: string;
}): ReactNode {
  const reasoning = useLiveReasoning();
  /* Open while thinking, closed once the answer starts — but only until the
     user says otherwise, after which their choice wins for the rest of the
     turn. An auto-collapse that fights the user is worse than no auto at all. */
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? thinking;
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || !thinking) return;
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [reasoning, open, thinking]);

  if (reasoning.length === 0 && !thinking) return null;

  const summary = thinking
    ? `Thinking · ${effortText}`
    : durationMs !== null
      ? `Thought for ${Math.max(1, Math.round(durationMs / 1000))}s · ${effortText}`
      : `Thought · ${effortText}`;

  return (
    <div className="mb-3">
      <button
        type="button"
        onClick={() => setOverride(!open)}
        aria-expanded={open}
        className={cn(
          'flex items-center gap-1.5 rounded-control py-1 pr-2 text-caption',
          'text-muted-foreground transition-colors duration-fast hover:text-foreground',
        )}
      >
        {open ? <ChevronDownIcon className="size-3.5" /> : <ChevronRightIcon className="size-3.5" />}
        <ReasoningIcon className={cn('size-3.5', thinking && 'animate-icon-breathe')} />
        <span className={thinking ? 'animate-status-glow' : undefined}>{summary}</span>
      </button>

      {open && reasoning.length > 0 ? (
        <div
          ref={scrollRef}
          /* Bounded and self-scrolling. Unbounded reasoning pushes the answer
             below the fold at exactly the moment it starts arriving. */
          className="mt-1 max-h-48 overflow-y-auto border-l-2 border-border pl-3"
        >
          <p className="whitespace-pre-wrap text-body text-muted-foreground [word-break:break-word]">
            {reasoning}
          </p>
        </div>
      ) : null}
    </div>
  );
});

/* -------------------------------------------------------------------------- */
/* Body                                                                        */
/* -------------------------------------------------------------------------- */

const LiveBody = memo(function LiveBody(): ReactNode {
  const text = useLiveText();
  if (text.length === 0) return null;
  return <Markdown source={text} streaming className="font-serif text-body-lg text-foreground" />;
});

/**
 * The pre-first-token state.
 *
 * Three dots on a baseline, not a spinner and not a skeleton of fake
 * paragraphs. A skeleton claims to know the shape of an answer that does not
 * exist yet, and every one of those grey bars is a small lie about what is
 * coming.
 */
function Waiting({ label }: { label: string }): ReactNode {
  return (
    <p className="flex items-center gap-2 text-body text-muted-foreground">
      <span aria-hidden="true" className="flex items-end gap-dot-gap">
        {[0, 1, 2].map((index) => (
          <span
            key={index}
            className="size-dot animate-dot-wave rounded-full bg-current"
            style={{ animationDelay: `${index * 0.14}s` }}
          />
        ))}
      </span>
      <span className="animate-status-glow">{label}</span>
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* The turn                                                                    */
/* -------------------------------------------------------------------------- */

export function StreamingMessage(): ReactNode {
  const meta = useLiveMeta();
  const actions = useChatActions();
  const { models } = useModels();

  if (!meta) return null;

  const thinking = meta.status === 'thinking' || meta.status === 'submitting';
  const model = models.find((entry) => entry.id === meta.model);
  const effortText = effortLabel(meta.reasoningEffort);
  const durationMs = meta.reasoningEndedAt !== null ? meta.reasoningEndedAt - meta.startedAt : null;

  return (
    <article className="group/message py-5" aria-label="Assistant, responding">
      <header className="mb-1.5 flex items-center gap-2">
        <Eyebrow>{model?.name ?? meta.model}</Eyebrow>
        <Elapsed startedAt={meta.startedAt} />

        {meta.status !== 'error' ? (
          <IconButton
            size="icon-sm"
            label="Stop generating"
            onClick={() => void actions.stop()}
            disabledReason={meta.status === 'stopping' ? 'Stopping…' : undefined}
            className="ml-auto text-destructive-ink hover:bg-destructive/10 hover:text-destructive-ink"
          >
            <StopIcon className="size-3.5" />
          </IconButton>
        ) : null}
      </header>

      {/*
        The one live region on this surface, and it announces STATE rather than
        content. Piping the token stream into `aria-live` would produce
        continuous, uninterruptible speech; announcing "Thinking" then
        "Responding" then "Complete" gives a screen-reader user the same
        information a sighted user gets from the header, at a pace they can
        listen to.
      */}
      <p className="sr-only" role="status" aria-live="polite">
        {meta.status === 'error'
          ? 'The response failed.'
          : meta.status === 'writing'
            ? 'Responding.'
            : meta.status === 'stopping'
              ? 'Stopping.'
              : 'Thinking.'}
      </p>

      <ReasoningPanel thinking={thinking} durationMs={durationMs} effortText={effortText} />

      <LiveBody />
      <PendingIndicator status={meta.status} />

      {meta.status === 'error' && meta.error !== null ? (
        <div className="mt-3 border-l-2 border-destructive pl-3">
          <p className="flex items-start gap-2 text-body text-destructive-ink">
            <AlertIcon className="mt-0.5 size-4 shrink-0" />
            <span>{meta.error}</span>
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void actions.retry(meta.assistantMessageId)}
              disabledReason={meta.retryable ? undefined : 'This request cannot be retried.'}
            >
              Try again
            </Button>
            <Button variant="ghost" size="sm" onClick={actions.dismissError}>
              Dismiss
            </Button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

/**
 * Shows the waiting dots only until the first token lands.
 *
 * Split out so that it — and not the whole turn — is what re-renders when the
 * answer buffer goes from empty to non-empty.
 */
const PendingIndicator = memo(function PendingIndicator({
  status,
}: {
  status: string;
}): ReactNode {
  const text = useLiveText();
  if (text.length > 0) return null;
  if (status === 'error') return null;
  return <Waiting label={status === 'stopping' ? 'Stopping' : status === 'writing' ? 'Writing' : 'Thinking'} />;
});
