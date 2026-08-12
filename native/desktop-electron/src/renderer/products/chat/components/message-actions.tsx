/**
 * The row of actions under a message.
 *
 * Two decisions shape it.
 *
 * **They are revealed, not hidden.** The row occupies its space at all times
 * and fades its contents in on hover or keyboard focus. A row that is
 * `display: none` until hover cannot be reached by tab at all, and one that is
 * inserted on hover shifts every message below it by 28px the moment the
 * pointer crosses a boundary — which, in a transcript you are reading, is
 * infuriating.
 *
 * **Nothing here is a dead button.** Every action that cannot run right now is
 * `disabled` and carries the reason, from a single `unavailable()` helper.
 * "Retry" during a stream says why it is off; it does not silently do nothing.
 */

import { useState, type ReactNode } from 'react';
import type { Message } from '../contract.js';
import { copyText } from '../lib/bridge.js';
import { cn } from '../lib/cn.js';
import { useIsBusy, useModels } from '../state/use-chat.js';
import { CheckIcon, CopyIcon, EditIcon, ForkIcon, ModelIcon, RetryIcon } from './icons.js';
import { IconButton, Menu, MenuItem, MenuLabel } from './primitives.js';

export interface MessageActionsProps {
  readonly message: Message;
  readonly onRetry: (overrides?: { model?: string }) => void;
  readonly onEdit: () => void;
  readonly onFork: () => void;
  readonly className?: string | undefined;
}

export function MessageActions({
  message,
  onRetry,
  onEdit,
  onFork,
  className,
}: MessageActionsProps): ReactNode {
  const [copied, setCopied] = useState(false);
  /* Read here rather than passed down from the row. Both of these change while
     a turn runs, and taking them as props would make every settled row in the
     transcript re-render on each status transition — for a toolbar. */
  const busy = useIsBusy();
  const { models } = useModels();
  const isUser = message.role === 'USER';

  /* One place that decides "why not", so the reasons stay consistent between
     the four controls instead of drifting into four different phrasings. */
  const unavailable: string | undefined = busy
    ? 'Wait for the current response to finish.'
    : undefined;

  const onCopy = (): void => {
    void (async () => {
      const ok = await copyText(message.content);
      setCopied(ok);
      window.setTimeout(() => setCopied(false), 1600);
    })();
  };

  return (
    <div
      className={cn(
        'flex items-center gap-0.5',
        /* Present in the layout, faded until wanted. `focus-within` is what
           keeps the row reachable by keyboard. */
        'opacity-0 transition-opacity duration-base ease-out-soft',
        'group-hover/message:opacity-100 group-focus-within/message:opacity-100',
        copied && 'opacity-100',
        className,
      )}
    >
      <IconButton
        size="icon-sm"
        label={copied ? 'Copied' : 'Copy message'}
        onClick={onCopy}
      >
        {copied ? <CheckIcon className="size-3.5 text-success-ink" /> : <CopyIcon className="size-3.5" />}
      </IconButton>

      {isUser ? (
        <IconButton size="icon-sm" label="Edit and resend" onClick={onEdit} disabledReason={unavailable}>
          <EditIcon className="size-3.5" />
        </IconButton>
      ) : (
        <>
          <IconButton
            size="icon-sm"
            label="Regenerate"
            onClick={() => onRetry()}
            disabledReason={unavailable}
          >
            <RetryIcon className="size-3.5" />
          </IconButton>

          <Menu
            label="Regenerate with a different model"
            align="start"
            trigger={(props) => (
              <IconButton
                {...props}
                size="icon-sm"
                label="Regenerate with another model"
                disabledReason={models.length === 0 ? 'The model catalog has not loaded.' : unavailable}
              >
                <ModelIcon className="size-3.5" />
              </IconButton>
            )}
          >
            <MenuLabel>Regenerate with</MenuLabel>
            {models.map((model) => (
              <MenuItem
                key={model.id}
                selected={model.id === message.model}
                onSelect={() => onRetry({ model: model.id })}
                disabledReason={model.lockedReason ?? undefined}
              >
                {model.name}
              </MenuItem>
            ))}
          </Menu>
        </>
      )}

      <IconButton
        size="icon-sm"
        label="Branch a new conversation from here"
        onClick={onFork}
        disabledReason={unavailable}
      >
        <ForkIcon className="size-3.5" />
      </IconButton>
    </div>
  );
}
