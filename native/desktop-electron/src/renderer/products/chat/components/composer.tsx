/**
 * The composer.
 *
 * This is transient chrome — it floats over the transcript rather than being
 * part of it — so it is the one surface here that takes Juno's glass treatment.
 * The transcript underneath stays flat and opaque, because a reading surface
 * that blurs whatever is behind it is a reading surface with lower contrast for
 * no reason. Glass is applied through `data-glass` plus the two knobs from
 * `base.css` (`--glass-blur`, `--glass-veil`) rather than a hardcoded blur, so
 * macOS "Reduce Transparency" turns it opaque without this component knowing.
 *
 * The two things worth reading closely:
 *
 * **Attachments never touch the filesystem here.** There is no path in this
 * file that reads a file by name. The picker is an INTENT — `chat:pick-attachments`
 * opens a native dialog in main, which applies the MIME allowlist and the count
 * cap and returns finished attachments. Drag-and-drop goes through the DOM
 * `File` API, which is a web capability the sandbox permits, and hands main the
 * bytes; main is still the one that decides whether to accept them. The
 * renderer proposes; main disposes.
 *
 * **Autosizing is measured, not counted.** Height comes from `scrollHeight`
 * after a reset to `auto`, not from counting `\n`s — because a single long line
 * that soft-wraps to four rows must grow the field, and a newline count cannot
 * see that.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { Attachment, ModelDescriptor, ReasoningEffort } from '../contract.js';
import { chatInvoke } from '../lib/bridge.js';
import { cn } from '../lib/cn.js';
import { clampEffort, effortDescription, effortLabel, effortOptionsFor } from '../lib/models.js';
import { useChatActions, useIsBusy, useConnection, useModels } from '../state/use-chat.js';
import {
  ChevronDownIcon,
  CloseIcon,
  FileIcon,
  ImageIcon,
  ModelIcon,
  PaperclipIcon,
  ReasoningIcon,
  SendIcon,
  StopIcon,
} from './icons.js';
import { Button, IconButton, Menu, MenuItem, MenuLabel } from './primitives.js';

/** Matches the web's `MAX_ATTACHMENTS`. Enforced again in main. */
const MAX_ATTACHMENTS = 10;
/** Above this the field scrolls instead of growing. Roughly twelve lines. */
const MAX_FIELD_HEIGHT = 320;

/* -------------------------------------------------------------------------- */
/* File reading                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Read a dropped file to base64.
 *
 * `FileReader` rather than `file.arrayBuffer()` + manual encoding, because
 * `btoa` on a large binary string blows the argument limit and the chunked
 * workaround is a well-known source of corruption at the boundaries. The
 * data-URL prefix is sliced off rather than parsed — the format is fixed and a
 * parser here would be ceremony.
 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error(`Could not read ${file.name}.`));
        return;
      }
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

/* -------------------------------------------------------------------------- */
/* Attachment chips                                                            */
/* -------------------------------------------------------------------------- */

