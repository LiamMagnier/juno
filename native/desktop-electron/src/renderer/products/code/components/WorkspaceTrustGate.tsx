/**
 * Workspace trust.
 *
 * `WorkspaceSchema.trusted` is never defaulted to true anywhere in this
 * codebase, and this gate is why that holds at the UI layer: an untrusted
 * workspace renders this screen *instead of* the session, so there is no path
 * where a prompt can be sent into a folder the user has not vouched for.
 *
 * The gate is deliberately not a dismissible banner. A banner over a working
 * composer is a banner people type past. It is also deliberately not one click:
 * the confirmation checkbox exists so that trusting a folder is an action a
 * user takes, not one they complete by muscle memory on a button that happens
 * to be where "Continue" usually is.
 *
 * The copy states the actual threat — repository content is untrusted input
 * that the agent will read, and in Code mode act on — rather than a generic
 * "do you trust the authors of this folder".
 */

import { useState, type JSX } from 'react';
import { cn } from '../lib/cn.js';
import { Button, FOCUS_RING, Mono } from './primitives.js';
import { FolderIcon, LockIcon, ShieldIcon } from './icons.js';

export interface WorkspaceTrustGateProps {
  name: string;
  path: string;
  isGitRepository: boolean;
  branch: string | null;
  onTrust: () => void;
  onChooseAnother: () => void;
  busy: boolean;
  error: string | null;
  className?: string;
}

export function WorkspaceTrustGate({
  name,
  path,
  isGitRepository,
  branch,
  onTrust,
  onChooseAnother,
  busy,
  error,
  className,
}: WorkspaceTrustGateProps): JSX.Element {
  const [acknowledged, setAcknowledged] = useState(false);

  return (
    <div
      className={cn('flex min-h-0 flex-1 items-center justify-center bg-background p-6', className)}
      role="region"
      aria-label="Workspace not trusted"
    >
      <div className="w-full max-w-lg rounded-lg border border-border bg-card">
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <LockIcon className="h-4 w-4 shrink-0 text-primary" />
          <h2 className="text-[14px] font-semibold text-foreground">This workspace is not trusted</h2>
        </header>

        <div className="space-y-3 px-4 py-3.5">
          <div className="flex items-start gap-2 rounded-md border border-border bg-background px-2.5 py-2">
            <FolderIcon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate text-[13px] font-medium text-foreground">{name}</p>
              <Mono className="block truncate text-muted-foreground" title={path}>
                {path}
              </Mono>
              <Mono className="mt-0.5 block text-muted-foreground">
                {isGitRepository ? `git · ${branch ?? 'detached HEAD'}` : 'not a git repository'}
              </Mono>
            </div>
          </div>

          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            No agent session can start here until you trust this folder. Until then the composer,
            the permission modes and every tool are disabled.
          </p>

          <div className="rounded-md border border-border bg-background px-2.5 py-2">
            <p className="mb-1 flex items-center gap-1.5 text-[12px] font-medium text-foreground">
              <ShieldIcon className="h-3.5 w-3.5 text-primary" />
              What trusting this folder allows
            </p>
            <ul className="space-y-1 text-[12px] leading-snug text-muted-foreground">
              <li>
                The agent reads files here, including anything the repository’s authors wrote. File
                content is untrusted input — a repository can contain text aimed at the agent.
              </li>
              <li>
                In Code mode the agent edits files in this folder without asking each time.
              </li>
              <li>
                Shell commands run as your user, with your environment, in this directory.
                Destructive commands are still confirmed individually.
              </li>
            </ul>
          </div>

          <label
            className={cn(
              'flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-muted',
              busy && 'cursor-not-allowed opacity-50',
            )}
          >
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={busy}
              onChange={(event) => setAcknowledged(event.target.checked)}
              className={cn('mt-[3px] h-3.5 w-3.5 accent-primary', FOCUS_RING)}
            />
            <span className="text-[12.5px] leading-snug text-foreground">
              I know where this folder came from and I want the agent to work in it.
            </span>
          </label>

          {error !== null ? (
            <p
              role="alert"
              className="rounded-md border border-destructive/50 bg-destructive/5 px-2.5 py-1.5 text-[12px] text-destructive"
            >
              {error}
            </p>
          ) : null}
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-4 py-3">
          <Button variant="ghost" onClick={onChooseAnother} disabled={busy}>
            Choose another folder…
          </Button>
          <span className="flex-1" />
          <Button
            variant="primary"
            onClick={onTrust}
            disabled={!acknowledged || busy}
            disabledReason={
              busy ? 'Working…' : 'Confirm you know where this folder came from first.'
            }
          >
            {busy ? 'Trusting…' : 'Trust this workspace'}
          </Button>
        </footer>
      </div>
    </div>
  );
}
