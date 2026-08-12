/**
 * The Code product surface.
 *
 * Composition only: the header states the policy, the timeline answers "what
 * did it do", the rail answers "who did it", the diff answers "what changed",
 * and the dock answers "what does it need from me". Each of those owns its own
 * store channel, so they do not re-render each other.
 *
 * The component is self-sufficient by design. Given a `workspace` prop it uses
 * it; given nothing it loads the workspace list over IPC itself. That way the
 * app shell can mount it with or without having resolved a workspace, and this
 * file needs no knowledge of the shell's state shape — which matters because
 * the shell is owned elsewhere.
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import type { Workspace } from '@shared/ipc.js';
import { cn } from './lib/cn.js';
import { describeError, invoke, isBridgeAvailable } from './lib/bridge.js';
import type { PermissionMode } from './lib/contract.js';
import { reconstructEditFile, unavailableFile, type DiffFile } from './lib/diff.js';
import { useCodeSession, useStoreVersion } from './state/useCodeSession.js';
import { ActivityTimeline } from './components/ActivityTimeline.js';
import { ApprovalDock } from './components/ApprovalDock.js';
import { DiffReview } from './components/DiffReview.js';
import { SessionComposer } from './components/SessionComposer.js';
import { SessionHeader } from './components/SessionHeader.js';
import { SubagentPanel } from './components/SubagentPanel.js';
import { WorkspaceTrustGate } from './components/WorkspaceTrustGate.js';
import { Badge, Button, EmptyState, IconButton, Mono } from './components/primitives.js';
import { AgentsIcon, FolderIcon } from './components/icons.js';

export interface CodeProductProps {
  /** Supplied by the app shell when it already has one. Undefined = self-load. */
  workspace?: Workspace | null;
  /** Called after this surface changes the workspace, so the shell can re-read. */
  onWorkspaceChange?: (workspace: Workspace) => void;
  className?: string;
}

type Panel = 'activity' | 'changes';

