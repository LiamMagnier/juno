/**
 * React's view of the chat store.
 *
 * Every hook here is a *narrow* subscription. That is the whole point: a
 * component calls `useMessage(id)` and is woken for that message and nothing
 * else, or `useLiveText()` and is woken by tokens without also being woken by
 * the conversation title changing. The store does the addressing (see
 * `chat-store.ts`); this module is the `useSyncExternalStore` plumbing that
 * makes it usable, plus the action layer that turns intents into IPC.
 *
 * Two rules that are easy to break and expensive to debug:
 *
 *   · **`subscribe` must be stable per key.** `useSyncExternalStore` re-runs
 *     the subscription whenever the function identity changes, so an inline
 *     arrow would unsubscribe and resubscribe on every render — and would lose
 *     notifications in the gap. Every one below is a `useCallback` keyed on the
 *     store and the key.
 *   · **`getSnapshot` must return a stable reference between notifications.**
 *     Returning a fresh object is an infinite render loop, not a slow render.
 *     The store holds immutable snapshots for exactly this reason; no hook here
 *     derives a new object inside the getter.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type {
  Attachment,
  Conversation,
  ConnectionState,
  GenerationStatus,
  Message,
  ModelDescriptor,
  ReasoningEffort,
} from '../contract.js';
import { chatInvoke, chatSubscribe } from '../lib/bridge.js';
import { ChatStore, KEY, type LiveMeta, type LoadPhase, type TranscriptIndex } from './chat-store.js';

/* -------------------------------------------------------------------------- */
/* Ids                                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A client-side id.
 *
 * `crypto.randomUUID` is only defined in a secure context, and a packaged
 * Electron app loaded from `file://` is not one. The fallback is not
 * cryptographic and does not need to be — this value is an idempotency key for
 * one message, checked against one conversation, and it is never a secret.
 */
export function clientId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* -------------------------------------------------------------------------- */
/* Context                                                                     */
/* -------------------------------------------------------------------------- */

export interface ChatActions {
  /** Open a conversation, or `null` for a fresh one. */
  openConversation: (conversationId: string | null) => Promise<void>;
  send: (input: {
    text: string;
    attachments: readonly Attachment[];
    model: string;
    reasoningEffort: ReasoningEffort | null;
  }) => Promise<void>;
  stop: () => Promise<void>;
  retry: (messageId: string, overrides?: { model?: string; reasoningEffort?: ReasoningEffort | null }) => Promise<void>;
  editAndResend: (messageId: string, text: string) => Promise<void>;
  fork: (messageId: string) => Promise<Conversation | null>;
  /** Clears a failed live turn without retrying it. */
  dismissError: () => void;
  reload: () => Promise<void>;
}

interface ChatContextValue {
  readonly store: ChatStore;
  readonly actions: ChatActions;
  readonly conversationId: string | null;
}

const ChatContext = createContext<ChatContextValue | null>(null);

export function useChatContext(): ChatContextValue {
  const context = useContext(ChatContext);
  if (!context) throw new Error('Chat hooks must be used inside <ChatProvider>.');
  return context;
}

export const ChatContextProvider = ChatContext.Provider;
export type { ChatContextValue };

/* -------------------------------------------------------------------------- */
/* Selector hooks                                                              */
/* -------------------------------------------------------------------------- */

