/**
 * The workspace list, and the trust decision attached to each one.
 *
 * Trust is the whole point of this module. A workspace is a directory of files
 * written by someone else — `THREAT_MODEL.md` treats repository content as
 * hostile — so nothing executes in a workspace the user has not explicitly
 * trusted. That makes `trusted` a permission, and permissions get their own
 * loading state: the UI must show that a trust change is in flight and must not
 * optimistically render the new value, because the user's next action depends
 * on whether main actually accepted it.
 *
 * The renderer also cannot name a path. `workspace:choose` opens a native
 * picker in main; there is no channel that takes a string. That is what makes
 * the trust prompt meaningful, and it is why "add workspace" here is a request
 * with a pending state rather than a form.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Workspace } from '../../shared/ipc.js';
import { isBridgeAvailable, tryInvoke } from '../lib/bridge.js';
import { useAnnounce } from './announcer.js';
import { useShell } from './shell-state.js';

export type WorkspaceLoadStatus = 'loading' | 'ready' | 'error';

interface WorkspacesApi {
  readonly status: WorkspaceLoadStatus;
  readonly items: readonly Workspace[];
  readonly error: string | null;
  /** True while the native folder picker is open. */
  readonly choosing: boolean;
  /** The workspace whose trust flag is currently being written, if any. */
  readonly trustPendingId: string | null;
  readonly active: Workspace | null;
  refresh: () => void;
  choose: () => void;
  setTrust: (workspaceId: string, trusted: boolean) => void;
}

const WorkspacesContext = createContext<WorkspacesApi | null>(null);

export function WorkspacesProvider({ children }: { children: ReactNode }): ReactNode {
  const announce = useAnnounce();
  const { activeWorkspaceId, setActiveWorkspace } = useShell();

  const [status, setStatus] = useState<WorkspaceLoadStatus>('loading');
  const [items, setItems] = useState<readonly Workspace[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [trustPendingId, setTrustPendingId] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (!isBridgeAvailable()) {
      setStatus('error');
      setError('Not connected to the main process.');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    void (async () => {
      const result = await tryInvoke('workspace:list');
      if (cancelled) return;
      if (result.ok) {
        setItems(result.value);
        setError(null);
        setStatus('ready');
      } else {
        setError(result.error);
        setStatus('error');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [nonce]);

  const refresh = useCallback(() => setNonce((value) => value + 1), []);

  const choose = useCallback(() => {
    setChoosing(true);
    void (async () => {
      const result = await tryInvoke('workspace:choose');
      setChoosing(false);
      if (!result.ok) {
        announce(`Could not open that folder. ${result.error}`, 'assertive');
        setError(result.error);
        return;
      }
      /* `null` means the user cancelled the picker. That is not an error and
         must not produce an error state — a dialog the user dismissed on
         purpose should leave no trace in the UI. */
      const workspace = result.value;
      if (!workspace) return;

      setItems((current) => {
        const existing = current.findIndex((item) => item.id === workspace.id);
        if (existing === -1) return [workspace, ...current];
        const next = current.slice();
        next[existing] = workspace;
        return next;
      });
      setActiveWorkspace(workspace.id);
      announce(`Opened workspace ${workspace.name}.`);
    })();
  }, [announce, setActiveWorkspace]);

  const setTrust = useCallback(
    (workspaceId: string, trusted: boolean) => {
      setTrustPendingId(workspaceId);
      void (async () => {
        const result = await tryInvoke('workspace:set-trust', { workspaceId, trusted });
        setTrustPendingId(null);
        if (!result.ok) {
          announce(`Could not change trust. ${result.error}`, 'assertive');
          setError(result.error);
          return;
        }
        const updated = result.value;
        setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
        announce(
          updated.trusted
            ? `${updated.name} is now trusted. Agents may run commands in it.`
            : `${updated.name} is no longer trusted.`,
          'assertive',
        );
      })();
    },
    [announce],
  );

  const active = useMemo(
    () => items.find((item) => item.id === activeWorkspaceId) ?? null,
    [items, activeWorkspaceId],
  );

  const value = useMemo<WorkspacesApi>(
    () => ({ status, items, error, choosing, trustPendingId, active, refresh, choose, setTrust }),
    [status, items, error, choosing, trustPendingId, active, refresh, choose, setTrust],
  );

  return <WorkspacesContext.Provider value={value}>{children}</WorkspacesContext.Provider>;
}

export function useWorkspaces(): WorkspacesApi {
  const context = useContext(WorkspacesContext);
  if (!context) throw new Error('useWorkspaces must be used inside <WorkspacesProvider>.');
  return context;
}