export function CodeProduct({
  workspace: workspaceProp,
  onWorkspaceChange,
  className,
}: CodeProductProps): JSX.Element {
  const bridgeAvailable = useMemo(() => isBridgeAvailable(), []);
  const controlled = workspaceProp !== undefined;

  const [workspace, setWorkspace] = useState<Workspace | null>(workspaceProp ?? null);
  const [loadingWorkspaces, setLoadingWorkspaces] = useState(!controlled && bridgeAvailable);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);

  useEffect(() => {
    if (controlled) setWorkspace(workspaceProp ?? null);
  }, [controlled, workspaceProp]);

  useEffect(() => {
    if (controlled || !bridgeAvailable) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await invoke('workspace:list');
        if (cancelled) return;
        setWorkspace(list[0] ?? null);
      } catch (error) {
        if (!cancelled) setWorkspaceError(describeError(error));
      } finally {
        if (!cancelled) setLoadingWorkspaces(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [controlled, bridgeAvailable]);

  const applyWorkspace = useCallback(
    (next: Workspace): void => {
      setWorkspace(next);
      onWorkspaceChange?.(next);
    },
    [onWorkspaceChange],
  );

  const chooseWorkspace = useCallback(async (): Promise<void> => {
    setWorkspaceError(null);
    try {
      const chosen = await invoke('workspace:choose');
      if (chosen) applyWorkspace(chosen);
    } catch (error) {
      setWorkspaceError(describeError(error));
    }
  }, [applyWorkspace]);

  const trustWorkspace = useCallback(async (): Promise<void> => {
    if (!workspace) return;
    setTrustBusy(true);
    setWorkspaceError(null);
    try {
      const updated = await invoke('workspace:set-trust', {
        workspaceId: workspace.id,
        trusted: true,
      });
      applyWorkspace(updated);
    } catch (error) {
      setWorkspaceError(describeError(error));
    } finally {
      setTrustBusy(false);
    }
  }, [workspace, applyWorkspace]);

  const trusted = workspace?.trusted === true;

  const session = useCodeSession({
    workspaceId: workspace?.id ?? null,
    trusted,
  });
  const { store } = session;

  /* One subscription per concern. A token bumps only `stream`; an approval only
     `approvals`; neither re-renders the other's consumer. */
  const statusVersion = useStoreVersion(store, 'status');
  const sessionVersion = useStoreVersion(store, 'session');
  const approvalsVersion = useStoreVersion(store, 'approvals');
  const subagentsVersion = useStoreVersion(store, 'subagents');
  const changesVersion = useStoreVersion(store, 'changes');

  const [panel, setPanel] = useState<Panel>('activity');
  const [railOpen, setRailOpen] = useState(true);
  const [selectedSubagent, setSelectedSubagent] = useState<string | null>(null);
  const [focusCallId, setFocusCallId] = useState<string | null>(null);

  /* The external-store read pattern. `store.status` and friends are mutable
     fields; the version counter subscribed above is what causes this component
     to render, so the version IS the memo key. `exhaustive-deps` cannot see
     through a mutable class field and reads the dependency as unnecessary —
     removing it would freeze these values at their first-render snapshot. */
  /* eslint-disable react-hooks/exhaustive-deps -- version counters are the real inputs */
  const status = useMemo(() => store.status, [store, statusVersion]);
  const meta = useMemo(() => store.session, [store, sessionVersion]);
  const approvals = useMemo(() => [...store.pendingApprovals], [store, approvalsVersion]);
  const subagents = useMemo(() => [...store.subagents], [store, subagentsVersion]);
  /* eslint-enable react-hooks/exhaustive-deps */

  const cwd = meta.cwd ?? workspace?.path ?? '';

  /* Reviewable diffs, reconstructed from edit-tool inputs. See lib/diff.ts for
     why this is the only content-bearing source available to the renderer. */
  const diffFiles: DiffFile[] = useMemo(() => {
    const files: DiffFile[] = [];
    store.editCalls.forEach((call, index) => {
      if (call.status === 'denied') return;
      const file = reconstructEditFile(call.name, call.input, index);
      if (file) files.push(file);
    });
    const covered = new Set(files.map((file) => file.path));
    store.changedPaths.forEach((path, index) => {
      if (!covered.has(path)) files.push(unavailableFile(path, index));
    });
    return files;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `changesVersion` is the mutation signal for store.editCalls / store.changedPaths
  }, [store, changesVersion]);

  const contentFiles = useMemo(
    () => diffFiles.filter((file) => file.origin !== 'unavailable'),
    [diffFiles],
  );
  const unavailablePaths = useMemo(
    () => diffFiles.filter((file) => file.origin === 'unavailable').map((file) => file.path),
    [diffFiles],
  );

  const onModeChange = useCallback(
    (mode: PermissionMode) => {
      void session.setMode(mode);
    },
    [session],
  );

  const onAbort = useCallback(() => {
    void session.abort();
  }, [session]);

  const onSubmit = useCallback(
    (text: string) => {
      void session.sendPrompt(text);
    },
    [session],
  );

  const onReviewApproval = useCallback((callId: string) => {
    setFocusCallId(callId);
  }, []);

  const onReviewChanges = useCallback(() => {
    setPanel('changes');
  }, []);

  const onInspectSubagent = useCallback((id: string) => {
    setRailOpen(true);
    setSelectedSubagent(id);
  }, []);

  /* ---- gates ------------------------------------------------------------- */

  if (!bridgeAvailable) {
    return (
      <div className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}>
        <EmptyState
          title="Not connected"
          detail="This window has no IPC bridge, so no agent session can be started. Reopen the app window; if it persists, the preload script failed to load."
        />
      </div>
    );
  }

  if (loadingWorkspaces) {
    return (
      <div className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}>
        <EmptyState title="Loading workspaces…" detail="Reading the workspace list from the host." />
      </div>
    );
  }

  if (!workspace) {
    return (
      <div className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}>
        <EmptyState
          icon={<FolderIcon className="h-6 w-6" />}
          title="No workspace open"
          detail={
            workspaceError ??
            'Choose a folder for the agent to work in. The picker runs in the host process — this window cannot open a path on its own.'
          }
          action={
            <Button variant="primary" onClick={() => void chooseWorkspace()}>
              Choose a folder…
            </Button>
          }
        />
      </div>
    );
  }

  if (!trusted) {
    return (
      <div className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}>
        <WorkspaceTrustGate
          name={workspace.name}
          path={workspace.path}
          isGitRepository={workspace.isGitRepository}
          branch={workspace.branch}
          onTrust={() => void trustWorkspace()}
          onChooseAnother={() => void chooseWorkspace()}
          busy={trustBusy}
          error={workspaceError}
        />
      </div>
    );
  }

  /* ---- running surface --------------------------------------------------- */

  const running = status === 'thinking' || status === 'working' || status === 'starting';

  const blockedReason: string | null =
    session.hostStatus === 'crashed'
      ? 'The agent host crashed. Restart it before sending another message.'
      : session.start.phase === 'failed'
        ? `Session could not start: ${session.start.message}`
        : approvals.length > 0
          ? 'Answer the pending approval — the agent is blocked until you do.'
          : null;

  return (
    <div className={cn('flex min-h-0 flex-1 flex-col bg-background', className)}>
      <SessionHeader
        workspaceName={workspace.name}
        workspacePath={workspace.path}
        branch={workspace.branch}
        trusted={workspace.trusted}
        isGitRepository={workspace.isGitRepository}
        provider={meta.provider}
        model={meta.model}
        mode={meta.mode}
        status={status}
        hostStatus={session.hostStatus}
        bridgeAvailable={session.bridgeAvailable}
        usage={meta.usage}
        subagentUsage={meta.subagentUsage}
        onModeChange={onModeChange}
        onAbort={onAbort}
      />

      <div className="flex min-h-0 flex-1">
        {/* Escape stops the agent. Scoped to this column rather than the
            document so it cannot fight the header's popover, which closes on
            the same key. The composer's Stop button advertises the shortcut. */}
        <div
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          onKeyDown={(event) => {
            if (event.key !== 'Escape' || !running) return;
            event.preventDefault();
            onAbort();
          }}
        >
          {/* Panel switch. Two panels, not a tab bar of five. */}
          <div className="flex items-center gap-1 border-b border-border bg-background px-2 py-1">
            <PanelTab
              active={panel === 'activity'}
              onClick={() => setPanel('activity')}
              label="Activity"
            />
            <PanelTab
              active={panel === 'changes'}
              onClick={() => setPanel('changes')}
              label="Changes"
              count={contentFiles.length + unavailablePaths.length}
            />
            <span className="flex-1" />
            {subagents.length > 0 ? (
              <Mono className="text-muted-foreground">
                {subagents.length} {subagents.length === 1 ? 'subagent' : 'subagents'}
              </Mono>
            ) : null}
            <IconButton
              label={railOpen ? 'Hide the agents panel' : 'Show the agents panel'}
              icon={<AgentsIcon className="h-3.5 w-3.5" />}
              selected={railOpen}
              size="sm"
              onClick={() => setRailOpen((value) => !value)}
            />
          </div>

          {panel === 'activity' ? (
            <ActivityTimeline
              store={store}
              cwd={cwd}
              status={status}
              onReviewApproval={onReviewApproval}
              onReviewChanges={onReviewChanges}
              onInspectSubagent={onInspectSubagent}
            />
          ) : (
            <DiffReview files={contentFiles} unavailablePaths={unavailablePaths} cwd={cwd} />
          )}

          {approvals.length > 0 ? (
            <ApprovalDock
              requests={approvals}
              cwd={cwd}
              focusCallId={focusCallId}
              onResolve={(callId, decision) => {
                setFocusCallId(null);
                void session.resolveApproval(callId, decision);
              }}
            />
          ) : null}

          <SessionComposer
            onSubmit={onSubmit}
            onAbort={onAbort}
            running={running}
            blockedReason={blockedReason}
            mode={meta.mode}
            submitting={session.submitting}
          />
        </div>

        {railOpen ? (
          <SubagentPanel
            agents={subagents}
            cwd={cwd}
            selectedId={selectedSubagent}
            onSelect={setSelectedSubagent}
            rootModel={meta.model}
            rootBusy={running}
            className="w-[300px] shrink-0"
          />
        ) : null}
      </div>
    </div>
  );
}

function PanelTab({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  count?: number;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-2 py-1 text-[12px] font-medium',
        'transition-colors duration-100',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
        'outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
      )}
    >
      {label}
      {count !== undefined && count > 0 ? <Badge tone="neutral">{count}</Badge> : null}
    </button>
  );
}
