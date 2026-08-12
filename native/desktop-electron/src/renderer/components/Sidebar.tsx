/**
 * The sidebar, and the sections that belong to each product mode.
 *
 * Collapsing unmounts rather than hiding. A zero-width panel that is still in
 * the DOM keeps its tab stops, so a keyboard user tabs into a sidebar they
 * cannot see and lands on controls that are not there — the classic bug of
 * animated drawers. Unmounting also means the exit animation is the only place
 * that has to know about the transition.
 *
 * The inner column has a fixed pixel width while the wrapper animates, so the
 * contents do not reflow during the collapse. Text that re-wraps 60 times in
 * 220ms is the difference between a panel that slides and a panel that thrashes.
 *
 * Content is real where the contract allows it to be. Code mode drives
 * `workspace:list` / `workspace:choose` / `workspace:set-trust` and has genuine
 * loading, empty, error and pending states. Chat and Work have no IPC channels
 * in this contract at all, so rather than draw fake rows they state what is
 * missing and disable their controls *with a reason* — a placeholder that lies
 * about being wired costs more to remove later than one that admits what it is.
 */

import type { ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../lib/cn.js';
import type { Workspace } from '../../shared/ipc.js';
import { useShell } from '../state/shell-state.js';
import { useMotionProfile } from '../state/system-state.js';
import { useWorkspaces } from '../state/workspaces.js';
import { Button, IconButton } from './primitives/Button.js';
import { EmptyState, Meta, SectionLabel, Spinner, StatusDot } from './primitives/atoms.js';
import { AlertIcon, BranchIcon, FolderIcon, LockIcon, PlusIcon, RefreshIcon, ShieldIcon } from './icons.js';

const CHAT_UNAVAILABLE =
  'Conversation history is served by the Juno backend. This build has no IPC channel for it yet.';
const WORK_UNAVAILABLE = 'Work runs are served by the Juno backend. This build has no IPC channel for it yet.';

export function Sidebar(): ReactNode {
  const { sidebarCollapsed, sidebarWidth, productMode, chatSurface } = useShell();
  const motionProfile = useMotionProfile();

  const transition = motionProfile.reduced ? { duration: 0 } : motionProfile.transition.panel;

  return (
    <AnimatePresence initial={false}>
      {sidebarCollapsed ? null : (
        <motion.aside
          key="sidebar"
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: sidebarWidth, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={transition}
          className="relative shrink-0 overflow-hidden bg-sidebar text-sidebar-foreground"
        >
          <nav
            aria-label="Sidebar"
            className="flex h-full flex-col overflow-y-auto py-3"
            style={{ width: sidebarWidth }}
          >
            {productMode === 'code' ? (
              <CodeSections />
            ) : chatSurface === 'work' ? (
              <WorkSections />
            ) : (
              <ChatSections />
            )}
          </nav>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

/* -------------------------------------------------------------------------- */
/* Code                                                                        */
/* -------------------------------------------------------------------------- */

function CodeSections(): ReactNode {
  const { status, items, error, choosing, refresh, choose } = useWorkspaces();

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 pr-2">
        <SectionLabel id="sidebar-workspaces">Workspaces</SectionLabel>
        <div className="flex items-center gap-0.5">
          <IconButton
            label="Reload workspaces"
            size="sm"
            icon={<RefreshIcon className="h-3.5 w-3.5" />}
            onClick={refresh}
            loading={status === 'loading'}
          />
          <IconButton
            label="Open a folder as a workspace"
            size="sm"
            icon={<PlusIcon className="h-3.5 w-3.5" />}
            onClick={choose}
            loading={choosing}
          />
        </div>
      </div>

      {status === 'loading' ? (
        <p className="flex items-center gap-2 px-3 py-4 text-xs text-muted-foreground">
          <Spinner className="h-3.5 w-3.5" />
          Reading recent workspaces…
        </p>
      ) : null}

      {status === 'error' ? (
        <div className="mx-2 mt-1 rounded-card border border-border bg-muted/50 p-3">
          <p className="flex items-start gap-2 text-xs text-destructive">
            <AlertIcon className="mt-px h-3.5 w-3.5 shrink-0" />
            <span className="leading-relaxed">{error ?? 'The workspace list could not be read.'}</span>
          </p>
          <Button size="sm" variant="secondary" className="mt-2" onClick={refresh}>
            Try again
          </Button>
        </div>
      ) : null}

      {status === 'ready' && items.length === 0 ? (
        <EmptyState
          title="No workspaces yet"
          description="Open a folder to start. Juno never runs anything in it until you mark it trusted."
          action={
            <Button
              size="sm"
              variant="secondary"
              icon={<FolderIcon className="h-3.5 w-3.5" />}
              onClick={choose}
              loading={choosing}
            >
              Open folder…
            </Button>
          }
        />
      ) : null}

      {status === 'ready' && items.length > 0 ? (
        <ul aria-labelledby="sidebar-workspaces" className="mt-1 flex flex-col px-1.5">
          {items.map((workspace, index) => (
            <WorkspaceRow key={workspace.id} workspace={workspace} index={index} />
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function WorkspaceRow({ workspace, index }: { workspace: Workspace; index: number }): ReactNode {
  const { activeWorkspaceId, setActiveWorkspace } = useShell();
  const { trustPendingId, setTrust } = useWorkspaces();
  const motionProfile = useMotionProfile();
  const selected = workspace.id === activeWorkspaceId;
  const pending = trustPendingId === workspace.id;

  return (
    <motion.li
      className="group relative flex items-center"
      custom={index}
      variants={motionProfile.listItem}
      initial="hidden"
      animate="visible"
    >
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => setActiveWorkspace(workspace.id)}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-2 rounded-control px-1.5 py-1.5 text-left transition-colors',
          'duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'focus-visible:ring-offset-1 focus-visible:ring-offset-sidebar',
          selected ? 'bg-muted' : 'hover:bg-muted/60 active:bg-muted',
        )}
      >
        {/* The selected marker is a coral rule, not a colour change: it reads at
            a glance down a list of twenty and survives every contrast mode. */}
        <span
          aria-hidden="true"
          className={cn('h-6 w-0.5 shrink-0 rounded-full', selected ? 'bg-primary' : 'bg-transparent')}
        />
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate text-[13px] leading-tight',
              selected ? 'text-foreground' : 'text-foreground/85',
            )}
          >
            {workspace.name}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            {workspace.isGitRepository && workspace.branch ? (
              <>
                <BranchIcon className="h-3 w-3 text-muted-foreground" />
                <Meta className="truncate">{workspace.branch}</Meta>
              </>
            ) : (
              <Meta className="truncate">{workspace.path}</Meta>
            )}
          </span>
        </span>
        {!workspace.trusted ? (
          <span className="flex shrink-0 items-center gap-1 rounded-xs border border-border px-1 py-px">
            <LockIcon className="h-3 w-3 text-muted-foreground" />
            <span className="font-mono text-caption uppercase tracking-wide text-muted-foreground">
              Untrusted
            </span>
          </span>
        ) : null}
      </button>

      {/* Kept outside the row button: nesting a button inside a button is
          invalid, and screen readers resolve it unpredictably. */}
      <span className="pr-1">
        <IconButton
          size="sm"
          label={workspace.trusted ? `Revoke trust for ${workspace.name}` : `Trust ${workspace.name}`}
          icon={<ShieldIcon className="h-3.5 w-3.5" />}
          pressed={workspace.trusted}
          loading={pending}
          tooltipPlacement="right"
          onClick={() => setTrust(workspace.id, !workspace.trusted)}
          className={cn(
            'opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100',
            workspace.trusted && 'opacity-100',
          )}
        />
      </span>
    </motion.li>
  );
}

/* -------------------------------------------------------------------------- */
/* Chat and Work                                                               */
/* -------------------------------------------------------------------------- */

function ChatSections(): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 pr-2">
        <SectionLabel>Conversations</SectionLabel>
        <IconButton
          label="New conversation"
          size="sm"
          icon={<PlusIcon className="h-3.5 w-3.5" />}
          disabledReason={CHAT_UNAVAILABLE}
        />
      </div>
      <EmptyState
        title="No conversations in this window"
        description="Chat history lives in your Juno account and appears here once the desktop client is signed in and syncing."
      />

      <div className="mt-4">
        <SectionLabel>Projects</SectionLabel>
        <EmptyState title="No projects" description="Projects group conversations and their files." />
      </div>
    </div>
  );
}

function WorkSections(): ReactNode {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 pr-2">
        <SectionLabel>Runs</SectionLabel>
        <IconButton
          label="Start a run"
          size="sm"
          icon={<PlusIcon className="h-3.5 w-3.5" />}
          disabledReason={WORK_UNAVAILABLE}
        />
      </div>
      <EmptyState
        title="No runs yet"
        description="A run is a piece of work Juno carries out on your behalf and reports back on."
      />

      <div className="mt-4 flex items-center gap-2 px-3">
        <StatusDot tone="idle" />
        <Meta>Queue idle</Meta>
      </div>
    </div>
  );
}
