/**
 * The chat store.
 *
 * ============================================================================
 * THE ONE PERFORMANCE PROPERTY THIS SURFACE HAS TO GET RIGHT:
 * a token arriving must not re-render the transcript.
 * ============================================================================
 *
 * Almost every chat UI gets this wrong the same way — one `useState` holding
 * `messages: Message[]`, patched with `prev.map(...)` on every delta. That
 * allocates a new array and a new message object sixty times a second, which
 * gives every component reading the list a new identity, which re-renders every
 * row. The web app survives it because a memo boundary inside its markdown
 * renderer catches the blast; at a thousand messages it would not.
 *
 * This store is built the other way round, on three ideas:
 *
 *   1. **Keyed subscriptions.** Not one store notification but many, addressed
 *      by key. `msg:abc` fires only when message `abc` changes; `index` fires
 *      only when the ORDER of messages changes. A row subscribes to its own
 *      message and to nothing else, so a delta on the live turn reaches exactly
 *      the components rendering the live turn.
 *
 *   2. **The live turn is not in the message list.** While a reply streams, its
 *      text lives in `live`, under its own keys (`live:text`, `live:reasoning`),
 *      and is committed into the settled list only when the turn ends. So the
 *      `index` key — the one thing the virtualizer reads — is untouched for the
 *      whole duration of a stream. The transcript literally cannot re-render
 *      from a token, because nothing it subscribes to changed.
 *
 *   3. **Deltas coalesce to a frame.** Tokens arrive faster than the display
 *      can show them; `flushScheduled` batches every delta received within one
 *      animation frame into a single notification. This caps the streaming
 *      surface at 60 renders/second no matter how fast the model emits, and it
 *      is the single largest win in the file.
 *
 * `useSyncExternalStore` requires a referentially stable snapshot between
 * notifications, so every snapshot below is an immutable object replaced only
 * when its contents actually change. Returning a fresh object from a getter is
 * an infinite render loop, not a slow render, which is why the pattern is
 * applied uniformly rather than where it seemed to matter.
 */

import type {
  Conversation,
  ConnectionState,
  GenerationStatus,
  Message,
  ReasoningEffort,
  StreamFrame,
} from '../contract.js';

/* -------------------------------------------------------------------------- */
/* Snapshot shapes                                                             */
/* -------------------------------------------------------------------------- */

/** The live turn's slow-moving facts. Changes a handful of times per turn. */
export interface LiveMeta {
  readonly assistantMessageId: string;
  readonly model: string;
  readonly reasoningEffort: ReasoningEffort | null;
  readonly status: GenerationStatus;
  /** Wall-clock start, for the elapsed counter. */
  readonly startedAt: number;
  /** Set when reasoning has ended, so the panel can show a final duration. */
  readonly reasoningEndedAt: number | null;
  readonly error: string | null;
  readonly retryable: boolean;
}

export interface TranscriptIndex {
  readonly ids: readonly string[];
  /** Present only while a turn is running. Rendered outside the virtual window. */
  readonly liveId: string | null;
}

const EMPTY_INDEX: TranscriptIndex = { ids: [], liveId: null };
const OFFLINE_UNKNOWN: ConnectionState = { status: 'online', detail: null, retryInSeconds: null };

export type LoadPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'error'; readonly message: string };

/* -------------------------------------------------------------------------- */
/* Keys                                                                        */
/* -------------------------------------------------------------------------- */

export const KEY = {
  index: 'index',
  status: 'status',
  connection: 'connection',
  phase: 'phase',
  conversation: 'conversation',
  liveMeta: 'live:meta',
  liveText: 'live:text',
  liveReasoning: 'live:reasoning',
  message: (id: string): string => `msg:${id}`,
} as const;

/* -------------------------------------------------------------------------- */
/* Store                                                                       */
/* -------------------------------------------------------------------------- */

export class ChatStore {
  /* --- subscriptions ----------------------------------------------------- */
  private readonly listeners = new Map<string, Set<() => void>>();

  /* --- settled transcript ------------------------------------------------- */
  private index: TranscriptIndex = EMPTY_INDEX;
  private readonly messages = new Map<string, Message>();

