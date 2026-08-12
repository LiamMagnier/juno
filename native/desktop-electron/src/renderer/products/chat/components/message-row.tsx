/**
 * One settled turn in the transcript.
 *
 * The component takes an `id` and NOTHING ELSE that changes. It reads its own
 * message through `useMessage(id)`, which subscribes to `msg:<id>` alone. That
 * is what lets the virtualizer hand it a stable prop and rely on `memo`: while
 * a reply streams, every settled row's props are identical render after render,
 * so React bails out before touching any of them.
 *
 * Volatile state that the actions need — whether a turn is running, what models
 * exist — is read inside `<MessageActions>`, one level further down, so a
 * status change re-renders a 28px toolbar rather than a page of prose.
 *
 * The visual asymmetry between roles is deliberate and is not bubbles. A user
 * turn is a short, contained block set in the interface face; an assistant turn
 * is full-measure prose set in the serif. That reads as a document with
 * quotations in it, which is what a transcript is — rather than as two columns
 * of chat balloons.
 */

import { memo, useCallback, useState, type ReactNode } from 'react';
import type { Attachment, Message } from '../contract.js';
import { cn } from '../lib/cn.js';
import { useChatActions, useMessage } from '../state/use-chat.js';
import { AlertIcon, FileIcon } from './icons.js';
import { Markdown } from './markdown-view.js';
import { MessageActions } from './message-actions.js';
import { Button, Eyebrow } from './primitives.js';

/* -------------------------------------------------------------------------- */
/* Attachments                                                                 */
/* -------------------------------------------------------------------------- */

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentTray({ attachments }: { attachments: readonly Attachment[] }): ReactNode {
  if (attachments.length === 0) return null;
  return (
    <ul className="mb-2 flex flex-wrap gap-2">
      {attachments.map((attachment) =>
        attachment.kind === 'IMAGE' ? (
          <li key={attachment.id}>
            <img
              src={attachment.url}
              alt={attachment.fileName}
              className="h-24 w-auto rounded-card border border-border object-cover"
            />
          </li>
        ) : (
          <li
            key={attachment.id}
            className="flex items-center gap-2 rounded-card border border-border bg-card px-2.5 py-1.5"
          >
            <FileIcon className="size-4 text-muted-foreground" />
            <span className="max-w-48 truncate text-caption text-foreground">{attachment.fileName}</span>
            <span className="font-mono text-caption text-muted-foreground">{formatBytes(attachment.size)}</span>
          </li>
        ),
      )}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */
/* Row                                                                         */
/* -------------------------------------------------------------------------- */

export interface MessageRowProps {
  readonly id: string;
}

export const MessageRow = memo(function MessageRow({ id }: MessageRowProps): ReactNode {
  const message = useMessage(id);
  const actions = useChatActions();
  const [editing, setEditing] = useState<string | null>(null);

  const onRetry = useCallback(
    (overrides?: { model?: string }) => {
      void actions.retry(id, overrides?.model !== undefined ? { model: overrides.model } : undefined);
    },
    [actions, id],
  );

  const onFork = useCallback(() => {
    void actions.fork(id);
  }, [actions, id]);

  const onEdit = useCallback(() => {
    setEditing(message?.content ?? '');
  }, [message?.content]);

  if (!message) return null;

  if (editing !== null && message.role === 'USER') {
    return (
      <MessageEditor
        initial={editing}
        onCancel={() => setEditing(null)}
        onSubmit={(text) => {
          setEditing(null);
          void actions.editAndResend(id, text);
        }}
      />
    );
  }

  return (
    <article
      className="group/message py-5"
      /* Not `role="article"` on a listitem — the transcript is a `log`, and
         each turn is an entry in it. The heading-free label is what a screen
         reader reads when navigating turn by turn. */
      aria-label={`${message.role === 'USER' ? 'You' : 'Assistant'} at ${formatTime(message.createdAt)}`}
    >
      <header className="mb-1.5 flex items-baseline gap-2">
        <Eyebrow>{message.role === 'USER' ? 'You' : (message.model ?? 'Assistant')}</Eyebrow>
        <time
          dateTime={message.createdAt}
          className="font-mono text-caption text-muted-foreground opacity-0 transition-opacity duration-base group-hover/message:opacity-100"
        >
          {formatTime(message.createdAt)}
        </time>
      </header>

      <AttachmentTray attachments={message.attachments} />

      {message.role === 'USER' ? (
        <div className="max-w-[56ch] rounded-card bg-secondary px-4 py-3 text-body text-foreground">
          {/* User text is not markdown-rendered. People write asterisks and
              underscores in prose and do not expect them to vanish, and a
              pasted snippet must survive verbatim. */}
          <p className="whitespace-pre-wrap [word-break:break-word]">{message.content}</p>
        </div>
      ) : (
        <Markdown
          source={message.content}
          /* The serif at reading size is the whole point of having an
             expressive face: this is the one surface in the app that is
             continuous prose. */
          className="font-serif text-body-lg text-foreground"
        />
      )}

      {message.errorMessage !== null ? (
        <p className="mt-3 flex items-start gap-2 border-l-2 border-destructive pl-3 text-body text-destructive-ink">
          <AlertIcon className="mt-0.5 size-4 shrink-0" />
          <span>{message.errorMessage}</span>
        </p>
      ) : null}

      <MessageActions
        message={message}
        onRetry={onRetry}
        onEdit={onEdit}
        onFork={onFork}
        className="mt-2 -ml-1.5"
      />
    </article>
  );
});

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/* -------------------------------------------------------------------------- */
/* Inline editor                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Editing a sent message, in place.
 *
 * Deliberately in place rather than in a dialog: the point of an edit is to
 * change the message *in the context of what came before it*, and a modal hides
 * exactly that. ⌘Enter submits and Escape cancels, the same two keys as the
 * composer, because the muscle memory should transfer.
 */
function MessageEditor({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [text, setText] = useState(initial);
  const changed = text.trim() !== initial.trim();

  return (
    <div className="py-5">
      <Eyebrow>Editing your message</Eyebrow>
      <textarea
        value={text}
        autoFocus
        rows={Math.min(12, Math.max(3, text.split('\n').length + 1))}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (changed) onSubmit(text.trim());
          }
        }}
        className={cn(
          'mt-2 w-full resize-none rounded-card border border-border bg-card px-4 py-3',
          'text-body text-foreground outline-none focus-visible:border-ring',
        )}
        aria-label="Edit your message"
      />
      <div className="mt-2 flex items-center gap-2">
        <Button
          variant="default"
          size="sm"
          onClick={() => onSubmit(text.trim())}
          disabledReason={
            !changed
              ? 'Change the message before resending.'
              : text.trim().length === 0
                ? 'A message cannot be empty.'
                : undefined
          }
        >
          Resend
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <span className="ml-auto font-mono text-caption text-muted-foreground">
          ⌘↩ to resend · esc to cancel
        </span>
      </div>
      <p className="mt-2 text-caption text-muted-foreground">
        Everything after this message will be replaced by a new reply.
      </p>
    </div>
  );
}