function useStoreValue<T>(key: string, read: (store: ChatStore) => T): T {
  const { store } = useChatContext();
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(key, listener),
    [store, key],
  );
  const snapshot = useCallback(() => read(store), [store, read]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

const readIndex = (store: ChatStore): TranscriptIndex => store.getIndex();
const readStatus = (store: ChatStore): GenerationStatus => store.getStatus();
const readConnection = (store: ChatStore): ConnectionState => store.getConnection();
const readPhase = (store: ChatStore): LoadPhase => store.getPhase();
const readConversation = (store: ChatStore): Conversation | null => store.getConversation();
const readLiveMeta = (store: ChatStore): LiveMeta | null => store.getLiveMeta();
const readLiveText = (store: ChatStore): string => store.getLiveText();
const readLiveReasoning = (store: ChatStore): string => store.getLiveReasoning();

/**
 * The ordered message ids.
 *
 * This is the ONLY thing the virtualized transcript subscribes to, and it is
 * deliberately ids rather than messages: editing a message's content notifies
 * `msg:<id>` and leaves this snapshot untouched, so the list does not
 * reconcile. It changes when the shape of the conversation changes, which over
 * a streaming turn is exactly once.
 */
export function useTranscriptIndex(): TranscriptIndex {
  return useStoreValue(KEY.index, readIndex);
}

/** One message. Subscribes to that message alone. */
export function useMessage(id: string): Message | undefined {
  const { store } = useChatContext();
  const subscribe = useCallback(
    (listener: () => void) => store.subscribe(KEY.message(id), listener),
    [store, id],
  );
  const snapshot = useCallback(() => store.getMessage(id), [store, id]);
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function useChatStatus(): GenerationStatus {
  return useStoreValue(KEY.status, readStatus);
}

export function useConnection(): ConnectionState {
  return useStoreValue(KEY.connection, readConnection);
}

export function useLoadPhase(): LoadPhase {
  return useStoreValue(KEY.phase, readPhase);
}

export function useConversation(): Conversation | null {
  return useStoreValue(KEY.conversation, readConversation);
}

export function useLiveMeta(): LiveMeta | null {
  return useStoreValue(KEY.liveMeta, readLiveMeta);
}

/** The streaming answer buffer. Re-renders at most once per animation frame. */
export function useLiveText(): string {
  return useStoreValue(KEY.liveText, readLiveText);
}

export function useLiveReasoning(): string {
  return useStoreValue(KEY.liveReasoning, readLiveReasoning);
}

export function useChatActions(): ChatActions {
  return useChatContext().actions;
}

export function useIsBusy(): boolean {
  const status = useChatStatus();
  return (
    status === 'checking' ||
    status === 'submitting' ||
    status === 'thinking' ||
    status === 'writing' ||
    status === 'stopping'
  );
}

/* -------------------------------------------------------------------------- */
/* The model catalog                                                           */
/* -------------------------------------------------------------------------- */

export interface ModelCatalog {
  readonly models: readonly ModelDescriptor[];
  readonly defaultModel: string | null;
  readonly loading: boolean;
  readonly error: string | null;
}

const EMPTY_CATALOG: ModelCatalog = { models: [], defaultModel: null, loading: true, error: null };

const ModelCatalogContext = createContext<ModelCatalog>(EMPTY_CATALOG);
export const ModelCatalogProvider = ModelCatalogContext.Provider;

/**
 * The catalog, read from context.
 *
 * Context rather than a hook that fetches, because the message-actions menu
 * lives on every row: a fetching hook would issue one IPC call per visible
 * message, and a thousand of them on a long transcript. `<ChatProduct>` loads
 * it once with `useModelCatalogLoader` and publishes it here.
 */
export function useModels(): ModelCatalog {
  return useContext(ModelCatalogContext);
}

/**
 * Fetched once from main, never guessed.
 *
 * A hardcoded model list in the renderer goes stale the day the backend adds a
 * model, and — worse — would show models the signed-in user's plan does not
 * include. `lockedReason` comes down with each entry so the picker can render
 * those disabled *with the reason*, instead of hiding them and leaving the user
 * to wonder why the model their colleague mentioned is missing.
 */
export function useModelCatalogLoader(): ModelCatalog {
  const [catalog, setCatalog] = useState<ModelCatalog>(EMPTY_CATALOG);

  useEffect(() => {
    let live = true;
    void (async () => {
      const result = await chatInvoke('chat:models');
      if (!live) return;
      if (result.ok) {
        setCatalog({
          models: result.value.models,
          defaultModel: result.value.defaultModel,
          loading: false,
          error: null,
        });
      } else {
        setCatalog({ models: [], defaultModel: null, loading: false, error: result.error });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  return catalog;
}

/* -------------------------------------------------------------------------- */
/* The engine                                                                  */
/* -------------------------------------------------------------------------- */

export interface UseChatEngineOptions {
  readonly conversationId: string | null;
  readonly onConversationCreated?: (conversation: Conversation) => void;
  readonly announce?: (message: string, priority?: 'polite' | 'assertive') => void;
}

/**
 * Owns the store, the stream subscription and the action implementations.
 *
 * Mounted once by `<ChatProduct>`. The store instance is created with `useRef`
 * rather than `useState`, because it must exist before the first render — the
 * subscription effect and the first `useSyncExternalStore` snapshot both run
 * against it — and it must never be recreated: a new store mid-session would
 * silently orphan every subscription pointing at the old one.
 */
export function useChatEngine(options: UseChatEngineOptions): ChatContextValue {
  const { conversationId, onConversationCreated, announce } = options;

  const storeRef = useRef<ChatStore | null>(null);
  storeRef.current ??= new ChatStore();
  const store = storeRef.current;

  /* The id of the turn currently being streamed, used to reject frames from a
     turn the user has already navigated away from. Main may still be reading
     that stream — abandoning the view does not cancel the generation. */
  const liveTurnRef = useRef<string | null>(null);
  const conversationIdRef = useRef<string | null>(conversationId);
  conversationIdRef.current = conversationId;

  useEffect(() => () => store.dispose(), [store]);

  /* --- stream ------------------------------------------------------------- */
  useEffect(() => {
    return chatSubscribe('chat:stream', (payload) => {
      /* Two guards, both real. A frame for another conversation arrives when
         a background generation finishes; a frame for a superseded turn
         arrives when the user retried before the first turn ended. */
      if (payload.conversationId !== conversationIdRef.current) return;
      if (liveTurnRef.current !== null && payload.assistantMessageId !== liveTurnRef.current) return;
      store.applyFrame(payload.frame);
      if (payload.frame.type === 'done' || payload.frame.type === 'error') {
        liveTurnRef.current = null;
        announce?.(
          payload.frame.type === 'done' ? 'Response complete.' : 'The response failed.',
          payload.frame.type === 'done' ? 'polite' : 'assertive',
        );
      }
    });
  }, [store, announce]);

  /* --- connection --------------------------------------------------------- */
  useEffect(() => {
    return chatSubscribe('chat:connection', (state) => {
      store.setConnection(state);
    });
  }, [store]);

  /* --- load --------------------------------------------------------------- */
  const load = useCallback(
    async (id: string | null): Promise<void> => {
      if (id === null) {
        store.load(null, []);
        return;
      }
      store.setPhase({ kind: 'loading' });
      const result = await chatInvoke('chat:get-conversation', { conversationId: id });
      if (conversationIdRef.current !== id) return;
      if (!result.ok) {
        store.setPhase({ kind: 'error', message: result.error });
        return;
      }
      store.load(result.value.conversation, result.value.messages);
    },
    [store],
  );

  useEffect(() => {
    /* Switching conversation detaches the view from any live turn without
       cancelling it server-side — the reply keeps generating and will be there
       on return. */
    liveTurnRef.current = null;
    store.detachLiveTurn();
    void load(conversationId);
  }, [conversationId, load, store]);

  /* --- actions ------------------------------------------------------------ */
  const actions = useMemo<ChatActions>(() => {
    const openConversation = async (id: string | null): Promise<void> => {
      await load(id);
    };

    const send: ChatActions['send'] = async (input) => {
      if (store.isBusy()) return;
      const text = input.text.trim();
      if (text.length === 0 && input.attachments.length === 0) return;

      const optimisticUserId = clientId();
      const optimisticAssistantId = clientId();
      liveTurnRef.current = optimisticAssistantId;

      store.beginTurn({
        userMessage: {
          id: optimisticUserId,
          role: 'USER',
          content: text,
          reasoning: null,
          reasoningParts: null,
          reasoningEffort: null,
          model: null,
          createdAt: new Date().toISOString(),
          attachments: [...input.attachments],
          sources: [],
          usage: null,
          finishReason: null,
          errorMessage: null,
        },
        assistantMessageId: optimisticAssistantId,
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      });

      const result = await chatInvoke('chat:send', {
        conversationId: conversationIdRef.current,
        clientMessageId: optimisticUserId,
        text,
        attachmentIds: input.attachments.map((attachment) => attachment.id),
        model: input.model,
        reasoningEffort: input.reasoningEffort,
      });

      if (!result.ok) {
        liveTurnRef.current = null;
        store.applyFrame({
          type: 'error',
          message: result.error,
          finishReason: 'network_error',
          preservePartial: false,
          retryable: true,
        });
        return;
      }

      /* Frames are keyed on the server's assistant id from here on. */
      liveTurnRef.current = result.value.assistantMessageId;

      const existing = store.getConversation();
      if (existing === null && onConversationCreated) {
        const created = await chatInvoke('chat:get-conversation', {
          conversationId: result.value.conversationId,
        });
        if (created.ok) {
          store.setConversation(created.value.conversation);
          onConversationCreated(created.value.conversation);
        }
      }
    };

    const stop: ChatActions['stop'] = async () => {
      const id = store.getConversation()?.id ?? conversationIdRef.current;
      if (id === null) return;
      store.markStopping();
      const result = await chatInvoke('chat:stop', { conversationId: id });
      if (!result.ok) {
        /* The turn is still running as far as we know, so the honest thing is
           to say the stop failed rather than to fake a stopped state. */
        store.applyFrame({
          type: 'error',
          message: `Could not stop the response. ${result.error}`,
          finishReason: 'error',
          preservePartial: true,
          retryable: true,
        });
      }
    };

    const retry: ChatActions['retry'] = async (messageId, overrides) => {
      const id = store.getConversation()?.id ?? conversationIdRef.current;
      if (id === null || store.isBusy()) return;
      const previous = store.getMessage(messageId);
      const optimisticId = clientId();
      liveTurnRef.current = optimisticId;
      store.beginRerun({
        assistantMessageId: optimisticId,
        model: overrides?.model ?? previous?.model ?? store.getConversation()?.model ?? '',
        reasoningEffort: overrides?.reasoningEffort ?? previous?.reasoningEffort ?? null,
        replacing: messageId,
      });

      const result = await chatInvoke('chat:retry', {
        conversationId: id,
        messageId,
        model: overrides?.model ?? null,
        reasoningEffort: overrides?.reasoningEffort ?? null,
      });
      if (!result.ok) {
        liveTurnRef.current = null;
        store.applyFrame({
          type: 'error',
          message: result.error,
          finishReason: 'network_error',
          preservePartial: false,
          retryable: true,
        });
        return;
      }
      liveTurnRef.current = result.value.assistantMessageId;
    };

    const editAndResend: ChatActions['editAndResend'] = async (messageId, text) => {
      const id = store.getConversation()?.id ?? conversationIdRef.current;
      if (id === null || store.isBusy()) return;

      const edited = store.getMessage(messageId);
      store.patchMessage(messageId, { content: text });

      /* Everything after the edited message is now wrong, so it goes before the
         new turn starts rather than being left on screen contradicting it. */
      const index = store.getIndex();
      const position = index.ids.indexOf(messageId);
      if (position >= 0 && position + 1 < index.ids.length) {
        const next = index.ids[position + 1];
        if (next !== undefined) store.truncateFrom(next);
      }

      const optimisticId = clientId();
      liveTurnRef.current = optimisticId;
      store.beginRerun({
        assistantMessageId: optimisticId,
        model: edited?.model ?? store.getConversation()?.model ?? '',
        reasoningEffort: null,
        replacing: null,
      });

      const result = await chatInvoke('chat:edit-message', { conversationId: id, messageId, text });
      if (!result.ok) {
        liveTurnRef.current = null;
        store.applyFrame({
          type: 'error',
          message: result.error,
          finishReason: 'network_error',
          preservePartial: false,
          retryable: true,
        });
        return;
      }
      liveTurnRef.current = result.value.assistantMessageId;
    };

    const fork: ChatActions['fork'] = async (messageId) => {
      const id = store.getConversation()?.id ?? conversationIdRef.current;
      if (id === null) return null;
      const result = await chatInvoke('chat:fork', { conversationId: id, messageId });
      if (!result.ok) return null;
      return result.value.conversation;
    };

    const dismissError = (): void => {
      store.detachLiveTurn();
    };

    const reload = async (): Promise<void> => {
      await load(conversationIdRef.current);
    };

    return { openConversation, send, stop, retry, editAndResend, fork, dismissError, reload };
  }, [store, load, onConversationCreated]);

  return useMemo(() => ({ store, actions, conversationId }), [store, actions, conversationId]);
}