  /* --- live turn ---------------------------------------------------------- */
  private liveMeta: LiveMeta | null = null;
  private liveText = '';
  private liveReasoning = '';

  /* Deltas land here and are folded into the snapshots once per frame. */
  private pendingText = '';
  private pendingReasoning = '';
  private flushHandle: number | null = null;

  /* --- ambient ------------------------------------------------------------ */
  private status: GenerationStatus = 'idle';
  private connection: ConnectionState = OFFLINE_UNKNOWN;
  private phase: LoadPhase = { kind: 'idle' };
  private conversation: Conversation | null = null;

  /* ------------------------------------------------------------------------ */
  /* Subscription                                                              */
  /* ------------------------------------------------------------------------ */

  /** Returns an unsubscribe function, in the shape `useSyncExternalStore` wants. */
  readonly subscribe = (key: string, listener: () => void): (() => void) => {
    let bucket = this.listeners.get(key);
    if (!bucket) {
      bucket = new Set();
      this.listeners.set(key, bucket);
    }
    bucket.add(listener);
    return () => {
      bucket.delete(listener);
      /* Buckets are dropped when empty. A transcript that has scrolled past ten
         thousand messages would otherwise retain an empty Set for each one. */
      if (bucket.size === 0) this.listeners.delete(key);
    };
  };

  private notify(key: string): void {
    const bucket = this.listeners.get(key);
    if (!bucket) return;
    for (const listener of bucket) listener();
  }

  /* ------------------------------------------------------------------------ */
  /* Snapshots                                                                 */
  /* ------------------------------------------------------------------------ */

  readonly getIndex = (): TranscriptIndex => this.index;
  readonly getStatus = (): GenerationStatus => this.status;
  readonly getConnection = (): ConnectionState => this.connection;
  readonly getPhase = (): LoadPhase => this.phase;
  readonly getConversation = (): Conversation | null => this.conversation;
  readonly getLiveMeta = (): LiveMeta | null => this.liveMeta;
  readonly getLiveText = (): string => this.liveText;
  readonly getLiveReasoning = (): string => this.liveReasoning;
  readonly getMessage = (id: string): Message | undefined => this.messages.get(id);

  /** Whether a turn is in flight — the composer's send/stop pivot. */
  readonly isBusy = (): boolean =>
    this.status === 'checking' ||
    this.status === 'submitting' ||
    this.status === 'thinking' ||
    this.status === 'writing' ||
    this.status === 'stopping';

  /* ------------------------------------------------------------------------ */
  /* Loading                                                                   */
  /* ------------------------------------------------------------------------ */

  setPhase(phase: LoadPhase): void {
    this.phase = phase;
    this.notify(KEY.phase);
  }

  setConnection(state: ConnectionState): void {
    if (
      this.connection.status === state.status &&
      this.connection.detail === state.detail &&
      this.connection.retryInSeconds === state.retryInSeconds
    ) {
      return;
    }
    this.connection = state;
    this.notify(KEY.connection);
  }

  setConversation(conversation: Conversation | null): void {
    this.conversation = conversation;
    this.notify(KEY.conversation);
  }

  /** Replace the whole transcript — opening a conversation, or a hard refresh. */
  load(conversation: Conversation | null, messages: readonly Message[]): void {
    this.cancelFlush();
    this.messages.clear();
    for (const message of messages) this.messages.set(message.id, message);
    this.index = { ids: messages.map((message) => message.id), liveId: null };
    this.liveMeta = null;
    this.liveText = '';
    this.liveReasoning = '';
    this.pendingText = '';
    this.pendingReasoning = '';
    this.status = 'idle';
    this.conversation = conversation;
    this.phase = { kind: 'ready' };

    /* Everything at once: this is the one place where a broad notification is
       correct, because everything genuinely did change. */
    this.notify(KEY.conversation);
    this.notify(KEY.index);
    this.notify(KEY.status);
    this.notify(KEY.liveMeta);
    this.notify(KEY.liveText);
    this.notify(KEY.liveReasoning);
    this.notify(KEY.phase);
  }

  /* ------------------------------------------------------------------------ */
  /* Sending                                                                   */
  /* ------------------------------------------------------------------------ */

