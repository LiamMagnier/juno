"use client";

import * as React from "react";

import { citableSourceCount, citationOrder } from "@/lib/panel/sources-split";
import type { ClientMessage } from "@/types/chat";

/*
 * Which message the Activity panel is showing, resolved by its stable
 * `renderKey` from the live list (SPEC §8.3, bug B1).
 *
 * The panel is keyed by `renderKey`, never by the message id: the streaming
 * bubble's temp id is swapped for the server's at `done`, and use-chat carries
 * the key across, so a panel opened mid-run stays open through completion. It
 * closes when the reader closes it, when the conversation changes, or when the
 * message leaves the list — and then it exits showing its last content, which
 * is why this keeps the last message it found.
 *
 * NO RE-RENDER PER ANSWER TOKEN (DECISIONS U5). chat-view re-renders on every
 * streamed token, so the list reaches the panel through a small external store
 * rather than a context value, and the panel's selector returns the previous
 * message object unless something the panel draws changed: the activity log,
 * the reasoning, the sources, the approvals, the usage, the ending — or the
 * citations in the answer, which the Sources tab splits on. Answer text alone
 * never re-renders it.
 */

export type PanelMessage = ClientMessage & {
  renderKey?: string;
  streaming?: boolean;
  error?: boolean;
};

export interface PanelMessageSource {
  subscribe(onChange: () => void): () => void;
  getMessages(): ReadonlyArray<PanelMessage>;
}

export interface WritablePanelMessageSource extends PanelMessageSource {
  set(messages: ReadonlyArray<PanelMessage>): void;
}

export function createPanelMessageSource(initial: ReadonlyArray<PanelMessage> = []): WritablePanelMessageSource {
  let messages = initial;
  const listeners = new Set<() => void>();
  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        listeners.delete(onChange);
      };
    },
    getMessages: () => messages,
    set(next) {
      if (next === messages) return;
      messages = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/** The message a panel opened on `renderKey` shows: matched by `renderKey ?? id`, as `reconcileRightPanel` does. */
export function findPanelMessage(messages: ReadonlyArray<PanelMessage>, renderKey: string): PanelMessage | null {
  return messages.find((message) => (message.renderKey ?? message.id) === renderKey) ?? null;
}

const citationKeys = new WeakMap<object, string>();

/** The answer's citation order, the only thing about `content` the panel reads. Cached per message object. */
function citationKey(message: PanelMessage): string {
  const cached = citationKeys.get(message);
  if (cached !== undefined) return cached;
  const key = citationOrder(message.content ?? "", citableSourceCount(message.sources)).join(",");
  citationKeys.set(message, key);
  return key;
}

function lastOf<T>(list: readonly T[] | null | undefined): T | undefined {
  return list && list.length > 0 ? list[list.length - 1] : undefined;
}

/**
 * True when the panel would draw `next` exactly as it draws `prev`. Every field
 * the panel reads is compared; `content` only through whether there is any
 * (the header's "answer started") and its citation order.
 */
export function samePanelMessage(prev: PanelMessage, next: PanelMessage): boolean {
  if (prev === next) return true;
  if (
    prev.id !== next.id ||
    prev.activity !== next.activity ||
    prev.sources !== next.sources ||
    prev.approvals !== next.approvals ||
    prev.reasoning !== next.reasoning ||
    (prev.reasoningParts?.length ?? 0) !== (next.reasoningParts?.length ?? 0) ||
    lastOf(prev.reasoningParts) !== lastOf(next.reasoningParts) ||
    prev.streaming !== next.streaming ||
    prev.error !== next.error ||
    prev.finishReason !== next.finishReason ||
    prev.errorMessage !== next.errorMessage ||
    prev.promptTokens !== next.promptTokens ||
    prev.model !== next.model ||
    Boolean(prev.content) !== Boolean(next.content)
  ) {
    return false;
  }
  return prev.content === next.content || citationKey(prev) === citationKey(next);
}

export interface PanelMessageSelection {
  /** The message, or the last one found once it has left the list. */
  message: PanelMessage | null;
  /** False once the message is no longer in the list (the panel is exiting). */
  present: boolean;
}

const EMPTY_SELECTION: PanelMessageSelection = { message: null, present: false };

/**
 * A memoised selector over one source: the same selection object until
 * something the panel draws changes. Exported for the tests; the hook below is
 * the only caller in the app.
 */
export function createPanelMessageSelector(renderKey: string) {
  let lastMessages: ReadonlyArray<PanelMessage> | null = null;
  let selection: PanelMessageSelection = EMPTY_SELECTION;
  return (messages: ReadonlyArray<PanelMessage>): PanelMessageSelection => {
    if (messages === lastMessages) return selection;
    lastMessages = messages;
    const found = findPanelMessage(messages, renderKey);
    if (found) {
      if (!(selection.present && selection.message && samePanelMessage(selection.message, found))) {
        selection = { message: found, present: true };
      }
    } else if (selection.present || selection === EMPTY_SELECTION) {
      selection = selection.message ? { message: selection.message, present: false } : EMPTY_SELECTION;
    }
    return selection;
  };
}

const PanelMessagesContext = React.createContext<PanelMessageSource | null>(null);

const noSubscribe = () => () => {};
const noMessages: ReadonlyArray<PanelMessage> = [];

export function usePanelMessage(renderKey: string): PanelMessageSelection {
  const source = React.useContext(PanelMessagesContext);
  const getSnapshot = React.useMemo(() => {
    const select = createPanelMessageSelector(renderKey);
    return () => select(source?.getMessages() ?? noMessages);
  }, [source, renderKey]);
  return React.useSyncExternalStore(source?.subscribe ?? noSubscribe, getSnapshot, getSnapshot);
}

const useIsomorphicLayoutEffect = typeof window === "undefined" ? React.useEffect : React.useLayoutEffect;

/**
 * Hands the live message list to every panel below it. chat-view (WS9b) wraps
 * the right column in it with `chat.messages`; the `/dev/run` gallery wraps its
 * panel states in it with the player's message. The provider's own value never
 * changes, so nothing under it re-renders because the list did.
 */
export function PanelMessagesProvider({
  messages,
  children,
}: {
  messages: ReadonlyArray<PanelMessage>;
  children: React.ReactNode;
}) {
  const [source] = React.useState(() => createPanelMessageSource(messages));
  useIsomorphicLayoutEffect(() => {
    source.set(messages);
  }, [source, messages]);
  return React.createElement(PanelMessagesContext.Provider, { value: source }, children);
}
