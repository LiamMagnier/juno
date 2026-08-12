/**
 * The unified title bar.
 *
 * This is the component that decides whether the app feels like a Mac
 * application or like a web page in a frame, and almost all of that comes down
 * to three details:
 *
 *   1. **The traffic lights are the system's, and we make room for them.** The
 *      window is created with `titleBarStyle: 'hiddenInset'`, so macOS draws
 *      close/minimise/zoom itself at `trafficLightPosition`. Redrawing them in
 *      HTML is the tell: the hover glyphs, the amber/green semantics under
 *      Reduce Transparency, the way they dim when the window loses key focus —
 *      none of that is reproducible, and every app that tries gets it subtly
 *      wrong. `TRAFFIC_LIGHT_INSET` reserves their strip; the constants below
 *      are exported so main positions them against the same numbers rather than
 *      a second set that drifts.
 *
 *   2. **The whole bar drags, and every control opts out.** `-webkit-app-region:
 *      drag` on the bar, `no-drag` on each interactive island. Miss the opt-out
 *      and buttons stop being clickable — they just move the window. Miss the
 *      drag and the app cannot be moved by its title bar, which users do not
 *      report as a bug; they just conclude the app is cheap.
 *
 *   3. **Fullscreen removes the traffic lights, so it must remove the inset.**
 *      Otherwise the toolbar keeps a 78px hole where nothing is, in the one mode
 *      where the user asked for every pixel.
 */

