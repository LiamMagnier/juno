/**
 * Where the user is, and what the window looks like.
 *
 * One reducer owns product mode, pane geometry and the palette, because those
 * three are not independent: opening the palette while the sidebar is
 * collapsing, or switching product mode while the inspector is open, are the
 * transitions that produce inconsistent shells when each piece keeps its own
 * `useState` next to the component that draws it.
 *
 * Two things arrive here from outside React and both are handled in this file
 * so that no component has to know they exist:
 *
 *   - **Keyboard shortcuts**, registered once on `window`. Registering them per
 *     component means two components can claim ⌘K and the winner depends on
 *     mount order.
 *   - **`app:command`**, which is the native menu bar and the global shortcut
 *     talking to us. Main owns the menu; the renderer owns what the menu items
 *     mean. Unknown commands are logged rather than ignored, because a menu
 *     item that silently does nothing is the worst of the possible failures.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import { subscribe } from '../lib/bridge.js';
import {
  STORAGE_KEYS,
  asBoolean,
  asMember,
  asNumberInRange,
  asRecord,
  readStoredJson,
  writeStoredJson,
} from '../lib/storage.js';
import { useAnnounce } from './announcer.js';

/** The two first-class product spaces. Everything else is a surface inside one. */
export const PRODUCT_MODES = ['chat', 'code'] as const;
export type ProductMode = (typeof PRODUCT_MODES)[number];

/** Chat contains two surfaces; Code contains one (for now). */
export const CHAT_SURFACES = ['chat', 'work'] as const;
export type ChatSurface = (typeof CHAT_SURFACES)[number];

/* Bounds are exported because the resize handle publishes them as
   aria-valuemin/aria-valuemax, and a separator whose announced range disagrees
   with the range it enforces is worse than one with no range at all. */
export const SIDEBAR_MIN_WIDTH = 208;
export const SIDEBAR_MAX_WIDTH = 380;
export const SIDEBAR_DEFAULT_WIDTH = 260;
export const INSPECTOR_MIN_WIDTH = 260;
export const INSPECTOR_MAX_WIDTH = 520;
export const INSPECTOR_DEFAULT_WIDTH = 320;

interface ShellState {
  readonly productMode: ProductMode;
  readonly chatSurface: ChatSurface;
  readonly sidebarCollapsed: boolean;
  readonly sidebarWidth: number;
  readonly inspectorOpen: boolean;
  readonly inspectorWidth: number;
  readonly paletteOpen: boolean;
  readonly activeWorkspaceId: string | null;
}

type ShellAction =
  | { type: 'set-product-mode'; mode: ProductMode }
  | { type: 'set-chat-surface'; surface: ChatSurface }
  | { type: 'toggle-sidebar' }
  | { type: 'set-sidebar-collapsed'; collapsed: boolean }
  | { type: 'set-sidebar-width'; width: number }
  | { type: 'toggle-inspector' }
  | { type: 'set-inspector-open'; open: boolean }
  | { type: 'set-inspector-width'; width: number }
  | { type: 'set-palette-open'; open: boolean }
  | { type: 'set-active-workspace'; workspaceId: string | null };

const INITIAL_STATE: ShellState = {
  productMode: 'chat',
  chatSurface: 'chat',
  sidebarCollapsed: false,
  sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
  inspectorOpen: false,
  inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
  paletteOpen: false,
  activeWorkspaceId: null,
};

