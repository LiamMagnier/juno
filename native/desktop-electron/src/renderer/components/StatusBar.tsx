/**
 * The status bar.
 *
 * A single 24px strip carrying the four things that are true regardless of
 * which pane is in front: whether we are connected, what the agent host is
 * doing, which workspace is in play, and who is signed in. It is the answer to
 * "is it me or is it broken", and it is why none of those facts need to be
 * repeated inside every pane.
 *
 * Nothing here is a control. A status bar that is also a toolbar is a status
 * bar the user is afraid to click.
 */

import type { ReactNode } from 'react';
import { useShell } from '../state/shell-state.js';
import { useSystem } from '../state/system-state.js';
import { useWorkspaces } from '../state/workspaces.js';
import { Meta, StatusDot } from './primitives/atoms.js';

export function StatusBar(): ReactNode {
  const { connected, host, auth, appInfo } = useSystem();
  const { productMode, chatSurface } = useShell();
  const { active } = useWorkspaces();

  return (
    <footer
      className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-background px-3"
      aria-label="Status"
    >
      {!connected ? (
        <span className="flex items-center gap-1.5">
          <StatusDot tone="critical" />
          <Meta className="text-destructive">Disconnected from the main process</Meta>
        </span>
      ) : (
        <span className="flex items-center gap-1.5">
          <StatusDot
            tone={
              host.status === 'running'
                ? 'active'
                : host.status === 'starting'
                  ? 'pending'
                  : host.status === 'crashed'
                    ? 'critical'
                    : 'idle'
            }
          />
          <Meta>Agent host {host.status}</Meta>
        </span>
      )}

      <span aria-hidden="true" className="h-3 w-px bg-border" />

      <Meta className="min-w-0 truncate">
        {productMode === 'code'
          ? (active?.path ?? 'No workspace')
          : chatSurface === 'work'
            ? 'Work'
            : 'Chat'}
      </Meta>

      <span className="ml-auto flex items-center gap-3">
        <Meta className="truncate">
          {auth.status === 'signed-in'
            ? (auth.displayName ?? auth.email)
            : auth.status === 'signing-in'
              ? 'Signing in…'
              : auth.status === 'unauthorized'
                ? 'Session rejected'
                : 'Signed out'}
        </Meta>
        {appInfo ? (
          <>
            <span aria-hidden="true" className="h-3 w-px bg-border" />
            <Meta>
              {appInfo.version} · api {appInfo.contractVersion}
            </Meta>
          </>
        ) : null}
      </span>
    </footer>
  );
}
