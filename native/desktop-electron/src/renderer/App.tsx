/**
 * The application shell.
 *
 * Provider order is a dependency order, not a preference: the announcer is
 * outermost because system state announces auth and host changes through it;
 * shell state sits above workspaces because the active workspace id lives in
 * the shell and the workspace list resolves it; the code session is innermost
 * because it is the only consumer of all three.
 *
 * Below the providers there are exactly three top-level outcomes, and they are
 * mutually exclusive by design:
 *
 *   - **starting** — one round trip to main has not come back yet
 *   - **unreachable** — it came back wrong, or preload never ran
 *   - **signed out / signing in / rejected** — reachable, but not usable yet
 *
 * Only the fourth case draws panes. The title bar and status bar are outside
 * that switch and are drawn in every one of them, because a window with no
 * title bar cannot be moved and a window with no status bar cannot tell you why
 * it is stuck.
 */

import type { ReactNode } from 'react';
import { MotionConfig } from 'framer-motion';
import { AnnouncerProvider } from './state/announcer.js';
import { CodeSessionProvider } from './state/code-session.js';
import {
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
  ShellStateProvider,
  useShell,
} from './state/shell-state.js';
import { SystemStateProvider, useSystem } from './state/system-state.js';
import { WorkspacesProvider } from './state/workspaces.js';
import { AuthGate } from './components/AuthGate.js';
import { CommandPalette } from './components/CommandPalette.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';
import { Inspector } from './components/Inspector.js';
import { MainPane } from './components/MainPane.js';
import { ResizeHandle } from './components/ResizeHandle.js';
import { Sidebar } from './components/Sidebar.js';
import { StatusBar } from './components/StatusBar.js';
import { TitleBar } from './components/TitleBar.js';
import { Button } from './components/primitives/Button.js';
import { Meta, Spinner } from './components/primitives/atoms.js';
import { AlertIcon } from './components/icons.js';

export default function App(): ReactNode {
  return (
    <ErrorBoundary>
      <AnnouncerProvider>
        <SystemStateProvider>
          <ShellStateProvider>
            <WorkspacesProvider>
              <CodeSessionProvider>
                <Shell />
              </CodeSessionProvider>
            </WorkspacesProvider>
          </ShellStateProvider>
        </SystemStateProvider>
      </AnnouncerProvider>
    </ErrorBoundary>
  );
}

function Shell(): ReactNode {
  const { boot, motion } = useSystem();

  return (
    /* `reducedMotion="always"` is Framer's own opacity-only fallback, applied on
       top of the reduced variants in lib/motion.ts. Both, not either: the
       variants describe what the reduced design *is*, and this catches any
       animation that forgets to consult them. */
    <MotionConfig reducedMotion={motion.reduced ? 'always' : 'never'}>
      <div className="flex h-full flex-col overflow-hidden bg-background text-foreground" aria-busy={boot === 'loading'}>
        <TitleBar />
        <Body />
        <StatusBar />
        <CommandPalette />
      </div>
    </MotionConfig>
  );
}

function Body(): ReactNode {
  const { boot, bootError, retryBoot, auth } = useSystem();

  if (boot === 'loading') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background">
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner className="h-4 w-4" />
          Starting Juno…
        </p>
      </div>
    );
  }

  if (boot === 'error') {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center bg-background px-6">
        <div className="max-w-md">
          <span className="mb-4 inline-flex h-9 w-9 items-center justify-center rounded-field border border-border bg-card text-muted-foreground">
            <AlertIcon className="h-4 w-4" />
          </span>
          <h1 className="font-serif text-title text-foreground">Juno cannot reach its main process</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
            Every privileged operation — files, credentials, the agent host — happens outside this window, and
            the connection to it is not answering. Nothing has been lost; the interface simply has nothing to
            talk to.
          </p>
          {bootError ? <Meta className="mt-3 block break-words">{bootError}</Meta> : null}
          <div className="mt-5">
            <Button variant="primary" onClick={retryBoot}>
              Try again
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (auth.status !== 'signed-in') return <AuthGate auth={auth} />;

  return <Panes />;
}

function Panes(): ReactNode {
  const {
    sidebarCollapsed,
    sidebarWidth,
    setSidebarWidth,
    inspectorOpen,
    inspectorWidth,
    setInspectorWidth,
  } = useShell();

  return (
    <div className="flex min-h-0 flex-1">
      <Sidebar />
      {sidebarCollapsed ? null : (
        <ResizeHandle
          label="Sidebar width"
          side="start"
          value={sidebarWidth}
          min={SIDEBAR_MIN_WIDTH}
          max={SIDEBAR_MAX_WIDTH}
          onChange={setSidebarWidth}
          onReset={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        />
      )}

      <MainPane />

      {inspectorOpen ? (
        <>
          <ResizeHandle
            label="Inspector width"
            side="end"
            value={inspectorWidth}
            min={INSPECTOR_MIN_WIDTH}
            max={INSPECTOR_MAX_WIDTH}
            onChange={setInspectorWidth}
            onReset={() => setInspectorWidth(INSPECTOR_DEFAULT_WIDTH)}
          />
          <Inspector />
        </>
      ) : null}
    </div>
  );
}
