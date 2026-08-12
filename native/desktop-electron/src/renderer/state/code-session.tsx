/**
 * A live Code session, reduced to something the shell can draw.
 *
 * The agent host emits an unbounded stream of fine-grained events; this module
 * folds that stream into a bounded timeline plus a small amount of session
 * state. It is not the transcript surface — it is the state the *shell* needs
 * in order to have honest controls: whether a prompt can be sent, whether abort
 * does anything, whether an approval is blocking the turn.
 *
 * Three decisions worth naming:
 *
 *   - **Events are filtered by session id.** `code:event` is a single channel
 *     carrying every session in the process. A renderer that ignores the id
 *     renders another session's output into this one, which is the kind of bug
 *     that only appears once two sessions exist.
 *   - **`assistant_delta` appends to the last assistant entry, `assistant_message`
 *     replaces it.** The host sends both: deltas for streaming and a final
 *     message for the settled text. Appending both duplicates every reply.
 *   - **The timeline is capped.** A long-running session must not grow the DOM
 *     without limit; a shell that becomes unresponsive after an hour is a shell
 *     that fails in exactly the session the user cared most about.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { EventPayload, InvokeRequest } from '../../shared/ipc.js';
import { subscribe, tryInvoke } from '../lib/bridge.js';
import { useAnnounce } from './announcer.js';

/* Derived from the IPC contract rather than imported from agent-protocol, so
   the renderer graph never pulls in the Zod schemas — they are main's job. */
type CodeEvent = EventPayload<'code:event'>['event'];
export type ApprovalRequest = Extract<CodeEvent, { type: 'approval_requested' }>['request'];
export type PermissionMode = InvokeRequest<'code:set-mode'>['mode'];
export type ApprovalDecision = InvokeRequest<'code:resolve-approval'>['decision'];
export type RiskLevel = ApprovalRequest['risk'];

const MAX_TIMELINE_ENTRIES = 300;

export type TimelineEntry =
  | { readonly kind: 'assistant'; readonly id: string; readonly text: string }
  | {
      readonly kind: 'tool';
      readonly id: string;
      readonly callId: string;
      readonly name: string;
      readonly risk: RiskLevel;
      readonly status: 'running' | 'ok' | 'error' | 'denied';
      readonly detail: string;
      readonly durationMs: number | null;
    }
  | { readonly kind: 'notice'; readonly id: string; readonly tone: 'info' | 'error'; readonly text: string }
  | { readonly kind: 'files'; readonly id: string; readonly paths: readonly string[] };

/** `idle` has no session; `ready` can accept a prompt; `busy` is mid-turn. */
export type SessionPhase = 'idle' | 'starting' | 'ready' | 'busy' | 'error';

interface CodeSessionApi {
  readonly sessionId: string | null;
  readonly phase: SessionPhase;
  readonly mode: PermissionMode;
  readonly error: string | null;
  readonly timeline: readonly TimelineEntry[];
  readonly approvals: readonly ApprovalRequest[];
  readonly tokensIn: number;
  readonly tokensOut: number;
  start: (workspaceId: string) => void;
  sendPrompt: (text: string) => void;
  abort: () => void;
  resolveApproval: (callId: string, decision: ApprovalDecision) => void;
  setMode: (mode: PermissionMode) => void;
}

const CodeSessionContext = createContext<CodeSessionApi | null>(null);