  /**
   * Append the user's message optimistically and open a live turn.
   *
   * The optimistic id is provisional; the `meta` frame carries the server's and
   * `reconcileIds` swaps it. Rendering only after the server replies would put
   * a visible gap between pressing send and seeing your own words, which is the
   * one piece of latency in a chat UI that is entirely avoidable.
   */
  beginTurn(input: {
    readonly userMessage: Message;
    readonly assistantMessageId: string;
    readonly model: string;
    readonly reasoningEffort: ReasoningEffort | null;
  }): void {
    this.messages.set(input.userMessage.id, input.userMessage);
    this.index = {
      ids: [...this.index.ids, input.userMessage.id],
      liveId: input.assistantMessageId,
    };
    this.liveText = '';
    this.liveReasoning = '';
    this.pendingText = '';
    this.pendingReasoning = '';
    this.liveMeta = {
      assistantMessageId: input.assistantMessageId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      status: 'submitting',
      startedAt: Date.now(),
      reasoningEndedAt: null,
      error: null,
      retryable: true,
    };
    this.setStatus('submitting');
    this.notify(KEY.index);
    this.notify(KEY.liveMeta);
    this.notify(KEY.liveText);
    this.notify(KEY.liveReasoning);
  }

  /** Open a live turn with no new user message — retry and edit-resend. */
  beginRerun(input: {
    readonly assistantMessageId: string;
    readonly model: string;
    readonly reasoningEffort: ReasoningEffort | null;
    /** The assistant message being replaced, dropped from the settled list. */
    readonly replacing: string | null;
  }): void {
    if (input.replacing !== null) {
      this.messages.delete(input.replacing);
      this.index = {
        ids: this.index.ids.filter((id) => id !== input.replacing),
        liveId: input.assistantMessageId,
      };
    } else {
      this.index = { ...this.index, liveId: input.assistantMessageId };
    }
    this.liveText = '';
    this.liveReasoning = '';
    this.pendingText = '';
    this.pendingReasoning = '';
    this.liveMeta = {
      assistantMessageId: input.assistantMessageId,
      model: input.model,
      reasoningEffort: input.reasoningEffort,
      status: 'submitting',
      startedAt: Date.now(),
      reasoningEndedAt: null,
      error: null,
      retryable: true,
    };
    this.setStatus('submitting');
    this.notify(KEY.index);
    this.notify(KEY.liveMeta);
    this.notify(KEY.liveText);
    this.notify(KEY.liveReasoning);
  }

  /* ------------------------------------------------------------------------ */
  /* Stream                                                                    */
  /* ------------------------------------------------------------------------ */

  /**
   * Apply one normalized SSE frame.
   *
   * Note what is NOT notified here. `delta` and `reasoning` — the two frames
   * that arrive hundreds of times per turn — only append to a pending buffer
   * and ask for a frame. Everything else is rare enough to notify immediately.
   */
  applyFrame(frame: StreamFrame): void {
    switch (frame.type) {
      case 'meta': {
        if (frame.userMessageId !== null) this.reconcileUserId(frame.userMessageId);
        this.patchLiveMeta({ assistantMessageId: frame.assistantMessageId });
        if (this.conversation && frame.title !== null) {
          this.setConversation({
            ...this.conversation,
            id: frame.conversationId,
            title: frame.title,
            titleSource: frame.titleSource ?? this.conversation.titleSource,
          });
        }
        return;
      }

      case 'title': {
        if (this.conversation) {
          this.setConversation({ ...this.conversation, title: frame.title, titleSource: frame.titleSource });
        }
        return;
      }

      case 'reasoning': {
        /* A declared part boundary becomes a blank line. NEVER inferred from
           the text — a provider that emits no boundaries must not have them
           invented from punctuation, which is how reasoning ends up chopped
           mid-sentence. */
        const boundary = frame.part !== null && this.liveReasoning.length + this.pendingReasoning.length > 0;
        this.pendingReasoning += (boundary ? '\n\n' : '') + frame.text;
        if (this.status !== 'writing') this.setStatus('thinking');
        this.scheduleFlush();
        return;
      }

      case 'delta': {
        this.pendingText += frame.text;
        if (this.status !== 'writing') {
          /* The first answer token is also the end of reasoning. Stamping it
             here rather than waiting for a dedicated frame means the duration
             is right even for providers that never send one. */
          this.setStatus('writing');
          if (this.liveMeta && this.liveMeta.reasoningEndedAt === null) {
            this.patchLiveMeta({ reasoningEndedAt: Date.now() });
          }
        }
        this.scheduleFlush();
        return;
      }

      case 'sources': {
        /* Sources belong to the finished message; while live they are held on
           the meta snapshot's message-to-be. Committed in `done`. */
        this.pendingSources = frame.sources;
        return;
      }

      case 'done': {
        this.flushNow();
        this.commit(frame.message);
        return;
      }

      case 'error': {
        this.flushNow();
        this.fail(frame.message, frame.preservePartial, frame.retryable, frame.finishReason);
        return;
      }
    }
  }

