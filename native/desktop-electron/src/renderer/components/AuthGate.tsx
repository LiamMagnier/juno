/**
 * The signed-out, signing-in and unauthorized screens.
 *
 * Three genuinely different situations, drawn as three genuinely different
 * screens rather than one screen with a swapped string:
 *
 *   - **signed-out** is an invitation. Nothing has gone wrong.
 *   - **signing-in** is a *waiting* state that happens somewhere else — the
 *     PKCE flow completes in the user's browser, and the most common failure is
 *     that the browser window went behind this one. So this screen says where
 *     to look, and offers to start again, because a spinner with no way out is
 *     how a sign-in becomes a force-quit.
 *   - **unauthorized** is a refusal, and it carries the reason main gave. It is
 *     styled as information rather than as an alarm: a rejected session is
 *     usually an expired one, and shouting about it helps nobody.
 *
 * The renderer never sees a token in any of these states. It asks main to begin
 * the flow and then watches `auth:changed`.
 */

import type { ReactNode } from 'react';
import type { AuthState } from '../../shared/ipc.js';
import { useSystem } from '../state/system-state.js';
import { Button } from './primitives/Button.js';
import { Meta, Spinner } from './primitives/atoms.js';
import { AlertIcon, LockIcon } from './icons.js';

export function AuthGate({ auth }: { auth: Exclude<AuthState, { status: 'signed-in' }> }): ReactNode {
  const { beginSignIn, signInPending, connected } = useSystem();
  const offline = connected ? undefined : 'Juno cannot reach its main process, so sign-in cannot start.';

  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-background px-6">
      <div className="w-full max-w-md">
        {auth.status === 'signing-in' ? (
          <>
            <span className="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-field border border-border bg-card text-muted-foreground">
              <Spinner className="h-4 w-4" />
            </span>
            <h1 className="font-serif text-title text-foreground">Finish signing in</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Juno opened your browser to complete sign-in. If you cannot see it, check behind this window —
              it may have opened underneath.
            </p>
            <div className="mt-5 flex items-center gap-2">
              <Button variant="secondary" onClick={beginSignIn} disabledReason={offline}>
                Open the browser again
              </Button>
            </div>
          </>
        ) : auth.status === 'unauthorized' ? (
          <>
            <span className="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-field border border-border bg-card text-muted-foreground">
              <AlertIcon className="h-4 w-4" />
            </span>
            <h1 className="font-serif text-title text-foreground">Your session was rejected</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              This usually means the session expired or was signed out from another device. Signing in again
              will fix it.
            </p>
            <Meta className="mt-3 block break-words">{auth.reason}</Meta>
            <div className="mt-5">
              <Button
                variant="primary"
                onClick={beginSignIn}
                loading={signInPending}
                disabledReason={offline}
              >
                Sign in again
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-field border border-border bg-card text-muted-foreground">
              <LockIcon className="h-4 w-4" />
            </span>
            <h1 className="font-serif text-title text-foreground">Sign in to Juno</h1>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              Your conversations, projects and workspaces are tied to your account. Sign-in happens in your
              browser; the credential is stored in the macOS Keychain and never enters this window.
            </p>
            <div className="mt-5">
              <Button
                variant="primary"
                onClick={beginSignIn}
                loading={signInPending}
                disabledReason={offline}
                icon={<LockIcon className="h-3.5 w-3.5" />}
              >
                Sign in
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
