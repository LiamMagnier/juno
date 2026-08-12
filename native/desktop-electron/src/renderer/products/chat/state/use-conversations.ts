/**
 * The conversation list.
 *
 * A separate store from `chat-store.ts` because it has a different lifetime and
 * a different failure mode: the list survives switching conversations, and its
 * loading state must never take the transcript down with it. Folding the two
 * together would mean a failed list refresh blanking a conversation the user is
 * reading.
 *
 * Mutations here are OPTIMISTIC AND REVERTIBLE. Renaming, pinning and archiving
 * apply locally the instant the user acts and roll back if main refuses. This
 * is not gratuitous: all three are one-click operations on a list the user is
 * scanning, and a 200ms delay before a pin moves is long enough to make someone
 * click it twice. Deletion is the exception — it asks first, because it is the
 * one action here that cannot be undone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Conversation } from '../contract.js';
import { chatInvoke, chatSubscribe } from '../lib/bridge.js';

export interface ConversationListState {
  readonly conversations: readonly Conversation[];
  readonly loading: boolean;
  readonly error: string | null;
  readonly query: string;
  readonly showArchived: boolean;
}

export interface ConversationListApi extends ConversationListState {
  setQuery: (query: string) => void;
  setShowArchived: (show: boolean) => void;
  refresh: () => Promise<void>;
  create: () => Promise<Conversation | null>;
  rename: (id: string, title: string) => Promise<void>;
  setPinned: (id: string, pinned: boolean) => Promise<void>;
  setArchived: (id: string, archived: boolean) => Promise<void>;
  remove: (id: string) => Promise<void>;
}

/** Pinned first, then most-recent-first. The server orders this way too. */
function order(conversations: readonly Conversation[]): Conversation[] {
  return [...conversations].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return right.lastMessageAt.localeCompare(left.lastMessageAt);
  });
}

export function useConversations(): ConversationListApi {
  const [conversations, setConversations] = useState<readonly Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);

  /* Debounced so typing does not issue a request per keystroke — main forwards
     these to the backend, and a search-as-you-type that fires eight times for
     an eight-letter word is eight round trips for one answer. */
  const [effectiveQuery, setEffectiveQuery] = useState('');
  useEffect(() => {
    const handle = window.setTimeout(() => setEffectiveQuery(query.trim()), 180);
    return () => window.clearTimeout(handle);
  }, [query]);

  /* Guards against a slow response for an old query overwriting a fast one for
     a newer query — the classic search race. */
  const requestSeq = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const sequence = (requestSeq.current += 1);
    setLoading(true);
    const result = await chatInvoke('chat:list-conversations', {
      query: effectiveQuery,
      includeArchived: showArchived,
      limit: 200,
    });
    if (sequence !== requestSeq.current) return;
    setLoading(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setConversations(order(result.value.conversations));
  }, [effectiveQuery, showArchived]);

  useEffect(() => {
    void load();
  }, [load]);

  /* Changes made elsewhere — another window, a sync from another device, or a
     title the server generated after the first exchange. */
  useEffect(() => {
    return chatSubscribe('chat:conversation-changed', (payload) => {
      setConversations((current) => {
        if (payload.kind === 'delete') {
          return current.filter((conversation) => conversation.id !== payload.conversationId);
        }
        const without = current.filter((conversation) => conversation.id !== payload.conversation.id);
        return order([...without, payload.conversation]);
      });
    });
  }, []);

  /**
   * Apply a change locally, then confirm it. On refusal, put the old row back
   * exactly as it was rather than refetching — a refetch would also discard any
   * other edit made in the meantime.
   */
  const optimistic = useCallback(
    async (
      id: string,
      patch: Partial<Conversation>,
      commit: () => Promise<{ ok: boolean; error?: string }>,
    ): Promise<void> => {
      let previous: Conversation | undefined;
      setConversations((current) => {
        previous = current.find((conversation) => conversation.id === id);
        return order(
          current.map((conversation) =>
            conversation.id === id ? { ...conversation, ...patch } : conversation,
          ),
        );
      });

      const result = await commit();
      if (result.ok) return;

      setError(result.error ?? 'That change could not be saved.');
      const restore = previous;
      if (restore) {
        setConversations((current) =>
          order(current.map((conversation) => (conversation.id === id ? restore : conversation))),
        );
      }
    },
    [],
  );

  const api = useMemo<ConversationListApi>(
    () => ({
      conversations,
      loading,
      error,
      query,
      showArchived,
      setQuery,
      setShowArchived,
      refresh: load,

      create: async () => {
        const result = await chatInvoke('chat:create-conversation', { model: null });
        if (!result.ok) {
          setError(result.error);
          return null;
        }
        setConversations((current) => order([...current, result.value.conversation]));
        return result.value.conversation;
      },

      rename: async (id, title) => {
        await optimistic(id, { title, titleSource: 'manual' }, async () => {
          const result = await chatInvoke('chat:update-conversation', { conversationId: id, title });
          return result.ok ? { ok: true } : { ok: false, error: result.error };
        });
      },

      setPinned: async (id, pinned) => {
        await optimistic(id, { pinned }, async () => {
          const result = await chatInvoke('chat:update-conversation', { conversationId: id, pinned });
          return result.ok ? { ok: true } : { ok: false, error: result.error };
        });
      },

      setArchived: async (id, archived) => {
        await optimistic(
          id,
          { archivedAt: archived ? new Date().toISOString() : null },
          async () => {
            const result = await chatInvoke('chat:update-conversation', {
              conversationId: id,
              archived,
            });
            return result.ok ? { ok: true } : { ok: false, error: result.error };
          },
        );
        /* An archived row leaves the default view, so the list has to be
           re-filtered rather than merely patched. */
        if (!showArchived) {
          setConversations((current) =>
            archived ? current.filter((conversation) => conversation.id !== id) : current,
          );
        }
      },

      remove: async (id) => {
        const removed = conversations.find((conversation) => conversation.id === id);
        setConversations((current) => current.filter((conversation) => conversation.id !== id));
        const result = await chatInvoke('chat:delete-conversation', { conversationId: id });
        if (!result.ok) {
          setError(result.error);
          if (removed) setConversations((current) => order([...current, removed]));
        }
      },
    }),
    [conversations, loading, error, query, showArchived, load, optimistic],
  );

  return api;
}