function reducer(state: ShellState, action: ShellAction): ShellState {
  switch (action.type) {
    case 'set-product-mode':
      if (state.productMode === action.mode) return state;
      /* Closing the palette on a mode change is not tidiness: the palette's
         command list is scoped to the mode, so leaving it open would leave the
         user looking at commands that no longer apply to what is behind it. */
      return { ...state, productMode: action.mode, paletteOpen: false };
    case 'set-chat-surface':
      return state.chatSurface === action.surface ? state : { ...state, chatSurface: action.surface };
    case 'toggle-sidebar':
      return { ...state, sidebarCollapsed: !state.sidebarCollapsed };
    case 'set-sidebar-collapsed':
      return { ...state, sidebarCollapsed: action.collapsed };
    case 'set-sidebar-width':
      return {
        ...state,
        sidebarCollapsed: false,
        sidebarWidth: clamp(action.width, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH),
      };
    case 'toggle-inspector':
      return { ...state, inspectorOpen: !state.inspectorOpen };
    case 'set-inspector-open':
      return { ...state, inspectorOpen: action.open };
    case 'set-inspector-width':
      return { ...state, inspectorWidth: clamp(action.width, INSPECTOR_MIN_WIDTH, INSPECTOR_MAX_WIDTH) };
    case 'set-palette-open':
      return state.paletteOpen === action.open ? state : { ...state, paletteOpen: action.open };
    case 'set-active-workspace':
      return { ...state, activeWorkspaceId: action.workspaceId };
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

interface ShellApi extends ShellState {
  setProductMode: (mode: ProductMode) => void;
  setChatSurface: (surface: ChatSurface) => void;
  toggleSidebar: () => void;
  setSidebarWidth: (width: number) => void;
  toggleInspector: () => void;
  setInspectorWidth: (width: number) => void;
  openPalette: () => void;
  closePalette: () => void;
  setActiveWorkspace: (workspaceId: string | null) => void;
}

const ShellContext = createContext<ShellApi | null>(null);

export function ShellStateProvider({ children }: { children: ReactNode }): ReactNode {
  const announce = useAnnounce();
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE, restore);

  /* Persisted without the transient bits: a window that reopens with the
     command palette already up would be a small horror. */
  useEffect(() => {
    writeStoredJson(STORAGE_KEYS.shell, {
      productMode: state.productMode,
      chatSurface: state.chatSurface,
      sidebarCollapsed: state.sidebarCollapsed,
      sidebarWidth: state.sidebarWidth,
      inspectorOpen: state.inspectorOpen,
      inspectorWidth: state.inspectorWidth,
    });
  }, [
    state.productMode,
    state.chatSurface,
    state.sidebarCollapsed,
    state.sidebarWidth,
    state.inspectorOpen,
    state.inspectorWidth,
  ]);

  const setProductMode = useCallback(
    (mode: ProductMode) => {
      dispatch({ type: 'set-product-mode', mode });
      announce(`${mode === 'chat' ? 'Chat' : 'Code'} mode`);
    },
    [announce],
  );

  const setChatSurface = useCallback(
    (surface: ChatSurface) => {
      dispatch({ type: 'set-chat-surface', surface });
      announce(`${surface === 'chat' ? 'Chat' : 'Work'} surface`);
    },
    [announce],
  );

  const api = useMemo<ShellApi>(
    () => ({
      ...state,
      setProductMode,
      setChatSurface,
      toggleSidebar: () => dispatch({ type: 'toggle-sidebar' }),
      setSidebarWidth: (width) => dispatch({ type: 'set-sidebar-width', width }),
      toggleInspector: () => dispatch({ type: 'toggle-inspector' }),
      setInspectorWidth: (width) => dispatch({ type: 'set-inspector-width', width }),
      openPalette: () => dispatch({ type: 'set-palette-open', open: true }),
      closePalette: () => dispatch({ type: 'set-palette-open', open: false }),
      setActiveWorkspace: (workspaceId) => dispatch({ type: 'set-active-workspace', workspaceId }),
    }),
    [state, setProductMode, setChatSurface],
  );

  /* ---------------------------------------------------------------------- */
  /* Keyboard                                                                */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      /* Only ⌘-chords are claimed globally. A bare letter shortcut in a shell
         that contains a composer is a shortcut that fires while the user is
         writing a sentence about it. */
      if (!event.metaKey || event.ctrlKey) return;

      const key = event.key.toLowerCase();
      if (key === 'k' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        dispatch({ type: 'set-palette-open', open: true });
        return;
      }
      if (key === 'b' && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        dispatch({ type: 'toggle-sidebar' });
        return;
      }
      if (key === 'i' && event.altKey) {
        event.preventDefault();
        dispatch({ type: 'toggle-inspector' });
        return;
      }
      if (key === '1' && !event.altKey) {
        event.preventDefault();
        setProductMode('chat');
        return;
      }
      if (key === '2' && !event.altKey) {
        event.preventDefault();
        setProductMode('code');
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setProductMode]);

  /* ---------------------------------------------------------------------- */
  /* Menu commands from main                                                 */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    return subscribe('app:command', ({ command }) => {
      switch (command) {
        case 'palette.open':
          dispatch({ type: 'set-palette-open', open: true });
          return;
        case 'palette.close':
          dispatch({ type: 'set-palette-open', open: false });
          return;
        case 'sidebar.toggle':
          dispatch({ type: 'toggle-sidebar' });
          return;
        case 'inspector.toggle':
          dispatch({ type: 'toggle-inspector' });
          return;
        case 'mode.chat':
          setProductMode('chat');
          return;
        case 'mode.code':
          setProductMode('code');
          return;
        case 'surface.chat':
          setChatSurface('chat');
          return;
        case 'surface.work':
          setChatSurface('work');
          return;
        default:
          /* Loud, because the alternative is a menu item that appears broken
             and a bug report that says "the menu doesn't work". */
          console.warn(`[shell] unhandled app:command "${command}"`);
          announce('That menu command is not available in this build.');
      }
    });
  }, [announce, setChatSurface, setProductMode]);

  return <ShellContext.Provider value={api}>{children}</ShellContext.Provider>;
}

export function useShell(): ShellApi {
  const context = useContext(ShellContext);
  if (!context) throw new Error('useShell must be used inside <ShellStateProvider>.');
  return context;
}

/**
 * Rehydrate geometry, treating stored values as untrusted.
 *
 * They are not attacker-controlled, but they are *previous-version*-controlled:
 * a build that shipped a 420px maximum wrote widths this build must not honour,
 * and `asNumberInRange` clamps rather than rejects so the user keeps a sidebar
 * near the size they chose instead of being reset to the default.
 */
function restore(fallback: ShellState): ShellState {
  const stored = asRecord(readStoredJson(STORAGE_KEYS.shell));
  if (!stored) return fallback;
  return {
    ...fallback,
    productMode: asMember(stored['productMode'], PRODUCT_MODES, fallback.productMode),
    chatSurface: asMember(stored['chatSurface'], CHAT_SURFACES, fallback.chatSurface),
    sidebarCollapsed: asBoolean(stored['sidebarCollapsed'], fallback.sidebarCollapsed),
    sidebarWidth: asNumberInRange(
      stored['sidebarWidth'],
      SIDEBAR_MIN_WIDTH,
      SIDEBAR_MAX_WIDTH,
      fallback.sidebarWidth,
    ),
    inspectorOpen: asBoolean(stored['inspectorOpen'], fallback.inspectorOpen),
    inspectorWidth: asNumberInRange(
      stored['inspectorWidth'],
      INSPECTOR_MIN_WIDTH,
      INSPECTOR_MAX_WIDTH,
      fallback.inspectorWidth,
    ),
  };
}
