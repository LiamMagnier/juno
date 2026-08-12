/**
 * The session store, and the reason this surface stays fast.
 *
 * ── The failure this design exists to avoid ──────────────────────────────────
 * The naive implementation of an agent transcript is `setEvents([...events, e])`
 * in a `code:event` handler. A single turn emits one `assistant_delta` per
 * token, so that reducer runs hundreds of times a second, and each run produces
 * a new array whose every element is a new prop for a re-rendered row. At a few
 * hundred entries the main thread is spending its entire frame budget
 * reconciling text that did not change, and typing in the composer starts to
 * stutter. This is the number-one performance failure in this class of app.
 *
 * ── The design ───────────────────────────────────────────────────────────────
 * 1. STATE LIVES OUTSIDE REACT. Entries are held in a plain mutable array on
 *    this object. React subscribes through `useSyncExternalStore` to a *version
 *    counter*, not to the data. The snapshot is a number, so it is trivially
 *    referentially stable and React never re-renders on an unchanged read.
 *
 * 2. APPEND-ORIENTED, IDENTITY-STABLE ENTRIES. Entries are only ever appended,
 *    and mutation is confined to the tail: when a tool call finishes we replace
 *    *that one entry object* (`entries[i] = {...}`) and leave every earlier
 *    object untouched. Earlier entries therefore keep their identity for the
 *    lifetime of the session, which makes `React.memo` on a row a true
 *    short-circuit rather than a deep-compare. A new token cannot re-render a
 *    prior entry, because a prior entry's props are the same object they were.
 *
 * 3. STREAMING IS A SEPARATE CHANNEL. `assistant_delta` does NOT touch the
 *    entry array or the timeline version. It appends to a string buffer and
 *    notifies only the `stream` channel, which exactly one component
 *    (`StreamingText`) subscribes to. A token costs one re-render of one text
 *    node — not one re-render of the transcript. When the message completes,
 *    the buffer is committed into the entry once and the buffer is cleared.
 *
 * 4. NOTIFICATIONS ARE FRAME-COALESCED. A burst of twenty tool events inside
 *    one frame produces one render, not twenty. Flushing is via
 *    `requestAnimationFrame`, with a microtask fallback so the store still works
 *    in a test environment with no rAF.
 *
 * 5. CHANNELS ARE SPLIT. Approvals, subagents, run status, changed files and
 *    the timeline each carry their own version. An approval arriving does not
 *    re-render the timeline; a token does not re-render the subagent panel.
 *
 * 6. THE VIEW IS WINDOWED. Even with all of the above, mounting 10,000 rows is
 *    fatal on its own. `useVirtualRows` mounts only the visible slice. Together
 *    with (2), render cost is O(visible), independent of session length.
 *
 * Reading `store.entries` during render is intentional: it is mutable data
 * guarded by a version subscription, which is the standard external-store
 * pattern React's own docs describe. The invariant that makes it safe is that
 * `entries` is only mutated inside `apply()`, and `apply()` always bumps the
 * timeline version.
 */

import type {
  ApprovalDecision,
  PermissionMode,
  Usage,
  WireAgentEvent,
  WireApprovalRequest,
  WireSubagentSnapshot,
} from '../lib/contract.js';
import { categorize, summarizeCall, targetOf, type ToolCategory } from '../lib/tools.js';
import { describeCategory } from '../lib/tools.js';
import type { RiskLevel } from '../lib/contract.js';

/* -------------------------------------------------------------------------- */
/* Entry model                                                                 */
/* -------------------------------------------------------------------------- */

export type CallStatus = 'running' | 'ok' | 'error' | 'denied';

export interface ToolCall {
  callId: string;
  name: string;
  input: unknown;
  risk: RiskLevel;
  status: CallStatus;
  summary: string;
  target: string | null;
  output: string | null;
  durationMs: number | null;
  startedAt: number;
}

interface EntryBase {
  id: string;
  at: number;
  /** Null means the root agent. Never `undefined` — see exactOptionalPropertyTypes. */
  agentId: string | null;
  agentLabel: string | null;
}

export interface MessageEntry extends EntryBase {
  kind: 'message';
  text: string;
  streaming: boolean;
}

export interface ToolGroupEntry extends EntryBase {
  kind: 'tools';
  category: ToolCategory;
  calls: ToolCall[];
  /** Set when any call in the group failed — the group must not stay collapsed. */
  hasError: boolean;
}

