/**
 * The composer.
 *
 * Two rules it is built around:
 *
 *  • Stop is always reachable. While a turn is running the primary action of
 *    the composer *is* Stop, and it is also present in the header, so a user
 *    who has scrolled away is never more than one visible control from halting
 *    the agent. It is wired to `code:abort`.
 *  • Blocked is explained. Every reason the composer refuses input — untrusted
 *    workspace, no bridge, host crashed, session failed to start — renders as
 *    text next to a disabled field rather than as a field that quietly eats
 *    keystrokes.
 */

import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from 'react';
import { cn } from '../lib/cn.js';
import type { PermissionMode } from '../lib/contract.js';
import { descriptorFor, fromPermissionMode } from '../lib/modes.js';
import { Button, FOCUS_RING, IconButton, Mono } from './primitives.js';
import { SendIcon, StopIcon } from './icons.js';

export interface SessionComposerProps {
  onSubmit: (text: string) => void;
  onAbort: () => void;
  running: boolean;
  /** Non-null blocks input and is shown verbatim. */
  blockedReason: string | null;
  mode: PermissionMode | null;
  submitting: boolean;
  className?: string;
}

const MAX_HEIGHT = 200;

export function SessionComposer({
  onSubmit,
  onAbort,
  running,
  blockedReason,
  mode,
  submitting,
  className,
}: SessionComposerProps): JSX.Element {
  const [value, setValue] = useState('');
  const textarea = useRef<HTMLTextAreaElement | null>(null);
  const blocked = blockedReason !== null;

  useLayoutEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  useEffect(() => {
    if (!blocked) textarea.current?.focus();
  }, [blocked]);

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || blocked) return;
    onSubmit(trimmed);
    setValue('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit();
    }
  };

  const descriptor = mode === null ? null : (() => {
    const resolved = fromPermissionMode(mode);
    return descriptorFor(resolved.mode, resolved.fullAccess);
  })();

  const placeholder = blocked
    ? 'Input disabled'
    : descriptor === null
      ? 'Describe a task…'
      : descriptor.mutationPossible
        ? `Describe a task — ${descriptor.guarantee}`
        : 'Ask about this codebase — read-only';

  return (
    <div className={cn('border-t border-border bg-background px-3 py-2', className)}>
      <div
        className={cn(
          'rounded-lg border bg-card transition-colors duration-100',
          blocked ? 'border-border opacity-60' : 'border-border focus-within:border-primary/60',
        )}
      >
        <label htmlFor="code-composer" className="sr-only">
          Message the coding agent
        </label>
        <textarea
          id="code-composer"
          ref={textarea}
          rows={1}
          value={value}
          disabled={blocked}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-describedby="code-composer-hint"
          className={cn(
            'block w-full resize-none bg-transparent px-3 py-2 text-[13px] leading-[1.6]',
            'text-foreground placeholder:text-muted-foreground',
            'outline-none disabled:cursor-not-allowed',
            FOCUS_RING,
            'focus-visible:ring-0 focus-visible:ring-offset-0',
          )}
        />
        <div className="flex items-center gap-2 border-t border-border px-2 py-1.5">
          <Mono id="code-composer-hint" className="flex-1 truncate text-muted-foreground">
            {blocked ? (
              blockedReason
            ) : (
              <>
                <kbd className="rounded border border-border bg-muted px-1">Return</kbd> to send ·{' '}
                <kbd className="rounded border border-border bg-muted px-1">Shift</kbd>+
                <kbd className="rounded border border-border bg-muted px-1">Return</kbd> for a new line
              </>
            )}
          </Mono>

          {running ? (
            <Button
              variant="danger"
              icon={<StopIcon className="h-3 w-3" />}
              onClick={onAbort}
              aria-keyshortcuts="Escape"
            >
              Stop
            </Button>
          ) : (
            <IconButton
              label="Send message"
              icon={<SendIcon className="h-3.5 w-3.5" />}
              tone="primary"
              onClick={submit}
              disabled={blocked || value.trim().length === 0 || submitting}
              disabledReason={
                blocked
                  ? blockedReason
                  : value.trim().length === 0
                    ? 'Nothing to send.'
                    : 'Sending…'
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}
