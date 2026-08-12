/**
 * The Chat product surface.
 *
 * `<ChatProduct>` is the whole seam. The shell mounts it, tells it which
 * conversation is open, and hands it a slot for the Chat · Work control it
 * owns; everything inside — the store, the stream subscription, the
 * virtualized transcript, the composer — is this surface's business and
 * nothing above it needs to know about any of it.
 *
 * Layout, and why it is this shape:
 *
 *     ┌───────────┬──────────────────────────────────────────┐
 *     │           │ header      · surface control, title     │
 *     │  sidebar  ├──────────────────────────────────────────┤
 *     │  (list)   │ banner      · only when not online       │
 *     │           ├──────────────────────────────────────────┤
 *     │           │ transcript  · flat, opaque, virtualized  │
 *     │           │   composer  · floating glass, overlaid   │
 *     └───────────┴──────────────────────────────────────────┘
 *
 * The composer is absolutely positioned OVER the transcript rather than
 * sitting below it in the flow, and the transcript carries bottom padding to
 * match. That is what lets text scroll under a translucent composer instead of
 * stopping dead at an opaque edge — the one place the glass treatment earns
 * itself, and the reason the transcript is flat: something has to be behind
 * the glass, and it should be the words.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { ReasoningEffort } from './contract.js';
import { isBridgeAvailable } from './lib/bridge.js';
import { cn } from './lib/cn.js';
import { clampEffort } from './lib/models.js';
import { Composer } from './components/composer.js';
import { ConversationList } from './components/conversation-list.js';
import { Eyebrow } from './components/primitives.js';
import {
  ConversationError,
  DisconnectedState,
  EmptyConversation,
  OfflineBanner,
  ReconnectingBanner,
  TranscriptSkeleton,
} from './components/states.js';
import { Transcript } from './components/transcript.js';
import {
  ChatContextProvider,
  ModelCatalogProvider,
  useChatActions,
  useChatEngine,
  useConnection,
  useConversation,
  useLoadPhase,
  useModelCatalogLoader,
  useModels,
  useTranscriptIndex,
} from './state/use-chat.js';
import { useConversations } from './state/use-conversations.js';

/* -------------------------------------------------------------------------- */
/* Preferences                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The model and depth the user last chose, remembered per window.
 *
 * Window-local rather than synced: which model you want is a property of what
 * you are doing right now, and inheriting a colleague's — or your own, from a
 * different machine and a different task — is more often wrong than right.
 * Read defensively, because a previous build may have written a model id that
 * no longer exists.
 */
const PREFS_KEY = 'juno.chat.composer.v1';

interface ComposerPrefs {
  readonly model: string | null;
  readonly reasoningEffort: ReasoningEffort | null;
}

function readPrefs(): ComposerPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (raw === null) return { model: null, reasoningEffort: null };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { model: null, reasoningEffort: null };
    const record = parsed as Record<string, unknown>;
    const model = typeof record['model'] === 'string' ? record['model'] : null;
    const effort = record['reasoningEffort'];
    const valid = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    return {
      model,
      reasoningEffort:
        typeof effort === 'string' && valid.includes(effort) ? (effort as ReasoningEffort) : null,
    };
  } catch {
    /* Storage can throw outright — disabled partition, exhausted quota. A
       preference is never worth taking the surface down for. */
    return { model: null, reasoningEffort: null };
  }
}

function writePrefs(prefs: ComposerPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* Losing a preference is not an error worth surfacing. */
  }
}

/* -------------------------------------------------------------------------- */
/* Product                                                                     */
/* -------------------------------------------------------------------------- */

export interface ChatProductProps {
  /** The open conversation, or `null` for a new one. */
  readonly conversationId: string | null;
  /** Fired when the user picks a different conversation, or a new one is created. */
  readonly onConversationChange: (conversationId: string | null) => void;
  /**
   * The shell's Chat · Work control, placed in the header's leading slot.
   *
   * A slot rather than a prop pair, because the shell owns the switch and its
   * state — see `components/chat-work-switch.tsx`. Chat only decides where it
   * goes.
   */
  readonly surfaceControl?: ReactNode;
  /** Set false when the shell draws its own conversation sidebar. */
  readonly showSidebar?: boolean;
  /** The shell's screen-reader announcer, if it has one. */
  readonly announce?: ((message: string, priority?: 'polite' | 'assertive') => void) | undefined;
  readonly className?: string | undefined;
}

