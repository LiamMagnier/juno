/**
 * The conversation list.
 *
 * A list of rows, not a list of cards. Every row is one line of title plus one
 * line of preview, on a shared background, separated by nothing — the hover and
 * selected states do the work that borders would otherwise do badly. Cards here
 * would give a sidebar of forty conversations forty separate containers to
 * parse.
 *
 * The interaction details that matter:
 *
 *   · **Rename happens in place**, replacing the title with an input at the
 *     same size and position. Enter commits, Escape reverts, blur commits —
 *     because a rename field that discards on blur loses work the moment the
 *     user clicks the row they were renaming it to match.
 *   · **Delete confirms inline**, in the row, rather than in a modal. The
 *     modal costs a focus trap, a backdrop and a context switch to confirm a
 *     one-word question about a row that is already on screen.
 *   · **The row is a button; the menu is a button inside it.** Nesting the
 *     second inside the first would be invalid HTML and, worse, would make the
 *     menu unreachable by keyboard. They are siblings in a positioned wrapper.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { Conversation } from '../contract.js';
import { cn } from '../lib/cn.js';
import type { ConversationListApi } from '../state/use-conversations.js';
import {
  ArchiveIcon,
  EditIcon,
  MoreIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
} from './icons.js';
import { Button, Eyebrow, IconButton, Menu, MenuItem, MenuSeparator } from './primitives.js';
import { EmptyConversationList, NoSearchResults } from './states.js';

export interface ConversationListProps {
  readonly api: ConversationListApi;
  readonly activeId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onNew: () => void;
  readonly className?: string | undefined;
}

export function ConversationList({
  api,
  activeId,
  onSelect,
  onNew,
  className,
}: ConversationListProps): ReactNode {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const pinned = api.conversations.filter((conversation) => conversation.pinned);
  const rest = api.conversations.filter((conversation) => !conversation.pinned);
  const empty = api.conversations.length === 0 && !api.loading;

  return (
    <nav
      aria-label="Conversations"
      className={cn('flex min-h-0 flex-col border-r border-sidebar-border bg-sidebar', className)}
    >
      <div className="flex items-center gap-1 px-3 pb-2 pt-3">
        <div className="relative min-w-0 flex-1">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            ref={searchRef}
            type="search"
            value={api.query}
            onChange={(event) => api.setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && api.query.length > 0) {
                event.preventDefault();
                api.setQuery('');
              }
            }}
            placeholder="Search titles"
            aria-label="Search conversations by title"
            className={cn(
              'h-8 w-full rounded-control border border-border bg-background pl-8 pr-2',
              'text-caption text-foreground placeholder:text-muted-foreground',
              'outline-none focus-visible:border-ring',
            )}
          />
        </div>
        <IconButton size="icon" label="New conversation" onClick={onNew}>
          <PlusIcon className="size-4" />
        </IconButton>
      </div>

      {api.error !== null ? (
        <p role="alert" className="mx-3 mb-2 rounded-card border border-border px-2.5 py-2 text-caption text-destructive-ink">
          {api.error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {empty && api.query.length > 0 ? (
          <NoSearchResults query={api.query} onClear={() => api.setQuery('')} />
        ) : empty ? (
          <EmptyConversationList onNew={onNew} />
        ) : (
          <>
            {pinned.length > 0 ? (
              <>
                <div className="px-2 pb-1 pt-2">
                  <Eyebrow>Pinned</Eyebrow>
                </div>
                {pinned.map((conversation) => (
                  <Row
                    key={conversation.id}
                    conversation={conversation}
                    active={conversation.id === activeId}
                    renaming={renamingId === conversation.id}
                    confirming={confirmingId === conversation.id}
                    onSelect={onSelect}
                    onStartRename={setRenamingId}
                    onEndRename={() => setRenamingId(null)}
                    onStartConfirm={setConfirmingId}
                    onEndConfirm={() => setConfirmingId(null)}
                    api={api}
                  />
                ))}
              </>
            ) : null}

            {rest.length > 0 && pinned.length > 0 ? (
              <div className="px-2 pb-1 pt-4">
                <Eyebrow>Recent</Eyebrow>
              </div>
            ) : null}

            {rest.map((conversation) => (
              <Row
                key={conversation.id}
                conversation={conversation}
                active={conversation.id === activeId}
                renaming={renamingId === conversation.id}
                confirming={confirmingId === conversation.id}
                onSelect={onSelect}
                onStartRename={setRenamingId}
                onEndRename={() => setRenamingId(null)}
                onStartConfirm={setConfirmingId}
                onEndConfirm={() => setConfirmingId(null)}
                api={api}
              />
            ))}
          </>
        )}
      </div>

      <div className="border-t border-sidebar-border px-3 py-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => api.setShowArchived(!api.showArchived)}
          className="w-full justify-start gap-2"
        >
          <ArchiveIcon className="size-3.5" />
          {api.showArchived ? 'Hide archived' : 'Show archived'}
        </Button>
      </div>
    </nav>
  );
}

/* -------------------------------------------------------------------------- */
/* Row                                                                         */
/* -------------------------------------------------------------------------- */