  private pendingSources: StreamFrameSources = [];

  /* ------------------------------------------------------------------------ */
  /* Frame coalescing                                                          */
  /* ------------------------------------------------------------------------ */

  private scheduleFlush(): void {
    if (this.flushHandle !== null) return;
    /* `requestAnimationFrame` rather than a timeout: it is the display's own
       cadence, it pauses when the window is occluded (a background window
       should not burn cycles laying out text nobody can see), and it puts the
       state change immediately before the paint that shows it. */
    this.flushHandle = requestAnimationFrame(() => {
      this.flushHandle = null;
      this.flushNow();
    });
  }

  private cancelFlush(): void {
    if (this.flushHandle === null) return;
    cancelAnimationFrame(this.flushHandle);
    this.flushHandle = null;
  }

  private flushNow(): void {
    this.cancelFlush();
    if (this.pendingText.length > 0) {
      this.liveText += this.pendingText;
      this.pendingText = '';
      this.notify(KEY.liveText);
    }
    if (this.pendingReasoning.length > 0) {
      this.liveReasoning += this.pendingReasoning;
      this.pendingReasoning = '';
      this.notify(KEY.liveReasoning);
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Turn completion                                                           */
  /* ------------------------------------------------------------------------ */

  /**
   * Commit the server's authoritative message and close the live turn.
   *
   * This is the ONE point in a turn where `index` changes, and therefore the
   * one point where the virtualized transcript re-renders. Once per turn is the
   * correct number.
   */
  private commit(message: Message): void {
    const liveId = this.index.liveId;
    const merged: Message = {
      ...message,
      /* The server is authoritative for content, but not for things it never
         saw: a locally chosen effort, and sources that arrived on their own
         frame, both survive a `done` that omits them. */
      sources: message.sources.length > 0 ? message.sources : [...this.pendingSources],
      reasoningEffort: message.reasoningEffort ?? this.liveMeta?.reasoningEffort ?? null,
    };
    this.messages.set(merged.id, merged);
    this.index = {
      ids: liveId !== null && liveId !== merged.id
        ? [...this.index.ids, merged.id]
        : [...this.index.ids.filter((id) => id !== merged.id), merged.id],
      liveId: null,
    };
    this.liveMeta = null;
    this.liveText = '';
    this.liveReasoning = '';
    this.pendingSources = [];
    this.setStatus('idle');
    this.notify(KEY.index);
    this.notify(KEY.liveMeta);
    this.notify(KEY.liveText);
    this.notify(KEY.liveReasoning);
  }

  /**
   * End the turn in failure.
   *
   * `preservePartial` is the difference between "that answer was wrong, discard
   * it" and "that answer was cut off, keep it" — and a user-pressed Stop is the
   * second. Throwing away six paragraphs because someone stopped the model is
   * the most irritating possible reading of this frame.
   */
  private fail(
    message: string,
    preservePartial: boolean,
    retryable: boolean,
    finishReason: Message['finishReason'],
  ): void {
    const meta = this.liveMeta;
    const partial = this.liveText;

    if (preservePartial && (partial.length > 0 || this.liveReasoning.length > 0) && meta) {
      const preserved: Message = {
        id: meta.assistantMessageId,
        role: 'ASSISTANT',
        content: partial,
        reasoning: this.liveReasoning.length > 0 ? this.liveReasoning : null,
        reasoningParts: null,
        reasoningEffort: meta.reasoningEffort,
        model: meta.model,
        createdAt: new Date().toISOString(),
        attachments: [],
        sources: [...this.pendingSources],
        usage: null,
        finishReason: finishReason ?? 'user_stopped',
        errorMessage: message,
      };
      this.messages.set(preserved.id, preserved);
      this.index = { ids: [...this.index.ids, preserved.id], liveId: null };
      this.liveMeta = null;
      this.liveText = '';
      this.liveReasoning = '';
      this.pendingSources = [];
      this.setStatus('idle');
      this.notify(KEY.index);
      this.notify(KEY.liveMeta);
      this.notify(KEY.liveText);
      return;
    }

    /* Nothing worth keeping: the live turn stays open, holding the error, so
       the user sees WHICH turn failed and gets a retry attached to it rather
       than a detached toast. */
    if (meta) this.liveMeta = { ...meta, status: 'error', error: message, retryable };
    this.setStatus('error');
    this.notify(KEY.liveMeta);
  }

  /** Local optimistic stop, before main confirms. */
  markStopping(): void {
    if (this.liveMeta) this.patchLiveMeta({ status: 'stopping' });
    this.setStatus('stopping');
  }

  /**
   * Abandon the live turn without a server frame.
   *
   * Used when the conversation is switched mid-stream. The generation is not
   * cancelled — main keeps reading it and the reply will be there on return —
   * so this only detaches the view.
   */
  detachLiveTurn(): void {
    this.cancelFlush();
    if (this.index.liveId !== null) {
      this.index = { ...this.index, liveId: null };
      this.notify(KEY.index);
    }
    this.liveMeta = null;
    this.liveText = '';
    this.liveReasoning = '';
    this.pendingText = '';
    this.pendingReasoning = '';
    this.pendingSources = [];
    this.setStatus('idle');
    this.notify(KEY.liveMeta);
    this.notify(KEY.liveText);
    this.notify(KEY.liveReasoning);
  }

  /* ------------------------------------------------------------------------ */
  /* Message-level edits                                                       */
  /* ------------------------------------------------------------------------ */

  patchMessage(id: string, patch: Partial<Message>): void {
    const existing = this.messages.get(id);
    if (!existing) return;
    this.messages.set(id, { ...existing, ...patch });
    /* Only this row. The transcript's `index` is untouched, so nothing else in
       the list reconciles. */
    this.notify(KEY.message(id));
  }

  /** Drop a message and everything after it — what an edit-and-resend does. */
  truncateFrom(id: string): void {
    const at = this.index.ids.indexOf(id);
    if (at < 0) return;
    for (const dropped of this.index.ids.slice(at)) this.messages.delete(dropped);
    this.index = { ids: this.index.ids.slice(0, at), liveId: this.index.liveId };
    this.notify(KEY.index);
  }

  private reconcileUserId(serverId: string): void {
    const ids = this.index.ids;
    const lastId = ids[ids.length - 1];
    if (lastId === undefined || lastId === serverId) return;
    const optimistic = this.messages.get(lastId);
    if (!optimistic || optimistic.role !== 'USER') return;
    this.messages.delete(lastId);
    this.messages.set(serverId, { ...optimistic, id: serverId });
    this.index = { ids: [...ids.slice(0, -1), serverId], liveId: this.index.liveId };
    this.notify(KEY.index);
  }

  private patchLiveMeta(patch: Partial<LiveMeta>): void {
    if (!this.liveMeta) return;
    this.liveMeta = { ...this.liveMeta, ...patch };
    this.notify(KEY.liveMeta);
  }

  private setStatus(status: GenerationStatus): void {
    if (this.status === status) return;
    this.status = status;
    if (this.liveMeta && this.liveMeta.status !== status) {
      this.liveMeta = { ...this.liveMeta, status };
      this.notify(KEY.liveMeta);
    }
    this.notify(KEY.status);
  }

  /** Tear-down for unmount; a pending frame callback must not outlive the view. */
  dispose(): void {
    this.cancelFlush();
    this.listeners.clear();
  }
}

type StreamFrameSources = Message['sources'];
