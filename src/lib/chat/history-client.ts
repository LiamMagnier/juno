/**
 * The client half of paged history (lib/chat/history-page.ts is the server
 * half, history-merge.ts how a landed page joins the transcript): the request
 * for older messages, and the rule that only one is in flight at a time.
 *
 * Shared by every web transcript that opens on its newest page: Chat
 * (`use-chat`) and both Code surfaces (`use-code-session`). One wire contract,
 * one queueing rule, so the surfaces cannot drift apart on either.
 *
 * Pure apart from the injected fetch, and tested without a DOM
 * (tests/chat-history-client.test.ts).
 */
import type { ClientMessage, ConversationHistory } from "@/types/chat";

/** How far back to read: the next page, through one message, or all the rest. */
export type LoadOlderRequest = { throughMessageId?: string; all?: boolean };

export interface OlderPage {
  messages: ClientMessage[];
  history: ConversationHistory;
}

/** GET /api/conversations/[id]/messages for the page older than `cursor`. */
export function olderHistoryUrl(conversationId: string, cursor: string, request: LoadOlderRequest = {}): string {
  const query = new URLSearchParams({ before: cursor });
  if (request.all) query.set("all", "1");
  else if (request.throughMessageId) query.set("through", request.throughMessageId);
  return `/api/conversations/${conversationId}/messages?${query}`;
}

/** One older page, or null when it could not be read or did not parse. */
export async function fetchOlderHistory(
  conversationId: string,
  cursor: string,
  request: LoadOlderRequest = {},
  fetchImpl: typeof fetch = fetch,
): Promise<OlderPage | null> {
  const res = await fetchImpl(olderHistoryUrl(conversationId, cursor, request));
  if (!res.ok) return null;
  const payload = (await res.json()) as Partial<OlderPage> | null;
  if (!payload || !Array.isArray(payload.messages) || !payload.history) return null;
  return { messages: payload.messages, history: payload.history };
}

/** What a loader reads and writes; refs in a hook, plain values in a test. */
export interface OlderHistoryHost<T extends { id: string }> {
  /** The conversation shown now; a change mid-request discards the page. */
  conversationId(): string | null;
  /** The transcript held now, oldest first. */
  messages(): readonly T[];
  history(): ConversationHistory;
  /** Put a landed page above the transcript; returns the transcript after. */
  land(older: ClientMessage[], history: ConversationHistory): T[];
  setLoading(loading: boolean): void;
  /** Defaults to fetchOlderHistory. */
  fetchPage?: (conversationId: string, cursor: string, request: LoadOlderRequest) => Promise<OlderPage | null>;
}

/**
 * Read older messages into the transcript, above what is held. One request at
 * a time: a second call waits for the first and then decides whether it still
 * has anything to fetch (a jump whose message the first page brought in has
 * nothing left to do). Resolves to the transcript as it stands afterwards, or
 * null when nothing could be read (offline, or the conversation changed
 * underneath).
 */
export function createOlderHistoryLoader<T extends { id: string }>(host: OlderHistoryHost<T>) {
  let inflight: Promise<T[] | null> | null = null;
  const fetchPage = host.fetchPage ?? ((id: string, cursor: string, request: LoadOlderRequest) => fetchOlderHistory(id, cursor, request));

  async function load(request: LoadOlderRequest = {}): Promise<T[] | null> {
    const convoId = host.conversationId();
    if (!convoId) return host.messages() as T[];
    for (let pending = inflight; pending; pending = inflight) {
      const done = await pending;
      if (inflight === pending) inflight = null;
      if (host.conversationId() !== convoId || !done) return null;
    }
    const held = host.history();
    const reached = !!request.throughMessageId && host.messages().some((m) => m.id === request.throughMessageId);
    if (!held.hasOlder || !held.olderCursor || reached) return host.messages() as T[];
    const cursor = held.olderCursor;
    const run = (async () => {
      host.setLoading(true);
      try {
        const page = await fetchPage(convoId, cursor, request);
        if (!page || host.conversationId() !== convoId) return null;
        return host.land(page.messages, page.history);
      } catch {
        return null;
      } finally {
        if (host.conversationId() === convoId) host.setLoading(false);
      }
    })();
    inflight = run;
    try {
      return await run;
    } finally {
      if (inflight === run) inflight = null;
    }
  }

  /** Forget the request in flight: the conversation identity changed. */
  function reset() {
    inflight = null;
  }

  return { load, reset };
}

/** Ask for the next older page this far from the top: about two screens of runway. */
export const LOAD_OLDER_WITHIN_PX = 1600;
/** After a page failed to load, wait this long before scrolling may ask again. */
export const LOAD_OLDER_RETRY_MS = 3000;

/**
 * Whether a transcript scrolled to `scrollTop` should ask for the next older
 * page now: within two screens (or LOAD_OLDER_WITHIN_PX) of the top, and not
 * straight after a failure.
 */
export function shouldLoadOlder(scrollTop: number, viewportHeight: number, failedAt = 0, now = Date.now()): boolean {
  if (scrollTop > Math.max(LOAD_OLDER_WITHIN_PX, viewportHeight * 2)) return false;
  return now - failedAt >= LOAD_OLDER_RETRY_MS;
}