export function CodeSessionProvider({ children }: { children: ReactNode }): ReactNode {
  const announce = useAnnounce();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [phase, setPhase] = useState<SessionPhase>('idle');
  const [mode, setModeState] = useState<PermissionMode>('ask');
  const [error, setError] = useState<string | null>(null);
  const [timeline, setTimeline] = useState<readonly TimelineEntry[]>([]);
  const [approvals, setApprovals] = useState<readonly ApprovalRequest[]>([]);
  const [tokensIn, setTokensIn] = useState(0);
  const [tokensOut, setTokensOut] = useState(0);

  /* Read inside the event listener, which is registered once and must not be
     re-registered every time the session id changes — re-subscribing mid-turn
     drops events between the removeListener and the add. */
  const sessionIdRef = useRef<string | null>(null);
  sessionIdRef.current = sessionId;
  const entrySeq = useRef(0);
  const nextId = useCallback((): string => {
    entrySeq.current += 1;
    return `e${entrySeq.current}`;
  }, []);

  const append = useCallback((entry: TimelineEntry) => {
    setTimeline((current) => {
      const next = [...current, entry];
      return next.length > MAX_TIMELINE_ENTRIES ? next.slice(next.length - MAX_TIMELINE_ENTRIES) : next;
    });
  }, []);

  useEffect(() => {
    return subscribe('code:event', (payload) => {
      if (sessionIdRef.current !== null && payload.sessionId !== sessionIdRef.current) return;
      const event = payload.event;

      switch (event.type) {
        case 'session_started':
          setSessionId(event.sessionId);
          setModeState(event.mode);
          setPhase('ready');
          return;

        case 'turn_started':
          setPhase('busy');
          return;

        case 'assistant_delta': {
          const delta = event.text;
          setTimeline((current) => {
            const last = current.length > 0 ? current[current.length - 1] : undefined;
            if (last && last.kind === 'assistant') {
              const next = current.slice();
              next[next.length - 1] = { ...last, text: last.text + delta };
              return next;
            }
            entrySeq.current += 1;
            return [...current, { kind: 'assistant', id: `e${entrySeq.current}`, text: delta }];
          });
          return;
        }

        case 'assistant_message': {
          const text = event.text;
          setTimeline((current) => {
            const last = current.length > 0 ? current[current.length - 1] : undefined;
            if (last && last.kind === 'assistant') {
              const next = current.slice();
              next[next.length - 1] = { ...last, text };
              return next;
            }
            entrySeq.current += 1;
            return [...current, { kind: 'assistant', id: `e${entrySeq.current}`, text }];
          });
          return;
        }

        case 'tool_started':
          append({
            kind: 'tool',
            id: nextId(),
            callId: event.callId,
            name: event.name,
            risk: event.risk,
            status: 'running',
            detail: summariseToolInput(event.input),
            durationMs: null,
          });
          return;

        case 'tool_finished':
          setTimeline((current) =>
            current.map((entry) =>
              entry.kind === 'tool' && entry.callId === event.callId
                ? {
                    ...entry,
                    status: event.isError ? 'error' : 'ok',
                    detail: firstLine(event.output) || entry.detail,
                    durationMs: event.durationMs,
                  }
                : entry,
            ),
          );
          return;

        case 'tool_denied':
          setTimeline((current) =>
            current.map((entry) =>
              entry.kind === 'tool' && entry.callId === event.callId
                ? { ...entry, status: 'denied', detail: event.reason }
                : entry,
            ),
          );
          return;

        case 'approval_requested':
          setApprovals((current) => [...current, event.request]);
          announce(`Approval needed: ${event.request.summary}`, 'assertive');
          return;

        case 'approval_resolved':
          setApprovals((current) => current.filter((request) => request.callId !== event.callId));
          return;

        case 'files_changed':
          append({ kind: 'files', id: nextId(), paths: event.paths });
          return;

        case 'mode_changed':
          setModeState(event.mode);
          return;

        case 'turn_finished':
          setPhase('ready');
          setTokensIn((value) => value + event.usage.inputTokens);
          setTokensOut((value) => value + event.usage.outputTokens);
          return;

        case 'error':
          setPhase('error');
          setError(event.message);
          append({ kind: 'notice', id: nextId(), tone: 'error', text: event.message });
          announce(`Session error. ${event.message}`, 'assertive');
          return;

        case 'subagent_update':
          /* Subagents have their own surface; the shell does not draw them, and
             folding them into this timeline would misrepresent whose work the
             rows describe. */
          return;
      }
    });
  }, [announce, append, nextId]);

  const start = useCallback(
    (workspaceId: string) => {
      setPhase('starting');
      setError(null);
      setTimeline([]);
      setApprovals([]);
      void (async () => {
        const result = await tryInvoke('code:start-session', { workspaceId });
        if (!result.ok) {
          setPhase('error');
          setError(result.error);
          announce(`Could not start the session. ${result.error}`, 'assertive');
          return;
        }
        setSessionId(result.value.sessionId);
        setPhase('ready');
        announce('Session ready.');
      })();
    },
    [announce],
  );

  const sendPrompt = useCallback(
    (text: string) => {
      const id = sessionIdRef.current;
      const trimmed = text.trim();
      if (!id || trimmed.length === 0) return;
      setPhase('busy');
      void (async () => {
        const result = await tryInvoke('code:prompt', { sessionId: id, text: trimmed });
        if (!result.ok) {
          setPhase('error');
          setError(result.error);
          announce(`The prompt was not delivered. ${result.error}`, 'assertive');
        }
      })();
    },
    [announce],
  );

  const abort = useCallback(() => {
    const id = sessionIdRef.current;
    if (!id) return;
    void (async () => {
      const result = await tryInvoke('code:abort', { sessionId: id });
      if (result.ok) {
        setPhase('ready');
        announce('Turn stopped.');
      } else {
        announce(`Could not stop the turn. ${result.error}`, 'assertive');
      }
    })();
  }, [announce]);

  const resolveApproval = useCallback(
    (callId: string, decision: ApprovalDecision) => {
      const id = sessionIdRef.current;
      if (!id) return;
      /* Removed locally as well as on the reply: the host echoes
         `approval_resolved`, but leaving the card up until it arrives lets the
         user press Allow twice. */
      setApprovals((current) => current.filter((request) => request.callId !== callId));
      void (async () => {
        const result = await tryInvoke('code:resolve-approval', { sessionId: id, callId, decision });
        if (!result.ok) announce(`The decision was not recorded. ${result.error}`, 'assertive');
      })();
    },
    [announce],
  );

  const setMode = useCallback(
    (next: PermissionMode) => {
      const id = sessionIdRef.current;
      if (!id) return;
      const previous = mode;
      setModeState(next);
      void (async () => {
        const result = await tryInvoke('code:set-mode', { sessionId: id, mode: next });
        if (!result.ok) {
          setModeState(previous);
          announce(`Could not change permission mode. ${result.error}`, 'assertive');
        }
      })();
    },
    [announce, mode],
  );

  const value = useMemo<CodeSessionApi>(
    () => ({
      sessionId,
      phase,
      mode,
      error,
      timeline,
      approvals,
      tokensIn,
      tokensOut,
      start,
      sendPrompt,
      abort,
      resolveApproval,
      setMode,
    }),
    [
      sessionId,
      phase,
      mode,
      error,
      timeline,
      approvals,
      tokensIn,
      tokensOut,
      start,
      sendPrompt,
      abort,
      resolveApproval,
      setMode,
    ],
  );

  return <CodeSessionContext.Provider value={value}>{children}</CodeSessionContext.Provider>;
}

export function useCodeSession(): CodeSessionApi {
  const context = useContext(CodeSessionContext);
  if (!context) throw new Error('useCodeSession must be used inside <CodeSessionProvider>.');
  return context;
}

/**
 * A one-line description of a tool call's input.
 *
 * `input` is `unknown` by contract — the agent host is a separate process and
 * its tool schemas are not this renderer's business — so this reads the two
 * conventional keys and otherwise says nothing rather than dumping JSON into
 * the UI.
 */
function summariseToolInput(input: unknown): string {
  if (typeof input === 'string') return firstLine(input);
  if (typeof input === 'object' && input !== null) {
    const record = input as Record<string, unknown>;
    for (const key of ['command', 'path', 'file_path', 'pattern', 'query'] as const) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate.length > 0) return firstLine(candidate);
    }
  }
  return '';
}

function firstLine(value: string): string {
  const line = value.split('\n', 1)[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
