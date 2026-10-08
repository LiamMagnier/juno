/**
 * The right dock's state (DESIGN §4.1, §5.16; INTERACTION I-10), as a pure
 * reducer in the shape of T3 Code's right-panel store: open, tab, width,
 * expanded, and the last tab per thread. Width persists per user; the
 * React hook (`useDock` in components/code/v2) stores it.
 */

export const DOCK_TABS = ["changes", "terminal", "files", "preview", "plan", "agents", "screen"] as const;
export type DockTab = (typeof DOCK_TABS)[number];

export const DOCK_TAB_LABELS: Record<DockTab, string> = {
  changes: "Changes",
  terminal: "Terminal",
  files: "Files",
  preview: "Preview",
  plan: "Plan",
  agents: "Agents",
  screen: "Screen",
};

/** Glyphs from the web icon set. */
export const DOCK_TAB_GLYPHS: Record<DockTab, string> = {
  changes: "diff",
  terminal: "terminal",
  files: "file-tree",
  preview: "browser",
  plan: "plan",
  agents: "agents",
  screen: "computer",
};

export const DOCK_MIN = 360;
export const DOCK_DEFAULT = 460;
export const DOCK_MAX = 760;
/** Release snaps to one of these when within SNAP_DISTANCE px. */
export const DOCK_SNAPS = [360, 460, 760] as const;
export const SNAP_DISTANCE = 16;

export interface DockState {
  open: boolean;
  tab: DockTab;
  width: number;
  expanded: boolean;
  /** Live width while dragging (no animation); null when not dragging. */
  dragWidth: number | null;
  lastTabByThread: Record<string, DockTab>;
}

export type DockAction =
  | { type: "toggle"; tab: DockTab; threadId?: string }
  | { type: "open"; tab: DockTab; threadId?: string }
  | { type: "close" }
  | { type: "drag"; width: number }
  | { type: "release"; width: number }
  | { type: "reset-width" }
  | { type: "toggle-expand" }
  | { type: "thread-changed"; threadId: string };

export const initialDockState = (width = DOCK_DEFAULT): DockState => ({
  open: false,
  tab: "changes",
  width: clampDockWidth(width),
  expanded: false,
  dragWidth: null,
  lastTabByThread: {},
});

export function clampDockWidth(width: number, viewport?: number): number {
  const max = viewport ? Math.min(DOCK_MAX, Math.max(DOCK_MIN, viewport - 420)) : DOCK_MAX;
  if (!Number.isFinite(width)) return DOCK_DEFAULT;
  return Math.round(Math.min(max, Math.max(DOCK_MIN, width)));
}

/** The width a release lands on: a snap point when close to one, else the clamped width. */
export function snapDockWidth(width: number): number {
  const clamped = clampDockWidth(width);
  let best: number = clamped;
  let bestDistance = Infinity;
  for (const snap of DOCK_SNAPS) {
    const d = Math.abs(snap - clamped);
    if (d <= SNAP_DISTANCE && d < bestDistance) {
      best = snap;
      bestDistance = d;
    }
  }
  return best;
}

export function dockReducer(state: DockState, action: DockAction): DockState {
  switch (action.type) {
    case "toggle": {
      // Toggling the active tab closes the dock (DESIGN §4.1).
      if (state.open && state.tab === action.tab) return { ...state, open: false, expanded: false };
      return dockReducer(state, { type: "open", tab: action.tab, threadId: action.threadId });
    }
    case "open":
      return {
        ...state,
        open: true,
        tab: action.tab,
        lastTabByThread: action.threadId ? { ...state.lastTabByThread, [action.threadId]: action.tab } : state.lastTabByThread,
      };
    case "close":
      return { ...state, open: false, expanded: false, dragWidth: null };
    case "drag":
      return { ...state, dragWidth: clampDockWidth(action.width) };
    case "release":
      return { ...state, width: snapDockWidth(action.width), dragWidth: null };
    case "reset-width":
      return { ...state, width: DOCK_DEFAULT, dragWidth: null };
    case "toggle-expand":
      return state.open ? { ...state, expanded: !state.expanded } : state;
    case "thread-changed": {
      const last = state.lastTabByThread[action.threadId];
      return last ? { ...state, tab: last } : state;
    }
  }
}

/** Width to lay out with right now. */
export function effectiveDockWidth(state: DockState): number {
  return state.dragWidth ?? state.width;
}

/** Keyboard resize (←/→ on the focused handle): 16 px steps, Shift for 64. */
export function nudgeDockWidth(width: number, direction: -1 | 1, big = false): number {
  return clampDockWidth(width + direction * (big ? 64 : 16));
}
