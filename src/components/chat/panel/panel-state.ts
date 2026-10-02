/**
 * What the right column shows, and how it survives the temp → server id swap
 * at `done` (SPEC §8.5). The Activity and Research panels share one shell;
 * opening either closes an open artifact or document, and the reverse.
 *
 * WS0 lands the types and signatures; WS6 implements them and WS9b adopts
 * them in chat-view.
 */

export type RightPanelState =
  | { kind: "none" }
  | { kind: "activity"; renderKey: string; focusCallId?: string }
  | { kind: "research"; runId: string; view: "progress" | "sources" | "plan" | "report" | "details" };

export type RightPanelAction =
  | { type: "open-activity"; renderKey: string; focusCallId?: string }
  | { type: "open-research"; runId: string; view?: Extract<RightPanelState, { kind: "research" }>["view"] }
  | { type: "close" }
  | { type: "conversation-changed" };

export function rightPanelReducer(_state: RightPanelState, _action: RightPanelAction): RightPanelState {
  throw new Error("not implemented: WS6");
}

/** Pure. Keeps the panel open across the temp → server id swap at `done` (bug B1): matches by
 *  `renderKey ?? id`; returns `{ kind: "none" }` only when the message left the list. */
export function reconcileRightPanel(
  _state: RightPanelState,
  _messages: ReadonlyArray<{ id: string; renderKey?: string }>,
): RightPanelState {
  throw new Error("not implemented: WS6");
}
