/**
 * The inspector.
 *
 * The pane for facts rather than actions: what this build is, what the agent
 * host is doing, what the backend said last time anyone asked. It is the pane a
 * support conversation is conducted through, which is why every value in it is
 * mono and selectable — someone is going to copy these into a bug report.
 *
 * Diagnostics are fetched when the pane opens, not on an interval. A snapshot
 * that refreshes itself every two seconds cannot be read, cannot be copied
 * reliably, and turns a diagnostic surface into a source of load.
 */

import { useEffect, type ReactNode } from 'react';
import { motion } from 'framer-motion';
import { cn } from '../lib/cn.js';
import { useShell } from '../state/shell-state.js';
import { useMotionProfile, useSystem } from '../state/system-state.js';
import { useWorkspaces } from '../state/workspaces.js';
import { useCodeSession } from '../state/code-session.js';
import { IconButton } from './primitives/Button.js';
import { EmptyState, SectionLabel, Spinner, StatusDot } from './primitives/atoms.js';
import { AlertIcon, CloseIcon, RefreshIcon } from './icons.js';

export function Inspector(): ReactNode {
  const { inspectorWidth, toggleInspector, productMode } = useShell();
  const { appInfo, appearance, host, diagnostics, diagnosticsError, diagnosticsPending, refreshDiagnostics } =
    useSystem();
  const motionProfile = useMotionProfile();
  const { active } = useWorkspaces();
  const session = useCodeSession();

  useEffect(() => {
    refreshDiagnostics();
  }, [refreshDiagnostics]);

  return (
    <motion.aside
      aria-label="Inspector"
      variants={motionProfile.sidePanel}
      initial="hidden"
      animate="visible"
      className="flex shrink-0 flex-col overflow-hidden bg-card"
      style={{ width: inspectorWidth }}
    >
      <header className="flex h-9 shrink-0 items-center justify-between border-b border-border pl-3 pr-1.5">
        <h2 className="font-mono text-label uppercase text-muted-foreground">Inspector</h2>
        <div className="flex items-center gap-0.5">
          <IconButton
            size="sm"
            label="Refresh diagnostics"
            icon={<RefreshIcon className="h-3.5 w-3.5" />}
            loading={diagnosticsPending}
            onClick={refreshDiagnostics}
          />
          <IconButton
            size="sm"
            label="Hide inspector"
            icon={<CloseIcon className="h-3.5 w-3.5" />}
            onClick={toggleInspector}
            tooltipPlacement="left"
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto py-3">
        {productMode === 'code' ? (
          <Group label="Session">
            {session.sessionId ? (
              <>
                <Row name="id" value={session.sessionId} />
                <Row name="phase" value={session.phase} />
                <Row name="mode" value={session.mode} />
                <Row name="tokens in" value={session.tokensIn.toLocaleString()} />
                <Row name="tokens out" value={session.tokensOut.toLocaleString()} />
                <Row name="approvals" value={String(session.approvals.length)} />
              </>
            ) : (
              <EmptyState title="No session" description="Start one from Code mode to see its state here." />
            )}
          </Group>
        ) : null}

        {productMode === 'code' ? (
          <Group label="Workspace">
            {active ? (
              <>
                <Row name="name" value={active.name} />
                <Row name="path" value={active.path} />
                <Row name="trusted" value={active.trusted ? 'yes' : 'no'} />
                <Row name="git" value={active.isGitRepository ? (active.branch ?? 'detached') : 'not a repository'} />
              </>
            ) : (
              <EmptyState title="No workspace selected" />
            )}
          </Group>
        ) : null}

        <Group label="Agent host">
          <div className="flex items-center gap-2 px-3 py-1">
            <StatusDot tone={hostTone(host.status)} />
            <span className="text-xs text-foreground">{host.status}</span>
          </div>
          {host.detail ? <p className="px-3 text-caption leading-relaxed text-muted-foreground">{host.detail}</p> : null}
        </Group>

        <Group label="Diagnostics">
          {diagnosticsPending && !diagnostics ? (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
              <Spinner className="h-3.5 w-3.5" />
              Collecting…
            </p>
          ) : null}

          {diagnosticsError ? (
            <p className="flex items-start gap-2 px-3 py-2 text-xs leading-relaxed text-destructive">
              <AlertIcon className="mt-px h-3.5 w-3.5 shrink-0" />
              {diagnosticsError}
            </p>
          ) : null}

          {diagnostics ? (
            <>
              <Row name="backend" value={diagnostics.backendReachable ? 'reachable' : 'unreachable'} />
              <Row name="origin" value={diagnostics.backendOrigin} />
              <Row name="auth" value={diagnostics.authStatus} />
              <Row name="sync cursor" value={diagnostics.syncCursor ?? '—'} />
              <Row name="outbox" value={String(diagnostics.outboxDepth)} />
              <Row name="host restarts" value={String(diagnostics.agentHostRestarts)} />
              <Row name="database" value={diagnostics.databaseHealthy ? 'healthy' : 'unhealthy'} />
            </>
          ) : null}
        </Group>

        <Group label="Build">
          {appInfo ? (
            <>
              <Row name="version" value={appInfo.version} />
              <Row name="contract" value={appInfo.contractVersion} />
              <Row name="electron" value={appInfo.electronVersion} />
              <Row name="chrome" value={appInfo.chromeVersion} />
              <Row name="platform" value={`${appInfo.platform} ${appInfo.arch}`} />
              <Row name="packaged" value={appInfo.isPackaged ? 'yes' : 'no'} />
            </>
          ) : (
            <EmptyState title="Build information unavailable" />
          )}
        </Group>

        <Group label="Appearance">
          <Row name="dark" value={appearance.shouldUseDarkColors ? 'yes' : 'no'} />
          <Row name="reduce motion" value={appearance.reduceMotion ? 'on' : 'off'} />
          <Row name="reduce transparency" value={appearance.reduceTransparency ? 'on' : 'off'} />
          <Row name="increase contrast" value={appearance.increaseContrast ? 'on' : 'off'} />
          <Row name="accent" value={appearance.accentColor ?? 'system default'} />
        </Group>
      </div>
    </motion.aside>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <section>
      <SectionLabel className="mb-1.5">{label}</SectionLabel>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

/**
 * One fact.
 *
 * A description list, not a table: these are name/value pairs and `<dl>` is
 * what announces them as such. The value is `select-text` because the entire
 * point of this pane is that someone can copy what is in it.
 */
function Row({ name, value, className }: { name: string; value: string; className?: string | undefined }): ReactNode {
  return (
    <dl className={cn('flex items-baseline gap-3 px-3 py-0.5', className)}>
      <dt className="w-28 shrink-0 truncate font-mono text-caption text-muted-foreground">{name}</dt>
      <dd className="min-w-0 flex-1 select-text truncate font-mono text-caption text-foreground/90" title={value}>
        {value}
      </dd>
    </dl>
  );
}

function hostTone(status: string): 'active' | 'idle' | 'pending' | 'critical' {
  switch (status) {
    case 'running':
      return 'active';
    case 'starting':
      return 'pending';
    case 'crashed':
      return 'critical';
    default:
      return 'idle';
  }
}