function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: Attachment;
  onRemove: () => void;
}): ReactNode {
  return (
    <li className="group/chip flex items-center gap-2 rounded-composer-control border border-border bg-card py-1 pl-2 pr-1">
      {attachment.kind === 'IMAGE' ? (
        <img src={attachment.url} alt="" className="size-6 rounded-xs object-cover" />
      ) : (
        <FileIcon className="size-4 text-muted-foreground" />
      )}
      <span className="max-w-40 truncate text-caption text-foreground">{attachment.fileName}</span>
      <IconButton size="icon-sm" label={`Remove ${attachment.fileName}`} onClick={onRemove} className="size-6">
        <CloseIcon className="size-3" />
      </IconButton>
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/* Composer                                                                    */
/* -------------------------------------------------------------------------- */

export interface ComposerProps {
  readonly conversationId: string | null;
  readonly model: string;
  readonly onModelChange: (model: string) => void;
  readonly reasoningEffort: ReasoningEffort | null;
  readonly onReasoningChange: (effort: ReasoningEffort | null) => void;
  readonly autoFocus?: boolean;
}

export function Composer({
  conversationId,
  model,
  onModelChange,
  reasoningEffort,
  onReasoningChange,
  autoFocus = false,
}: ComposerProps): ReactNode {
  const actions = useChatActions();
  const busy = useIsBusy();
  const connection = useConnection();
  const { models, loading: modelsLoading, error: modelsError } = useModels();

  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<readonly Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busyWithFiles, setBusyWithFiles] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const dragDepth = useRef(0);

  const selected = models.find((entry) => entry.id === model);
  const effortOptions = effortOptionsFor(selected);
  const offline = connection.status !== 'online';

  /* --- autosize ----------------------------------------------------------- */
  useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.style.height = 'auto';
    const next = Math.min(field.scrollHeight, MAX_FIELD_HEIGHT);
    field.style.height = `${next}px`;
    field.style.overflowY = field.scrollHeight > MAX_FIELD_HEIGHT ? 'auto' : 'hidden';
  }, [text]);

  useEffect(() => {
    if (autoFocus) fieldRef.current?.focus();
  }, [autoFocus]);

  /* Keep the chosen depth legal when the model changes under it. */
  useEffect(() => {
    const clamped = clampEffort(reasoningEffort, selected);
    if (clamped !== reasoningEffort) onReasoningChange(clamped);
  }, [selected, reasoningEffort, onReasoningChange]);

  /* --- attachments -------------------------------------------------------- */
  const acceptFiles = useCallback(
    async (files: readonly File[]): Promise<void> => {
      if (files.length === 0) return;
      const room = MAX_ATTACHMENTS - attachments.length;
      if (room <= 0) {
        setNotice(`You can attach up to ${MAX_ATTACHMENTS} files.`);
        return;
      }

      setBusyWithFiles(true);
      setNotice(null);
      try {
        const accepted = files.slice(0, room);
        const payload = await Promise.all(
          accepted.map(async (file) => ({
            fileName: file.name,
            mimeType: file.type,
            size: file.size,
            data: await readAsBase64(file),
          })),
        );

        const result = await chatInvoke('chat:receive-dropped-files', {
          conversationId,
          files: payload,
        });

        if (!result.ok) {
          setNotice(result.error);
          return;
        }
        setAttachments((current) => [...current, ...result.value.attachments].slice(0, MAX_ATTACHMENTS));
        if (result.value.rejected.length > 0) {
          const first = result.value.rejected[0];
          setNotice(
            result.value.rejected.length === 1 && first !== undefined
              ? `${first.fileName}: ${first.reason}`
              : `${result.value.rejected.length} files were not accepted.`,
          );
        }
        if (files.length > room) {
          setNotice(`Only the first ${room} files were attached — the limit is ${MAX_ATTACHMENTS}.`);
        }
      } catch (error: unknown) {
        setNotice(error instanceof Error ? error.message : 'Those files could not be read.');
      } finally {
        setBusyWithFiles(false);
      }
    },
    [attachments.length, conversationId],
  );

  const openPicker = useCallback(() => {
    void (async () => {
      setBusyWithFiles(true);
      const result = await chatInvoke('chat:pick-attachments', { conversationId, accept: 'all' });
      setBusyWithFiles(false);
      if (!result.ok) {
        setNotice(result.error);
        return;
      }
      setAttachments((current) => [...current, ...result.value.attachments].slice(0, MAX_ATTACHMENTS));
    })();
  }, [conversationId]);

  /* Drag counters, not a boolean: `dragleave` fires when the pointer crosses
     into a CHILD element, so a naive flag flickers off every time the cursor
     passes over the send button. */
  const onDragEnter = (event: DragEvent<HTMLDivElement>): void => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    dragDepth.current += 1;
    setDragging(true);
  };

  const onDragLeave = (): void => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    void acceptFiles(Array.from(event.dataTransfer.files));
  };

  /* --- send --------------------------------------------------------------- */
  const canSend = text.trim().length > 0 || attachments.length > 0;

  const sendBlockedReason = ((): string | undefined => {
    if (offline) {
      return connection.status === 'reconnecting'
        ? 'Reconnecting to Juno — your message will send once the connection is back.'
        : 'You are offline. Messages cannot be sent right now.';
    }
    if (modelsLoading) return 'Waiting for the model list.';
    if (models.length === 0) return modelsError ?? 'No models are available on your plan.';
    if (!canSend) return 'Write a message first.';
    return undefined;
  })();

  const submit = useCallback(() => {
    if (busy || sendBlockedReason !== undefined) return;
    const outgoing = text.trim();
    void actions.send({ text: outgoing, attachments, model, reasoningEffort });
    setText('');
    setAttachments([]);
    setNotice(null);
  }, [actions, attachments, busy, model, reasoningEffort, sendBlockedReason, text]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    /* Enter sends; Shift+Enter is a newline. ⌘/Ctrl+Enter also sends, so the
       habit carried in from every other editor does the expected thing rather
       than nothing. */
    if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      submit();
    }
  };

  const onPaste = (event: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void acceptFiles(files);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 z-toolbar px-8 pb-6">
      <div className="pointer-events-auto mx-auto w-full max-w-[72ch]">
        {notice !== null ? (
          <p
            role="status"
            className="mb-2 flex items-center justify-between gap-3 rounded-card border border-border bg-card px-3 py-2 text-caption text-muted-foreground"
          >
            <span>{notice}</span>
            <IconButton size="icon-sm" label="Dismiss" onClick={() => setNotice(null)}>
              <CloseIcon className="size-3" />
            </IconButton>
          </p>
        ) : null}

        <div
          onDragEnter={onDragEnter}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          /* The glass surface. `data-glass` is the hook `base.css` uses to turn
             this opaque under Reduce Transparency; the two custom properties
             are the only place blur and veil are named. */
          data-glass=""
          style={{
            backdropFilter: 'blur(var(--glass-blur))',
            WebkitBackdropFilter: 'blur(var(--glass-blur))',
            backgroundColor: 'hsl(var(--popover) / var(--glass-veil))',
          }}
          className={cn(
            'rounded-composer border border-border shadow-glass transition-colors duration-base',
            dragging && 'border-primary',
          )}
        >
          {dragging ? (
            <p className="flex items-center justify-center gap-2 border-b border-border px-4 py-3 text-body text-primary-ink">
              <ImageIcon className="size-4" />
              Drop to attach
            </p>
          ) : null}

          {attachments.length > 0 ? (
            <ul className="flex flex-wrap gap-2 px-3 pt-3">
              {attachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  attachment={attachment}
                  onRemove={() =>
                    setAttachments((current) => current.filter((entry) => entry.id !== attachment.id))
                  }
                />
              ))}
            </ul>
          ) : null}

          <textarea
            ref={fieldRef}
            value={text}
            rows={1}
            onChange={(event: ChangeEvent<HTMLTextAreaElement>) => setText(event.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={busy ? 'Juno is responding…' : 'Ask anything'}
            aria-label="Message"
            aria-describedby="composer-hint"
            className={cn(
              'block w-full resize-none bg-transparent px-4 pb-2 pt-3.5',
              'text-body-lg text-foreground placeholder:text-muted-foreground',
              /* The focus ring belongs to the whole composer, not to the bare
                 field inside it. */
              'outline-none',
            )}
          />

          <div className="flex items-center gap-1 px-2 pb-2">
            <IconButton
              label="Attach files"
              onClick={openPicker}
              disabledReason={
                busyWithFiles
                  ? 'Reading files…'
                  : attachments.length >= MAX_ATTACHMENTS
                    ? `You can attach up to ${MAX_ATTACHMENTS} files.`
                    : undefined
              }
            >
              <PaperclipIcon className="size-4" />
            </IconButton>

            <ModelPicker models={models} value={model} onChange={onModelChange} loading={modelsLoading} error={modelsError} />

            <EffortPicker
              options={effortOptions}
              value={reasoningEffort}
              onChange={onReasoningChange}
              modelName={selected?.name ?? null}
            />

            <span className="ml-auto" />

            {busy ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => void actions.stop()}
                className="gap-1.5"
                aria-label="Stop generating"
              >
                <StopIcon className="size-3.5" />
                Stop
              </Button>
            ) : (
              <IconButton
                label="Send message"
                variant="default"
                onClick={submit}
                disabledReason={sendBlockedReason}
              >
                <SendIcon className="size-4" />
              </IconButton>
            )}
          </div>
        </div>

        <p id="composer-hint" className="mt-1.5 px-1 text-center text-caption text-muted-foreground">
          {offline
            ? connection.detail ?? 'Waiting for a connection.'
            : 'Return to send · Shift + Return for a new line'}
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Pickers                                                                     */
/* -------------------------------------------------------------------------- */

