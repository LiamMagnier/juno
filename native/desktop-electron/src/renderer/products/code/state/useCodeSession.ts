/**
 * React binding for `CodeSessionStore`.
 *
 * The hook owns the IPC subscription and the imperative actions; the store owns
 * the data. Components subscribe to individual channels with `useStoreVersion`,
 * so a token arriving re-renders the streaming text node and nothing else.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ApprovalDecision, PermissionMode, WireAgentEvent } from '../lib/contract.js';
import { describeError, invoke, isBridgeAvailable, on } from '../lib/bridge.js';
import { CodeSessionStore, type StoreChannel } from './timeline-store.js';

export type HostStatus = 'stopped' | 'starting' | 'running' | 'crashed';

/** Subscribe a component to one channel of the store. */
export function useStoreVersion(store: CodeSessionStore, channel: StoreChannel): number {
  const subscribe = useMemo(() => store.subscribeTo(channel), [store, channel]);
  const getSnapshot = useMemo(() => store.versionOf(channel), [store, channel]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export type StartState =
  | { phase: 'idle' }
  | { phase: 'starting' }
  | { phase: 'ready'; sessionId: string }
  | { phase: 'failed'; message: string };

export interface CodeSessionApi {
  store: CodeSessionStore;
  start: StartState;
  hostStatus: HostStatus;
  bridgeAvailable: boolean;
  /** True between submitting a prompt and the host acknowledging it. */
  submitting: boolean;
  startSession: () => Promise<void>;
  sendPrompt: (text: string) => Promise<void>;
  resolveApproval: (callId: string, decision: ApprovalDecision) => Promise<void>;
  setMode: (mode: PermissionMode) => Promise<void>;
  abort: () => Promise<void>;
}

export interface UseCodeSessionOptions {
  /** Null until a workspace is chosen and trusted. Starting is blocked while null. */
  workspaceId: string | null;
  trusted: boolean;
  model?: string | undefined;
  mode?: PermissionMode | undefined;
  /** Start as soon as the workspace is trusted, rather than on first prompt. */
  autoStart?: boolean;
}

export function useCodeSession(options: UseCodeSessionOptions): CodeSessionApi {
  const { workspaceId, trusted, model, mode, autoStart = true } = options;

  const store = useMemo(() => new CodeSessionStore(), []);
  const [start, setStart] = useState<StartState>({ phase: 'idle' });
  const [hostStatus, setHostStatus] = useState<HostStatus>('stopped');
  const [submitting, setSubmitting] = useState(false);
  const bridgeAvailable = useMemo(() => isBridgeAvailable(), []);

  const sessionIdRef = useRef<string | null>(null);
  /* Events can arrive before `code:start-session` resolves. Rather than
     accepting anything (which would splice a second session's events into this
     transcript), unknown ids are parked and drained once the id is known. */
  const parked = useRef(new Map<string, WireAgentEvent[]>());

  useEffect(() => () => store.dispose(), [store]);

  useEffect(() => {
    const off = on('code:event', (payload) => {
      const current = sessionIdRef.current;
      if (current === null) {
        const bucket = parked.current.get(payload.sessionId) ?? [];
        bucket.push(payload.event);
        parked.current.set(payload.sessionId, bucket);
        return;
      }
      if (payload.sessionId !== current) return;
      store.apply(payload.event);
    });
    return off;
  }, [store]);

  useEffect(() => {
    const off = on('code:host-status', (payload) => {
      setHostStatus(payload.status);
      if (payload.status === 'crashed') {
        store.setStatus('failed');
        store.setLocalError(payload.detail ?? 'The agent host stopped unexpectedly.');
      }
    });
    return off;
  }, [store]);

  const startSession = useCallback(async (): Promise<void> => {
    if (workspaceId === null || !trusted) return;
    if (start.phase === 'starting' || start.phase === 'ready') return;
    setStart({ phase: 'starting' });
    store.setStatus('starting');
    try {
      const request: { workspaceId: string; model?: string; mode?: PermissionMode } = {
        workspaceId,
      };
      /* exactOptionalPropertyTypes: an explicit `undefined` is not the same as
         an absent key, and the channel schema treats them differently. */
      if (model !== undefined) request.model = model;
      if (mode !== undefined) request.mode = mode;
      const result = await invoke('code:start-session', request);
      sessionIdRef.current = result.sessionId;
      const backlog = parked.current.get(result.sessionId);
      if (backlog) {
        for (const event of backlog) store.apply(event);
        parked.current.delete(result.sessionId);
      }
      setStart({ phase: 'ready', sessionId: result.sessionId });
      store.setStatus('idle');
    } catch (error) {
      const message = describeError(error);
      setStart({ phase: 'failed', message });
      store.setStatus('failed');
    }
  }, [workspaceId, trusted, start.phase, model, mode, store]);

  useEffect(() => {
    if (!autoStart) return;
    if (workspaceId === null || !trusted) return;
    if (start.phase !== 'idle') return;
    void startSession();
  }, [autoStart, workspaceId, trusted, start.phase, startSession]);

  const sendPrompt = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;
      let sessionId = sessionIdRef.current;
      if (sessionId === null) {
        await startSession();
        sessionId = sessionIdRef.current;
        if (sessionId === null) return;
      }
      store.appendUserPrompt(trimmed);
      setSubmitting(true);
      try {
        await invoke('code:prompt', { sessionId, text: trimmed });
      } catch (error) {
        store.setLocalError(describeError(error));
      } finally {
        setSubmitting(false);
      }
    },
    [store, startSession],
  );

  const resolveApproval = useCallback(
    async (callId: string, decision: ApprovalDecision): Promise<void> => {
      const sessionId = sessionIdRef.current;
      if (sessionId === null) return;
      try {
        await invoke('code:resolve-approval', { sessionId, callId, decision });
      } catch (error) {
        store.setLocalError(describeError(error));
      }
    },
    [store],
  );

  const setModeAction = useCallback(
    async (next: PermissionMode): Promise<void> => {
      const sessionId = sessionIdRef.current;
      if (sessionId === null) return;
      try {
        await invoke('code:set-mode', { sessionId, mode: next });
      } catch (error) {
        store.setLocalError(describeError(error));
      }
    },
    [store],
  );

  const abort = useCallback(async (): Promise<void> => {
    const sessionId = sessionIdRef.current;
    if (sessionId === null) return;
    try {
      await invoke('code:abort', { sessionId });
      store.setStatus('aborted');
    } catch (error) {
      store.setLocalError(describeError(error));
    }
  }, [store]);

  return {
    store,
    start,
    hostStatus,
    bridgeAvailable,
    submitting,
    startSession,
    sendPrompt,
    resolveApproval,
    setMode: setModeAction,
    abort,
  };
}
