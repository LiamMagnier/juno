/**
 * What the right column shows, and how it survives the temp → server id swap
 * at `done` (SPEC §8.5). The Activity and Research panels share one shell;
 * opening either closes an open artifact or document, and the reverse.
 *
 * Pure: no React, no DOM. chat-view (WS9b) holds the state in a reducer and
 * runs `reconcileRightPanel` against the live message list whenever it
 * changes.
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

type ResearchView = Extract<RightPanelState, { kind: "research" }>["view"];

const NONE: RightPanelState = { kind: "none" };

/**
 * Opening is idempotent: the same panel on the same target returns the SAME
 * state object, so a second press on an open run's line re-renders nothing.
 * Research keeps the view the reader is on when the same run is opened again
 * without naming one — a transcript row's "Open" must not pull them off the
 * report they were reading.
 */
export function rightPanelReducer(state: RightPanelState, action: RightPanelAction): RightPanelState {
  switch (action.type) {
    case "open-activity": {
      if (
        state.kind === "activity" &&
        state.renderKey === action.renderKey &&
        state.focusCallId === action.focusCallId
      ) {
        return state;
      }
      return action.focusCallId
        ? { kind: "activity", renderKey: action.renderKey, focusCallId: action.focusCallId }
        : { kind: "activity", renderKey: action.renderKey };
    }
    case "open-research": {
      const sameRun = state.kind === "research" && state.runId === action.runId;
      const view: ResearchView = action.view ?? (sameRun ? state.view : "progress");
      if (sameRun && state.view === view) return state;
      return { kind: "research", runId: action.runId, view };
    }
    case "close":
    case "conversation-changed":
      return state.kind === "none" ? state : NONE;
  }
}

/** Pure. Keeps the panel open across the temp → server id swap at `done` (bug B1): matches by
 *  `renderKey ?? id`; returns `{ kind: "none" }` only when the message left the list. */
export function reconcileRightPanel(
  state: RightPanelState,
  messages: ReadonlyArray<{ id: string; renderKey?: string }>,
): RightPanelState {
  // A research run is not a message, so the transcript cannot take it away.
  if (state.kind !== "activity") return state;
  // The streaming bubble is created with `renderKey` equal to its temp id, and
  // use-chat carries that key onto the server row that replaces it at `done`,
  // so the key the panel was opened with keeps matching after the id changes.
  // A message loaded from history has no renderKey and is matched by its id.
  return messages.some((message) => (message.renderKey ?? message.id) === state.renderKey) ? state : NONE;
}

/* ─── Coexistence: one right column, newest wins ─────────────────────────────
 * The shell, the canvas and the file viewer all dock on the right, and chat
 * plus any two of them does not fit, so at most one is open. Whichever the
 * reader asked for last is the one they want to look at: opening the shell
 * closes an artifact or a document, and opening either of those closes the
 * shell (DECISIONS U4). `CanvasPanel` and `DocumentViewer` are not touched;
 * chat-view drives the setters it already has from this state.
 */

export interface RightColumnState {
  panel: RightPanelState;
  /** The canvas's artifact, or null. */
  artifactId: string | null;
  /** The file viewer's attachment, or null. */
  documentId: string | null;
}

export type RightColumnAction =
  | RightPanelAction
  | { type: "open-artifact"; artifactId: string }
  | { type: "open-document"; documentId: string }
  | { type: "close-artifact" }
  | { type: "close-document" }
  /** Voice opened. Below the split a docked column would cover the microphone controls, so the
   *  column closes: the existing rule (`chat-view.tsx:970`), applied to the shell unchanged. */
  | { type: "voice-opened"; split: boolean };

export const EMPTY_RIGHT_COLUMN: RightColumnState = { panel: NONE, artifactId: null, documentId: null };

const isEmpty = (state: RightColumnState) =>
  state.panel.kind === "none" && state.artifactId === null && state.documentId === null;

export function rightColumnReducer(state: RightColumnState, action: RightColumnAction): RightColumnState {
  switch (action.type) {
    case "open-activity":
    case "open-research": {
      const panel = rightPanelReducer(state.panel, action);
      if (panel === state.panel && state.artifactId === null && state.documentId === null) return state;
      return { panel, artifactId: null, documentId: null };
    }
    case "open-artifact":
      if (state.artifactId === action.artifactId && state.panel.kind === "none" && state.documentId === null) {
        return state;
      }
      return { panel: NONE, artifactId: action.artifactId, documentId: null };
    case "open-document":
      if (state.documentId === action.documentId && state.panel.kind === "none" && state.artifactId === null) {
        return state;
      }
      return { panel: NONE, artifactId: null, documentId: action.documentId };
    case "close-artifact":
      return state.artifactId === null ? state : { ...state, artifactId: null };
    case "close-document":
      return state.documentId === null ? state : { ...state, documentId: null };
    case "close": {
      const panel = rightPanelReducer(state.panel, action);
      return panel === state.panel ? state : { ...state, panel };
    }
    case "conversation-changed":
      return isEmpty(state) ? state : EMPTY_RIGHT_COLUMN;
    case "voice-opened":
      // Beside the split the column and the voice controls both fit.
      return action.split || isEmpty(state) ? state : EMPTY_RIGHT_COLUMN;
  }
}

/**
 * `?researchRun=<id>` (the redirect from `/research/[id]`) opens the Research
 * panel on load (SPEC §8.5): on the report when the run has one, otherwise on
 * its progress. Null when the parameter is absent or blank.
 */
export function researchPanelFromUrl(
  search: string | URLSearchParams,
  opts: { completed?: boolean } = {},
): Extract<RightPanelAction, { type: "open-research" }> | null {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const runId = params.get("researchRun")?.trim();
  if (!runId) return null;
  return { type: "open-research", runId, view: opts.completed ? "report" : "progress" };
}