import { useEffect, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '../lib/cn.js';
import { useShell, type ChatSurface, type ProductMode } from '../state/shell-state.js';
import { useMotionProfile, useSystem } from '../state/system-state.js';
import { useWorkspaces } from '../state/workspaces.js';
import { SegmentedControl, type SegmentedOption } from './SegmentedControl.js';
import { IconButton } from './primitives/Button.js';
import { Kbd, Meta } from './primitives/atoms.js';
import {
  ChatIcon,
  CodeIcon,
  MoonIcon,
  PanelLeftIcon,
  PanelRightIcon,
  SearchIcon,
  SunIcon,
  SystemIcon,
  WorkIcon,
} from './icons.js';

/** Bar height in px. Main must use the same number to centre the traffic lights. */
export const TITLE_BAR_HEIGHT = 44;

/**
 * Left inset reserved for the system window buttons.
 *
 * Three 12px buttons at 20px pitch starting at x=19 end at x≈71; 78 leaves a
 * small, deliberate gap before the first control rather than butting the
 * sidebar toggle against the zoom button.
 */
export const TRAFFIC_LIGHT_INSET = 78;

/** Pass to `new BrowserWindow({ trafficLightPosition })`. Centres them in a 44px bar. */
export const TRAFFIC_LIGHT_POSITION = { x: 19, y: 16 } as const;

const PRODUCT_OPTIONS: readonly SegmentedOption<ProductMode>[] = [
  { value: 'chat', label: 'Chat', icon: <ChatIcon className="h-3.5 w-3.5" /> },
  { value: 'code', label: 'Code', icon: <CodeIcon className="h-3.5 w-3.5" /> },
];

const SURFACE_OPTIONS: readonly SegmentedOption<ChatSurface>[] = [
  { value: 'chat', label: 'Chat', icon: <ChatIcon className="h-3.5 w-3.5" /> },
  { value: 'work', label: 'Work', icon: <WorkIcon className="h-3.5 w-3.5" /> },
];

export function TitleBar(): ReactNode {
  const {
    productMode,
    setProductMode,
    chatSurface,
    setChatSurface,
    sidebarCollapsed,
    toggleSidebar,
    inspectorOpen,
    toggleInspector,
    openPalette,
  } = useShell();
  const { appearance, themePreference, setThemePreference, connected } = useSystem();
  const motionProfile = useMotionProfile();
  const fullscreen = useMacFullscreen();

  return (
    <header
      /* The bar is `bg-background`, not a raised surface: a title bar that sits
         above the content it labels reads as a floating toolbar. The separation
         comes from the hairline underneath it. */
      className="relative z-10 flex shrink-0 items-center gap-2 border-b border-border bg-background pr-2"
      style={{
        height: TITLE_BAR_HEIGHT,
        paddingLeft: fullscreen ? 12 : TRAFFIC_LIGHT_INSET,
        WebkitAppRegion: 'drag',
      }}
    >
      <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' }}>
        <IconButton
          label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          icon={<PanelLeftIcon className="h-4 w-4" />}
          pressed={!sidebarCollapsed}
          onClick={toggleSidebar}
        />

        <SegmentedControl
          options={PRODUCT_OPTIONS}
          value={productMode}
          onChange={setProductMode}
          label="Product"
          layoutId="product-mode-thumb"
          panelId="juno-main-pane"
        />

        {/* The Chat/Work switch is a *child* of Chat mode and is placed to read
            that way: it appears only in Chat, after a divider, at a smaller
            size. Two equally-weighted switches side by side would leave the
            user unsure which one is the outer one. */}
        <AnimatePresence initial={false} mode="wait">
          {productMode === 'chat' ? (
            <motion.div
              key="chat-surface"
              className="flex items-center gap-2"
              variants={motionProfile.fade}
              initial="hidden"
              animate="visible"
              exit="hidden"
            >
              <span aria-hidden="true" className="h-4 w-px bg-border" />
              <SegmentedControl
                options={SURFACE_OPTIONS}
                value={chatSurface}
                onChange={setChatSurface}
                label="Chat surface"
                layoutId="chat-surface-thumb"
                panelId="juno-main-pane"
                size="sm"
              />
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      {/* The draggable middle. It carries the window's context line, which is
          also the largest uninterrupted drag target in the bar. */}
      <div className="flex min-w-0 flex-1 items-center justify-center px-4">
        <ContextLine />
      </div>

      <div className="flex items-center gap-1" style={{ WebkitAppRegion: 'no-drag' }}>
        <button
          type="button"
          onClick={openPalette}
          className={cn(
            'inline-flex h-7 items-center gap-2 rounded-control border border-border bg-card px-2 text-xs',
            'text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground',
            'active:bg-muted/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'focus-visible:ring-offset-2 focus-visible:ring-offset-background',
          )}
        >
          <SearchIcon className="h-3.5 w-3.5" />
          <span>Search commands</span>
          <Kbd keys={['⌘', 'K']} />
        </button>

        <AppearanceButton
          preference={themePreference}
          dark={appearance.shouldUseDarkColors}
          connected={connected}
          onChange={setThemePreference}
        />

        <IconButton
          label={inspectorOpen ? 'Hide inspector' : 'Show inspector'}
          icon={<PanelRightIcon className="h-4 w-4" />}
          pressed={inspectorOpen}
          onClick={toggleInspector}
          tooltipPlacement="left"
        />
      </div>
    </header>
  );
}

/**
 * What this window is currently showing.
 *
 * Mono, muted, small — this is metadata, not a headline. In Code mode it is the
 * thing a developer actually needs to know before typing a command: which
 * checkout, which branch.
 */
function ContextLine(): ReactNode {
  const { productMode, chatSurface } = useShell();
  const { active } = useWorkspaces();

  if (productMode === 'code') {
    if (!active) return <Meta className="truncate">No workspace</Meta>;
    return (
      <span className="flex min-w-0 items-center gap-2">
        <Meta className="truncate text-foreground/80">{active.name}</Meta>
        {active.branch ? (
          <>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <Meta className="truncate">{active.branch}</Meta>
          </>
        ) : null}
      </span>
    );
  }

  return <Meta className="truncate">{chatSurface === 'work' ? 'Work' : 'Chat'}</Meta>;
}

const APPEARANCE_ORDER = ['light', 'dark', 'system'] as const;

/**
 * Cycles light → dark → system.
 *
 * A cycle rather than a menu because there are three states and no menu
 * primitive worth building for three states. The label states the *next*
 * action, since a control whose name is its current value ("Dark") is
 * ambiguous about what pressing it does.
 */
function AppearanceButton({
  preference,
  dark,
  connected,
  onChange,
}: {
  preference: (typeof APPEARANCE_ORDER)[number];
  dark: boolean;
  connected: boolean;
  onChange: (next: (typeof APPEARANCE_ORDER)[number]) => void;
}): ReactNode {
  const index = APPEARANCE_ORDER.indexOf(preference);
  const next = APPEARANCE_ORDER[(index + 1) % APPEARANCE_ORDER.length] ?? 'system';
  const icon =
    preference === 'system' ? (
      <SystemIcon className="h-4 w-4" />
    ) : dark ? (
      <MoonIcon className="h-4 w-4" />
    ) : (
      <SunIcon className="h-4 w-4" />
    );

  return (
    <IconButton
      label={`Appearance: ${preference}. Switch to ${next}.`}
      icon={icon}
      onClick={() => onChange(next)}
      disabledReason={connected ? undefined : 'Appearance is set by the main process, which is not reachable.'}
    />
  );
}

/**
 * Whether the window is in macOS fullscreen.
 *
 * There is no `window:fullscreen-changed` event in the IPC contract, and the
 * green button and ⌃⌘F bypass our own `window:toggle-fullscreen` entirely — so
 * this is inferred rather than told. `display-mode: fullscreen` is the reliable
 * half; the dimension comparison catches the cases where Chromium does not
 * update the media query for a native window transition.
 *
 * The consequence of being wrong is a 78px gap or a 78px overlap in the title
 * bar, not a broken window, which is why an inference is acceptable here. If
 * main ever gains a fullscreen event, this should be deleted in favour of it.
 */
function useMacFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    const query = window.matchMedia('(display-mode: fullscreen)');

    function evaluate(): void {
      const byMediaQuery = query.matches;
      const byGeometry = window.screen.height === window.innerHeight && window.screenY === 0;
      setFullscreen(byMediaQuery || byGeometry);
    }

    evaluate();
    query.addEventListener('change', evaluate);
    window.addEventListener('resize', evaluate);
    return () => {
      query.removeEventListener('change', evaluate);
      window.removeEventListener('resize', evaluate);
    };
  }, []);

  return fullscreen;
}
