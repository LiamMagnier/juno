"use client";

import * as React from "react";

/**
 * WHY A CONTEXT AND NOT PROPS.
 *
 * The thought panel is DOCKED: it is a column beside the chat, so its DOM must
 * be a sibling of the chat column in chat-view — it cannot be rendered from
 * inside a scrolling message row. But the trigger, the run model and the run's
 * ONE clock all live in ActivityTimeline, deep inside the message list.
 *
 * Lifting the run itself would be wrong twice over: chat-view would have to
 * rebuild it (a SECOND clock, the bug that was just fixed — see useRunClock),
 * and the 100ms tick would re-render the whole chat tree. So we lift the only
 * thing chat-view actually needs — WHICH message is open, a value that changes
 * once per click — and hand back a `container`: the docked column's DOM node.
 * ActivityTimeline portals the panel into it, keeping the panel in the React
 * tree that owns the clock while the browser paints it beside the chat.
 *
 * This is chat-scoped state that names a chat-view DOM node, so it does not
 * belong in app-provider (user/settings/conversations/sidebar — the app shell,
 * which is mounted ABOVE chat-view and outlives it).
 */
export interface ThoughtPanelContextValue {
  /** id of the message whose thought panel is docked open, or null. */
  openId: string | null;
  /** Opening one closes the canvas — two docked right columns will not fit. */
  setOpenId: (id: string | null) => void;
  /** The docked column, mounted by chat-view as a sibling of the chat column. */
  container: HTMLElement | null;
  /**
   * Put text in the composer and focus it — THE HONEST SUBSTITUTE FOR
   * CLIENT-SIDE TOOL DISPATCH.
   *
   * The panel's "Ask to run again" on a failed connector call cannot re-run
   * anything: a tool call is dispatched by the server inside a generation, and
   * nothing in the browser can start one. A button labelled "Re-run" would
   * therefore be a control the runtime cannot honour — the exact thing the
   * brief's non-negotiable §5 forbids. So the verb is what actually happens:
   * the request is written into the composer and the PERSON presses send.
   *
   * Optional, because the message list is a general component: a surface with
   * no composer simply does not offer the action rather than offering a dead
   * one.
   */
  seedDraft?: (text: string) => void;
}

const ThoughtPanelContext = React.createContext<ThoughtPanelContextValue | null>(null);

export const ThoughtPanelProvider = ThoughtPanelContext.Provider;

/** Null outside chat-view. Callers must degrade rather than throw: the message
 *  list is a general component and the dock is a chat-view affordance. */
export function useThoughtPanel() {
  return React.useContext(ThoughtPanelContext);
}
