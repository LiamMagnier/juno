"use client";

import * as React from "react";

/**
 * What a Live UI view needs from the transcript around it: the message it
 * belongs to (so adjusted values persist per message) and a way to send a
 * follow-up prompt as the user's next message — the same send path the
 * follow-up suggestions under a reply use (chat-view.tsx).
 *
 * A context rather than props because the view is rendered by react-markdown
 * from a fence, three components below anything that knows the message.
 * Providers nest: chat-view supplies `onPrompt`, message-item adds `messageId`.
 */
export interface LiveUIHost {
  messageId?: string;
  onPrompt?: (text: string) => void;
}

const LiveUIHostContext = React.createContext<LiveUIHost>({});

export function LiveUIHostProvider({ value, children }: { value: LiveUIHost; children: React.ReactNode }) {
  const parent = React.useContext(LiveUIHostContext);
  const merged = React.useMemo<LiveUIHost>(
    () => ({
      messageId: value.messageId ?? parent.messageId,
      onPrompt: value.onPrompt ?? parent.onPrompt,
    }),
    [parent.messageId, parent.onPrompt, value.messageId, value.onPrompt],
  );
  return <LiveUIHostContext.Provider value={merged}>{children}</LiveUIHostContext.Provider>;
}

export function useLiveUIHost(): LiveUIHost {
  return React.useContext(LiveUIHostContext);
}