interface RowProps {
  readonly conversation: Conversation;
  readonly active: boolean;
  readonly renaming: boolean;
  readonly confirming: boolean;
  readonly onSelect: (id: string) => void;
  readonly onStartRename: (id: string) => void;
  readonly onEndRename: () => void;
  readonly onStartConfirm: (id: string) => void;
  readonly onEndConfirm: () => void;
  readonly api: ConversationListApi;
}

function Row({
  conversation,
  active,
  renaming,
  confirming,
  onSelect,
  onStartRename,
  onEndRename,
  onStartConfirm,
  onEndConfirm,
  api,
}: RowProps): ReactNode {
  const archived = conversation.archivedAt !== null;

  if (renaming) {
    return (
      <RenameField
        initial={conversation.title}
        onCancel={onEndRename}
        onCommit={(title) => {
          onEndRename();
          if (title.length > 0 && title !== conversation.title) void api.rename(conversation.id, title);
        }}
      />
    );
  }

  if (confirming) {
    return (
      <div className="mb-0.5 rounded-card border border-destructive/40 px-2.5 py-2">
        <p className="text-caption text-foreground">Delete “{conversation.title}”?</p>
        <p className="mt-0.5 text-caption text-muted-foreground">This cannot be undone.</p>
        <div className="mt-2 flex gap-1.5">
          <Button
            variant="destructive"
            size="sm"
            onClick={() => {
              onEndConfirm();
              void api.remove(conversation.id);
            }}
          >
            Delete
          </Button>
          <Button variant="ghost" size="sm" onClick={onEndConfirm}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="group/row relative mb-0.5">
      <button
        type="button"
        onClick={() => onSelect(conversation.id)}
        aria-current={active ? 'page' : undefined}
        className={cn(
          'flex w-full flex-col items-start gap-0.5 rounded-card px-2.5 py-2 pr-9 text-left',
          'transition-colors duration-fast ease-out-soft',
          active ? 'bg-sidebar-accent' : 'hover:bg-sidebar-accent/60',
        )}
      >
        <span className="flex w-full items-center gap-1.5">
          {conversation.pinned ? (
            <PinIcon filled className="size-3 shrink-0 text-muted-foreground" />
          ) : null}
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-caption',
              active ? 'text-foreground' : 'text-sidebar-foreground',
              archived && 'italic opacity-70',
            )}
          >
            {conversation.title}
          </span>
        </span>
        {conversation.preview.length > 0 ? (
          <span className="w-full truncate text-caption text-muted-foreground">{conversation.preview}</span>
        ) : null}
      </button>

      <div className="absolute right-1 top-1.5">
        <Menu
          label={`Actions for ${conversation.title}`}
          align="end"
          trigger={(props) => (
            <IconButton
              {...props}
              size="icon-sm"
              label="Conversation actions"
              className={cn(
                'opacity-0 transition-opacity duration-fast',
                'group-hover/row:opacity-100 focus-visible:opacity-100',
                props['aria-expanded'] && 'opacity-100',
              )}
            >
              <MoreIcon className="size-3.5" />
            </IconButton>
          )}
        >
          <MenuItem icon={<EditIcon className="size-3.5" />} onSelect={() => onStartRename(conversation.id)}>
            Rename
          </MenuItem>
          <MenuItem
            icon={<PinIcon filled={conversation.pinned} className="size-3.5" />}
            onSelect={() => void api.setPinned(conversation.id, !conversation.pinned)}
          >
            {conversation.pinned ? 'Unpin' : 'Pin to top'}
          </MenuItem>
          <MenuItem
            icon={<ArchiveIcon className="size-3.5" />}
            onSelect={() => void api.setArchived(conversation.id, !archived)}
          >
            {archived ? 'Unarchive' : 'Archive'}
          </MenuItem>
          <MenuSeparator />
          <MenuItem
            tone="destructive"
            icon={<TrashIcon className="size-3.5" />}
            onSelect={() => onStartConfirm(conversation.id)}
          >
            Delete
          </MenuItem>
        </Menu>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Rename                                                                      */
/* -------------------------------------------------------------------------- */

function RenameField({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (title: string) => void;
  onCancel: () => void;
}): ReactNode {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement | null>(null);
  /* Escape must not also fire the blur-commit that follows it. */
  const cancelled = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const commit = useCallback(() => {
    if (cancelled.current) return;
    onCommit(value.trim());
  }, [onCommit, value]);

  return (
    <div className="mb-0.5 px-0.5">
      <input
        ref={ref}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            cancelled.current = true;
            onCancel();
          }
        }}
        maxLength={200}
        aria-label="Conversation title"
        className={cn(
          'h-8 w-full rounded-card border border-ring bg-background px-2',
          'text-caption text-foreground outline-none',
        )}
      />
    </div>
  );
}