function ModelPicker({
  models,
  value,
  onChange,
  loading,
  error,
}: {
  models: readonly ModelDescriptor[];
  value: string;
  onChange: (model: string) => void;
  loading: boolean;
  error: string | null;
}): ReactNode {
  const selected = models.find((entry) => entry.id === value);

  /* Grouped by provider. A flat list of twenty models is a wall; the provider
     is the first thing anyone uses to narrow it down. */
  const providers = [...new Set(models.map((model) => model.provider))];

  return (
    <Menu
      label="Choose a model"
      side="top"
      trigger={(props) => (
        <Button
          {...props}
          size="sm"
          className="gap-1.5"
          disabledReason={loading ? 'Loading models…' : models.length === 0 ? (error ?? 'No models available.') : undefined}
        >
          <ModelIcon className="size-3.5" />
          <span className="max-w-40 truncate">{selected?.name ?? (loading ? 'Loading…' : 'Model')}</span>
          <ChevronDownIcon className="size-3" />
        </Button>
      )}
    >
      {providers.map((provider) => (
        <div key={provider}>
          <MenuLabel>{provider}</MenuLabel>
          {models
            .filter((model) => model.provider === provider)
            .map((model) => (
              <MenuItem
                key={model.id}
                selected={model.id === value}
                onSelect={() => onChange(model.id)}
                disabledReason={model.lockedReason ?? undefined}
                hint={model.deprecationNote ?? undefined}
              >
                {model.name}
              </MenuItem>
            ))}
        </div>
      ))}
    </Menu>
  );
}

function EffortPicker({
  options,
  value,
  onChange,
  modelName,
}: {
  options: readonly (ReasoningEffort | null)[];
  value: ReasoningEffort | null;
  onChange: (effort: ReasoningEffort | null) => void;
  modelName: string | null;
}): ReactNode {
  return (
    <Menu
      label="Choose thinking depth"
      side="top"
      trigger={(props) => (
        <Button
          {...props}
          size="sm"
          className="gap-1.5"
          disabledReason={
            options.length === 0
              ? `${modelName ?? 'This model'} does not expose a thinking setting.`
              : undefined
          }
        >
          <ReasoningIcon className="size-3.5" />
          <span>{effortLabel(value)}</span>
          <ChevronDownIcon className="size-3" />
        </Button>
      )}
    >
      <MenuLabel>Thinking depth</MenuLabel>
      {options.map((option) => (
        <MenuItem key={option ?? 'instant'} selected={option === value} onSelect={() => onChange(option)}>
          <span className="flex flex-col">
            <span>{effortLabel(option)}</span>
            <span className="text-caption text-muted-foreground">{effortDescription(option)}</span>
          </span>
        </MenuItem>
      ))}
    </Menu>
  );
}