export function ChatProduct({
  conversationId,
  onConversationChange,
  surfaceControl,
  showSidebar = true,
  announce,
  className,
}: ChatProductProps): ReactNode {
  const catalog = useModelCatalogLoader();
  const conversations = useConversations();

  const onConversationCreated = useCallback(
    (created: { id: string }) => {
      onConversationChange(created.id);
      void conversations.refresh();
    },
    [conversations, onConversationChange],
  );

  const engine = useChatEngine({
    conversationId,
    onConversationCreated,
    ...(announce !== undefined ? { announce } : {}),
  });

  /* The bridge being absent is a broken build, not a network problem, and it
     has to be checked before anything tries to load — otherwise the user gets
     a loading state that can never resolve. */
  if (!isBridgeAvailable()) {
    return (
      <div className={cn('flex h-full flex-col bg-background', className)}>
        <DisconnectedState />
      </div>
    );
  }

  return (
    <ModelCatalogProvider value={catalog}>
      <ChatContextProvider value={engine}>
        <div className={cn('flex h-full min-h-0 bg-background', className)}>
          {showSidebar ? (
            <ConversationList
              api={conversations}
              activeId={conversationId}
              onSelect={onConversationChange}
              onNew={() => onConversationChange(null)}
              className="w-64 shrink-0"
            />
          ) : null}
          <ChatPane conversationId={conversationId} surfaceControl={surfaceControl} />
        </div>
      </ChatContextProvider>
    </ModelCatalogProvider>
  );
}

/* -------------------------------------------------------------------------- */
/* Pane                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Everything inside the chat context.
 *
 * Split from `<ChatProduct>` purely so it can use the hooks that require the
 * providers `<ChatProduct>` mounts — a component cannot consume a context it
 * is itself providing.
 */
function ChatPane({
  conversationId,
  surfaceControl,
}: {
  conversationId: string | null;
  surfaceControl: ReactNode;
}): ReactNode {
  const phase = useLoadPhase();
  const conversation = useConversation();
  const connection = useConnection();
  const actions = useChatActions();
  const { ids, liveId } = useTranscriptIndex();
  /* From the provider, not a second load — see `useModels`. */
  const catalog = useModels();

  const [prefs, setPrefs] = useState<ComposerPrefs>(readPrefs);

  /* Resolve the effective model once the catalog lands: a remembered id that
     is no longer in the catalog (retired, or outside the current plan) falls
     back to the server's default rather than leaving the composer pointing at
     something that will be rejected on send. */
  const model = useMemo(() => {
    const known = catalog.models.some((entry) => entry.id === prefs.model);
    if (prefs.model !== null && known) return prefs.model;
    return catalog.defaultModel ?? catalog.models[0]?.id ?? '';
  }, [catalog.models, catalog.defaultModel, prefs.model]);

  const effort = useMemo(
    () => clampEffort(prefs.reasoningEffort, catalog.models.find((entry) => entry.id === model)),
    [catalog.models, model, prefs.reasoningEffort],
  );

  useEffect(() => {
    writePrefs({ model, reasoningEffort: effort });
  }, [model, effort]);

  const onModelChange = useCallback((next: string) => {
    setPrefs((current) => ({ ...current, model: next }));
  }, []);

  const onReasoningChange = useCallback((next: ReasoningEffort | null) => {
    setPrefs((current) => ({ ...current, reasoningEffort: next }));
  }, []);

  const empty = ids.length === 0 && liveId === null;

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4">
        {surfaceControl}
        <div className="min-w-0 flex-1">
          {conversation !== null ? (
            <h1 className="truncate text-body font-medium text-foreground">{conversation.title}</h1>
          ) : (
            <Eyebrow>New conversation</Eyebrow>
          )}
        </div>
      </header>

      {connection.status === 'reconnecting' ? (
        <ReconnectingBanner
          detail={connection.detail}
          retryInSeconds={connection.retryInSeconds}
          onRetryNow={() => void actions.reload()}
        />
      ) : connection.status === 'offline' ? (
        <OfflineBanner detail={connection.detail} onRetry={() => void actions.reload()} />
      ) : null}

      {phase.kind === 'loading' ? (
        <TranscriptSkeleton />
      ) : phase.kind === 'error' ? (
        <ConversationError message={phase.message} onRetry={() => void actions.reload()} />
      ) : empty ? (
        <EmptyConversation />
      ) : (
        <Transcript />
      )}

      <Composer
        conversationId={conversationId}
        model={model}
        onModelChange={onModelChange}
        reasoningEffort={effort}
        onReasoningChange={onReasoningChange}
        autoFocus={empty}
      />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Public surface                                                              */
/* -------------------------------------------------------------------------- */

export { ChatWorkSwitch, CHAT_SURFACES, type ChatSurface } from './components/chat-work-switch.js';
export { Transcript } from './components/transcript.js';
export { Composer } from './components/composer.js';
export { ConversationList } from './components/conversation-list.js';
export { Markdown } from './components/markdown-view.js';
export { useConversations } from './state/use-conversations.js';
export type {
  Attachment,
  Conversation,
  ConnectionState,
  GenerationStatus,
  Message,
  ModelDescriptor,
  ReasoningEffort,
  StreamFrame,
} from './contract.js';
export {
  CHAT_EVENT_CHANNEL_NAMES,
  CHAT_INVOKE_CHANNEL_NAMES,
} from './lib/channels.js';