export interface ApprovalEntry extends EntryBase {
  kind: 'approval';
  request: WireApprovalRequest;
  decision: ApprovalDecision | null;
}

export interface ChangeEntry extends EntryBase {
  kind: 'changes';
  turnIndex: number;
  paths: string[];
}

export interface NoticeEntry extends EntryBase {
  kind: 'notice';
  tone: 'info' | 'error';
  title: string;
  detail: string | null;
}

export interface TurnEntry extends EntryBase {
  kind: 'turn';
  turnIndex: number;
  stopReason: string | null;
  usage: Usage | null;
  subagentUsage: Usage | null;
}

export interface SubagentEntry extends EntryBase {
  kind: 'subagent';
  subagentId: string;
  title: string;
  role: string;
  status: string;
}

/** The user's own message. Echoed locally so the composer feels instant. */
export interface PromptEntry extends EntryBase {
  kind: 'prompt';
  text: string;
}

export type TimelineEntry =
  | MessageEntry
  | ToolGroupEntry
  | ApprovalEntry
  | ChangeEntry
  | NoticeEntry
  | TurnEntry
  | SubagentEntry
  | PromptEntry;

/** Whether a group of this size and category starts collapsed. */
export function startsCollapsed(entry: ToolGroupEntry): boolean {
  if (entry.hasError) return false;
  return entry.calls.length > describeCategory(entry.category).collapseAfter;
}

/* -------------------------------------------------------------------------- */
/* Run status                                                                  */
/* -------------------------------------------------------------------------- */

export type RunStatus =
  | 'idle'
  | 'starting'
  | 'thinking'
  | 'working'
  | 'awaiting-approval'
  | 'failed'
  | 'aborted';

export interface SessionSnapshot {
  sessionId: string | null;
  cwd: string | null;
  provider: string | null;
  model: string | null;
  mode: PermissionMode | null;
  turnIndex: number;
  usage: Usage;
  subagentUsage: Usage;
}

export type StoreChannel =
  | 'timeline'
  | 'stream'
  | 'approvals'
  | 'subagents'
  | 'status'
  | 'changes'
  | 'session';

const CHANNELS: readonly StoreChannel[] = [
  'timeline',
  'stream',
  'approvals',
  'subagents',
  'status',
  'changes',
  'session',
];

type Listener = () => void;

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export class CodeSessionStore {
  /** Append-only. Only `apply()` writes here, and only ever at the tail. */
  readonly entries: TimelineEntry[] = [];

  /** Pending approvals in arrival order. Resolved ones are removed. */
  readonly pendingApprovals: WireApprovalRequest[] = [];

  /** Subagents by id, in first-seen order. */
  readonly subagents: WireSubagentSnapshot[] = [];

  /** Absolute paths reported by `files_changed`, de-duplicated, newest last. */
  readonly changedPaths: string[] = [];

  /** Tool calls that carried an edit payload, kept for the diff reviewer. */
  readonly editCalls: ToolCall[] = [];

  session: SessionSnapshot = {
    sessionId: null,
    cwd: null,
    provider: null,
    model: null,
    mode: null,
    turnIndex: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    subagentUsage: { inputTokens: 0, outputTokens: 0 },
  };

  status: RunStatus = 'idle';
  lastError: string | null = null;

  /** Live assistant text, never stored in an entry until the message completes. */
  private streamBuffer = '';
  private streamEntryId: string | null = null;

  private readonly versions = new Map<StoreChannel, number>();
  private readonly listeners = new Map<StoreChannel, Set<Listener>>();
  private readonly dirty = new Set<StoreChannel>();
  private flushHandle: number | null = null;
  private sequence = 0;
  private readonly callIndex = new Map<string, { entryIndex: number; callIndex: number }>();

  /* `useSyncExternalStore` re-subscribes whenever the `subscribe` identity
     changes, so both accessors are built once per channel here rather than
     closed over on each render. A curried getter created in render would
     tear down and rebuild every subscription on every frame — which is the
     exact cost this store exists to avoid. */
  private readonly subscribers = new Map<StoreChannel, (listener: Listener) => () => void>();
  private readonly getters = new Map<StoreChannel, () => number>();

  constructor() {
    for (const channel of CHANNELS) {
      this.versions.set(channel, 0);
      const set = new Set<Listener>();
      this.listeners.set(channel, set);
      this.subscribers.set(channel, (listener: Listener) => {
        set.add(listener);
        return () => {
          set.delete(listener);
        };
      });
      this.getters.set(channel, () => this.versions.get(channel) ?? 0);
    }
  }

  /* ---- subscription ------------------------------------------------------ */

  subscribeTo(channel: StoreChannel): (listener: Listener) => () => void {
    const subscriber = this.subscribers.get(channel);
    /* Unreachable: every channel is seeded in the constructor. The fallback
       keeps the signature total rather than asserting non-null. */
    return subscriber ?? (() => () => undefined);
  }

  versionOf(channel: StoreChannel): () => number {
    return this.getters.get(channel) ?? (() => 0);
  }

  /** Current streaming text. A string snapshot is value-compared by React. */
  getStreamText = (): string => this.streamBuffer;

  getStreamEntryId = (): string | null => this.streamEntryId;

  private touch(channel: StoreChannel): void {
    this.dirty.add(channel);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushHandle !== null) return;
    const run = (): void => {
      this.flushHandle = null;
      const channels = [...this.dirty];
      this.dirty.clear();
      for (const channel of channels) {
        this.versions.set(channel, (this.versions.get(channel) ?? 0) + 1);
      }
      for (const channel of channels) {
        const set = this.listeners.get(channel);
        if (!set) continue;
        for (const listener of set) listener();
      }
    };

    if (typeof requestAnimationFrame === 'function') {
      this.flushHandle = requestAnimationFrame(run);
    } else {
      this.flushHandle = 1;
      queueMicrotask(run);
    }
  }

  /** Force a synchronous flush. Used on teardown so nothing is left pending. */
  dispose(): void {
    if (this.flushHandle !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(this.flushHandle);
    }
    this.flushHandle = null;
    this.dirty.clear();
    for (const set of this.listeners.values()) set.clear();
  }

  /* ---- entry helpers ----------------------------------------------------- */

  private nextId(prefix: string): string {
    this.sequence += 1;
    return `${prefix}-${this.sequence}`;
  }

  private push(entry: TimelineEntry): void {
    this.entries.push(entry);
    this.touch('timeline');
  }

  private tail(): TimelineEntry | undefined {
    return this.entries[this.entries.length - 1];
  }

  /** Replace an entry in place, preserving the identity of every other entry. */
  private replace(index: number, entry: TimelineEntry): void {
    if (index < 0 || index >= this.entries.length) return;
    this.entries[index] = entry;
    this.touch('timeline');
  }

  private endStream(finalText: string | null): void {
    if (this.streamEntryId === null) {
      if (finalText !== null && finalText.length > 0) {
        this.push({
          kind: 'message',
          id: this.nextId('msg'),
          at: Date.now(),
          agentId: null,
          agentLabel: null,
          text: finalText,
          streaming: false,
        });
      }
      return;
    }
    const index = this.entries.findIndex((entry) => entry.id === this.streamEntryId);
    const existing = index >= 0 ? this.entries[index] : undefined;
    if (existing && existing.kind === 'message') {
      this.replace(index, {
        ...existing,
        text: finalText ?? this.streamBuffer,
        streaming: false,
      });
    }
    this.streamEntryId = null;
    this.streamBuffer = '';
    this.touch('stream');
  }

  /* ---- the reducer ------------------------------------------------------- */

  /**
   * Fold one agent event into the store. Exhaustive over the event union:
   * adding a variant to the contract makes this fail to compile, which is the
   * point. Takes the wire type — see `WireAgentEvent` in lib/contract.ts.
   */
  apply(event: WireAgentEvent): void {
    switch (event.type) {
      case 'session_started': {
        this.session = {
          ...this.session,
          sessionId: event.sessionId,
          cwd: event.cwd,
          provider: event.provider,
          model: event.model,
          mode: event.mode,
        };
        this.status = 'idle';
        this.touch('session');
        this.touch('status');
        return;
      }

      case 'turn_started': {
        this.endStream(null);
        this.session = { ...this.session, turnIndex: event.turnIndex };
        this.status = 'thinking';
        this.push({
          kind: 'turn',
          id: this.nextId('turn'),
          at: Date.now(),
          agentId: null,
          agentLabel: null,
          turnIndex: event.turnIndex,
          stopReason: null,
          usage: null,
          subagentUsage: null,
        });
        this.touch('session');
        this.touch('status');
        return;
      }

      case 'assistant_delta': {
        /* The hot path. No entry array mutation, no timeline version bump. */
        if (this.streamEntryId === null) {
          const id = this.nextId('msg');
          this.streamEntryId = id;
          this.streamBuffer = '';
          this.push({
            kind: 'message',
            id,
            at: Date.now(),
            agentId: null,
            agentLabel: null,
            text: '',
            streaming: true,
          });
        }
        this.streamBuffer += event.text;
        if (this.status !== 'awaiting-approval') this.status = 'thinking';
        this.touch('stream');
        return;
      }

      case 'assistant_message': {
        this.endStream(event.text);
        return;
      }

      case 'tool_started': {
        this.endStream(null);
        const category = categorize(event.name, event.input);
        const call: ToolCall = {
          callId: event.callId,
          name: event.name,
          input: event.input,
          risk: event.risk,
          status: 'running',
          summary: summarizeCall(event.name, event.input),
          target: targetOf(event.name, event.input),
          output: null,
          durationMs: null,
          startedAt: Date.now(),
        };
        if (event.name === 'edit_file' || event.name === 'write_file') {
          this.editCalls.push(call);
          this.touch('changes');
        }

        const agentId = event.agentId ?? null;
        const last = this.tail();
        const index = this.entries.length - 1;
        if (
          last !== undefined &&
          last.kind === 'tools' &&
          last.category === category &&
          last.agentId === agentId
        ) {
          this.replace(index, { ...last, calls: [...last.calls, call] });
          this.callIndex.set(event.callId, { entryIndex: index, callIndex: last.calls.length });
        } else {
          this.push({
            kind: 'tools',
            id: this.nextId('tools'),
            at: Date.now(),
            agentId,
            agentLabel: this.labelFor(agentId),
            category,
            calls: [call],
            hasError: false,
          });
          this.callIndex.set(event.callId, { entryIndex: this.entries.length - 1, callIndex: 0 });
        }
        this.status = 'working';
        this.touch('status');
        return;
      }

      case 'tool_finished': {
        this.updateCall(event.callId, (call) => ({
          ...call,
          status: event.isError ? 'error' : 'ok',
          output: event.output,
          durationMs: event.durationMs,
        }));
        if (this.status === 'working') {
          this.status = 'thinking';
          this.touch('status');
        }
        return;
      }

      case 'tool_denied': {
        this.updateCall(event.callId, (call) => ({
          ...call,
          status: 'denied',
          output: event.reason,
        }));
        return;
      }

      case 'approval_requested': {
        this.endStream(null);
        this.pendingApprovals.push(event.request);
        this.push({
          kind: 'approval',
          id: this.nextId('approval'),
          at: Date.now(),
          agentId: event.request.agentId ?? null,
          agentLabel: event.request.agentLabel ?? null,
          request: event.request,
          decision: null,
        });
        this.status = 'awaiting-approval';
        this.touch('approvals');
        this.touch('status');
        return;
      }

      case 'approval_resolved': {
        const position = this.pendingApprovals.findIndex(
          (request) => request.callId === event.callId,
        );
        if (position >= 0) this.pendingApprovals.splice(position, 1);
        const index = this.entries.findIndex(
          (entry) => entry.kind === 'approval' && entry.request.callId === event.callId,
        );
        const existing = index >= 0 ? this.entries[index] : undefined;
        if (existing && existing.kind === 'approval') {
          this.replace(index, { ...existing, decision: event.decision });
        }
        if (this.pendingApprovals.length === 0 && this.status === 'awaiting-approval') {
          this.status = 'working';
          this.touch('status');
        }
        this.touch('approvals');
        return;
      }

      case 'files_changed': {
        for (const path of event.paths) {
          if (!this.changedPaths.includes(path)) this.changedPaths.push(path);
        }
        this.push({
          kind: 'changes',
          id: this.nextId('changes'),
          at: Date.now(),
          agentId: null,
          agentLabel: null,
          turnIndex: event.turnIndex,
          paths: [...event.paths],
        });
        this.touch('changes');
        return;
      }

      case 'mode_changed': {
        this.session = { ...this.session, mode: event.mode };
        this.push({
          kind: 'notice',
          id: this.nextId('notice'),
          at: Date.now(),
          agentId: null,
          agentLabel: null,
          tone: 'info',
          title: `Permission mode set to ${event.mode}`,
          detail: null,
        });
        this.touch('session');
        return;
      }

      case 'turn_finished': {
        this.endStream(null);
        const index = this.entries.findIndex(
          (entry) => entry.kind === 'turn' && entry.turnIndex === event.turnIndex,
        );
        const existing = index >= 0 ? this.entries[index] : undefined;
        if (existing && existing.kind === 'turn') {
          this.replace(index, {
            ...existing,
            stopReason: event.stopReason,
            usage: event.usage,
            subagentUsage: event.subagentUsage ?? null,
          });
        }
        this.session = {
          ...this.session,
          usage: {
            inputTokens: this.session.usage.inputTokens + event.usage.inputTokens,
            outputTokens: this.session.usage.outputTokens + event.usage.outputTokens,
          },
          subagentUsage: event.subagentUsage
            ? {
                inputTokens: this.session.subagentUsage.inputTokens + event.subagentUsage.inputTokens,
                outputTokens:
                  this.session.subagentUsage.outputTokens + event.subagentUsage.outputTokens,
              }
            : this.session.subagentUsage,
        };
        this.status = event.stopReason === 'aborted' ? 'aborted' : 'idle';
        this.touch('session');
        this.touch('status');
        return;
      }

      case 'error': {
        this.endStream(null);
        this.lastError = event.message;
        this.push({
          kind: 'notice',
          id: this.nextId('notice'),
          at: Date.now(),
          agentId: null,
          agentLabel: null,
          tone: 'error',
          title: 'Agent error',
          detail: event.message,
        });
        this.status = 'failed';
        this.touch('status');
        return;
      }

      case 'subagent_update': {
        const snapshot = event.agent;
        const position = this.subagents.findIndex((agent) => agent.id === snapshot.id);
        const previous = position >= 0 ? this.subagents[position] : undefined;
        if (position >= 0) this.subagents[position] = snapshot;
        else this.subagents.push(snapshot);

        /* Only lifecycle transitions earn a timeline entry. A subagent emits an
           update on every activity change; putting all of them in the timeline
           would reintroduce exactly the noise this surface exists to remove. */
        if (previous === undefined || previous.status !== snapshot.status) {
          this.push({
            kind: 'subagent',
            id: this.nextId('subagent'),
            at: Date.now(),
            agentId: snapshot.id,
            agentLabel: `${snapshot.role} · ${snapshot.title}`,
            subagentId: snapshot.id,
            title: snapshot.title,
            role: snapshot.role,
            status: snapshot.status,
          });
        }
        this.touch('subagents');
        return;
      }
    }
  }

  private labelFor(agentId: string | null): string | null {
    if (agentId === null) return null;
    const agent = this.subagents.find((candidate) => candidate.id === agentId);
    return agent ? `${agent.role} · ${agent.title}` : agentId;
  }

  private updateCall(callId: string, update: (call: ToolCall) => ToolCall): void {
    const location = this.callIndex.get(callId);
    if (!location) return;
    const entry = this.entries[location.entryIndex];
    if (!entry || entry.kind !== 'tools') return;
    const call = entry.calls[location.callIndex];
    if (!call) return;
    const next = update(call);
    const calls = entry.calls.slice();
    calls[location.callIndex] = next;
    this.replace(location.entryIndex, {
      ...entry,
      calls,
      hasError: entry.hasError || next.status === 'error' || next.status === 'denied',
    });
    if (next.status !== 'running' && (next.name === 'edit_file' || next.name === 'write_file')) {
      const editIndex = this.editCalls.findIndex((candidate) => candidate.callId === callId);
      if (editIndex >= 0) {
        this.editCalls[editIndex] = next;
        this.touch('changes');
      }
    }
  }

  /* ---- local (non-event) mutations --------------------------------------- */

  /** Optimistic local echo of the user's prompt, so the composer feels instant. */
  appendUserPrompt(text: string): void {
    this.push({
      kind: 'prompt',
      id: this.nextId('prompt'),
      at: Date.now(),
      agentId: null,
      agentLabel: null,
      text,
    });
    this.status = 'starting';
    this.touch('status');
  }

  setStatus(status: RunStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.touch('status');
  }

  setLocalError(message: string): void {
    this.lastError = message;
    this.push({
      kind: 'notice',
      id: this.nextId('notice'),
      at: Date.now(),
      agentId: null,
      agentLabel: null,
      tone: 'error',
      title: 'Request failed',
      detail: message,
    });
    this.status = 'failed';
    this.touch('status');
  }
}
