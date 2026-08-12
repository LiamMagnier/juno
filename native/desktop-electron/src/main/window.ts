/**
 * The main window.
 *
 * Three things this file is careful about, in the order a user notices them:
 *
 *   1. **No white flash.** The window is created hidden with a background
 *      colour already matching the theme, and shown only on `ready-to-show`.
 *      Electron's default is a visible white window that paints the renderer a
 *      few hundred milliseconds later; on a dark theme that is a full-screen
 *      white strobe on every launch.
 *   2. **The window comes back where it was.** Bounds and full-screen state are
 *      persisted, and — the part most Electron apps get wrong — clamped to a
 *      display that currently exists. A window saved on a second monitor that
 *      has since been unplugged must not reopen at x=2560 where the user can
 *      neither see it nor drag it back.
 *   3. **It is created with the same hardening as every other window.**
 *      `SECURE_WEB_PREFERENCES` is spread verbatim rather than restated, and
 *      `hardenWindow` / `trustWindow` are called before any content loads.
 */

import { BrowserWindow, app, nativeTheme, screen } from 'electron';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { trustWindow } from './ipc-router.js';
import { createLogger } from './logger.js';
import { APP_ORIGIN, SECURE_WEB_PREFERENCES, hardenWindow } from './security.js';

const log = createLogger('app');

/* -------------------------------------------------------------------------- */
/* Constants                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The paint-before-React background.
 *
 * These must track `--juno-bg` in the design tokens. They are literals here
 * rather than an import because they are needed *before* the renderer bundle —
 * and therefore the token stylesheet — has been parsed, which is the entire
 * point of setting them. Warm paper in light, true black in dark: black rather
 * than a near-black so the window edge disappears into an OLED display and the
 * transition into the renderer's own black is seamless.
 */
const BACKGROUND_LIGHT = '#f7f6f1';
const BACKGROUND_DARK = '#000000';

/**
 * Traffic-light placement.
 *
 * Imported from `src/shared/chrome.ts` rather than declared here. This constant
 * previously lived in both processes with different values — main assumed a
 * 52px title bar, the renderer draws 44px — which put the buttons 4px below
 * centre. Two processes that must agree on a number should read it from one
 * place; `y` is derived from the bar height there, so it cannot drift again.
 */
import { TRAFFIC_LIGHT_POSITION } from '../shared/chrome.js';

/**
 * Below roughly this width the three-pane layout (navigator · transcript ·
 * inspector) cannot show all three panes at a usable size, and below this
 * height the composer and the transcript start fighting. The renderer collapses
 * panes responsively above these numbers; these are the floor where it stops
 * being a three-pane tool at all.
 */
const MIN_WIDTH = 900;
const MIN_HEIGHT = 620;

const DEFAULT_WIDTH = 1440;
const DEFAULT_HEIGHT = 920;

const STATE_FILE = 'window-state.json';
const STATE_WRITE_DEBOUNCE_MS = 400;

/* -------------------------------------------------------------------------- */
/* Persisted state                                                             */
/* -------------------------------------------------------------------------- */

const RectangleSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
});

const WindowStateSchema = z.object({
  bounds: RectangleSchema,
  maximized: z.boolean(),
  fullScreen: z.boolean(),
});

type WindowState = z.infer<typeof WindowStateSchema>;
type Rectangle = z.infer<typeof RectangleSchema>;

function stateFilePath(): string {
  return path.join(app.getPath('userData'), STATE_FILE);
}

/**
 * Read the saved state, or `null`.
 *
 * Validated with Zod rather than cast. The file is local and not attacker-
 * controlled in any interesting way, but it *is* attacker-adjacent (anything
 * running as the user can edit it) and, far more commonly, it is a file that
 * gets truncated by a crash mid-write. `{"bounds":{"x":` parsed as a state
 * object produces `NaN` bounds and a window that never appears — a failure that
 * is miserable to diagnose and trivial to prevent.
 */
function readWindowState(): WindowState | null {
  const file = stateFilePath();
  if (!existsSync(file)) return null;

  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const validated = WindowStateSchema.safeParse(parsed);
    if (!validated.success) {
      log.warn('discarding malformed window state', { file });
      return null;
    }
    return validated.data;
  } catch (error) {
    log.warn('could not read window state', { error });
    return null;
  }
}

let pendingStateWrite: NodeJS.Timeout | null = null;

function writeWindowStateNow(state: WindowState): void {
  try {
    writeFileSync(stateFilePath(), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (error) {
    /* Losing window position is a papercut, not a failure worth surfacing. */
    log.warn('could not persist window state', { error });
  }
}

/**
 * Capture the window's state.
 *
 * `getNormalBounds()` rather than `getBounds()`: while maximised or in full
 * screen, `getBounds()` reports the screen-filling rectangle, and saving that
 * means un-maximising after a restart drops the window into a "normal" size
 * that happens to be exactly the display — after which the maximise button
 * appears to do nothing.
 */
function captureState(window: BrowserWindow): WindowState {
  return {
    bounds: window.getNormalBounds(),
    maximized: window.isMaximized(),
    fullScreen: window.isFullScreen(),
  };
}

function scheduleStateWrite(window: BrowserWindow): void {
  if (pendingStateWrite !== null) clearTimeout(pendingStateWrite);
  pendingStateWrite = setTimeout(() => {
    pendingStateWrite = null;
    if (window.isDestroyed()) return;
    writeWindowStateNow(captureState(window));
  }, STATE_WRITE_DEBOUNCE_MS);
  pendingStateWrite.unref();
}

/* -------------------------------------------------------------------------- */
/* Display clamping                                                            */
/* -------------------------------------------------------------------------- */

/**
 * How much of the window must be on a real display for the saved position to be
 * considered usable. A window whose visible sliver is smaller than this cannot
 * be grabbed by its title bar, which is the failure mode that matters: the
 * window technically exists, and the user technically cannot reach it.
 */
const MIN_VISIBLE_WIDTH = 120;
const MIN_VISIBLE_HEIGHT = 60;

function intersectionArea(a: Rectangle, b: Rectangle): { width: number; height: number } {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return { width, height };
}

/**
 * Fit `desired` onto one of `workAreas`.
 *
 * Pure and exported so the disconnected-monitor case can be tested without a
 * second monitor. `workAreas` must be non-empty and the primary display's work
 * area must come first — it is the fallback when nothing overlaps.
 *
 * Work *area*, not bounds: it excludes the menu bar and the Dock, so a restored
 * window cannot end up with its title bar underneath the menu bar, which on
 * macOS makes the window undraggable.
 */
export function clampBoundsToWorkAreas(
  desired: Rectangle,
  workAreas: readonly Rectangle[],
): Rectangle {
  const primary = workAreas[0];
  if (primary === undefined) return desired;

  /*
   * The display showing the most of this window wins — which is also the
   * display the user last had it on when a window straddles two.
   *
   * Ranked on "is a grabbable amount of it visible here" *before* raw overlap
   * area, because the two can disagree: a window overhanging a display by an
   * 8px-tall strip has more overlapping area than one showing a 130×60 corner
   * on another, and only the second is a window the user can actually take hold
   * of. Sorting by area alone would pick the strip and then discard the
   * position as unusable.
   */
  let best = primary;
  let bestArea = -1;
  let bestGrabbable = false;

  for (const area of workAreas) {
    const overlap = intersectionArea(desired, area);
    const size = overlap.width * overlap.height;
    const grabbable =
      overlap.width >= MIN_VISIBLE_WIDTH && overlap.height >= MIN_VISIBLE_HEIGHT;

    const better = grabbable === bestGrabbable ? size > bestArea : grabbable;
    if (!better) continue;

    bestArea = size;
    best = area;
    bestGrabbable = grabbable;
  }

  const sufficientlyVisible = bestGrabbable;

  /* Nothing meaningful is on any display — the monitor it lived on is gone, or
     the display arrangement changed underneath it. Centre on the primary at
     the remembered size rather than preserving a position that no longer refers
     to anywhere. */
  const width = Math.round(Math.max(MIN_WIDTH, Math.min(desired.width, best.width)));
  const height = Math.round(Math.max(MIN_HEIGHT, Math.min(desired.height, best.height)));

  if (!sufficientlyVisible) {
    return {
      x: Math.round(primary.x + Math.max(0, (primary.width - width) / 2)),
      y: Math.round(primary.y + Math.max(0, (primary.height - height) / 2)),
      width: Math.round(Math.min(width, primary.width)),
      height: Math.round(Math.min(height, primary.height)),
    };
  }

  /* Partly visible: nudge it fully onto that display, preserving as much of the
     remembered position as fits. `Math.max` after `Math.min` so that a window
     larger than the work area pins to the top-left rather than off the left. */
  return {
    x: Math.round(Math.max(best.x, Math.min(desired.x, best.x + best.width - width))),
    y: Math.round(Math.max(best.y, Math.min(desired.y, best.y + best.height - height))),
    width,
    height,
  };
}

function initialBounds(state: WindowState | null): Rectangle {
  const workAreas = screen.getAllDisplays().map((display) => display.workArea);
  const primaryArea = screen.getPrimaryDisplay().workArea;

  /* Primary first: `clampBoundsToWorkAreas` treats index 0 as the fallback. */
  const ordered: Rectangle[] = [
    primaryArea,
    ...workAreas.filter((area) => area !== primaryArea),
  ];

  if (state === null) {
    const width = Math.min(DEFAULT_WIDTH, primaryArea.width);
    const height = Math.min(DEFAULT_HEIGHT, primaryArea.height);
    return {
      x: Math.round(primaryArea.x + (primaryArea.width - width) / 2),
      y: Math.round(primaryArea.y + (primaryArea.height - height) / 2),
      width: Math.round(width),
      height: Math.round(height),
    };
  }

  const clamped = clampBoundsToWorkAreas(state.bounds, ordered);
  if (
    clamped.x !== Math.round(state.bounds.x) ||
    clamped.y !== Math.round(state.bounds.y) ||
    clamped.width !== Math.round(state.bounds.width) ||
    clamped.height !== Math.round(state.bounds.height)
  ) {
    log.info('restored window bounds were clamped onto an attached display', {
      saved: state.bounds,
      clamped,
      displays: ordered.length,
    });
  }
  return clamped;
}

/* -------------------------------------------------------------------------- */
/* Preload and content                                                         */
/* -------------------------------------------------------------------------- */

function moduleDirectory(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

/**
 * Locate the built preload script.
 *
 * The extension is not hard-coded because it depends on how the bundler is
 * configured, and getting it wrong produces a window with no `window.juno` and
 * no error — the renderer simply finds `undefined` and every call fails later,
 * somewhere else. Probing and failing loudly here turns that into one legible
 * message at startup.
 *
 * `.cjs` and `.js` are preferred over `.mjs` deliberately: Electron does not
 * support ES-module preload scripts in sandboxed renderers, and this app runs
 * every renderer sandboxed.
 */
function resolvePreloadPath(): string {
  const candidates = ['index.cjs', 'index.js', 'index.mjs'].map((file) =>
    path.join(moduleDirectory(), '..', 'preload', file),
  );

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (candidate.endsWith('.mjs')) {
      log.warn(
        'preload script is an ES module; Electron cannot load ESM preloads into a sandboxed renderer. Build the preload as CommonJS (.cjs).',
        { candidate },
      );
    }
    return candidate;
  }

  throw new Error(
    `No preload bundle found. Looked for: ${candidates.map((c) => path.basename(c)).join(', ')} in out/preload.`,
  );
}

/** The dev-server URL, when electron-vite is driving the renderer. */
function devServerUrl(): string | null {
  const url = process.env['ELECTRON_RENDERER_URL'];
  return url !== undefined && url.length > 0 ? url : null;
}

/* -------------------------------------------------------------------------- */
/* Creation                                                                    */
/* -------------------------------------------------------------------------- */

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : null;
}

/** Every live app window. Used as the fan-out target for pushed events. */
export function getAppWindows(): readonly BrowserWindow[] {
  const window = getMainWindow();
  return window === null ? [] : [window];
}

function backgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? BACKGROUND_DARK : BACKGROUND_LIGHT;
}

/**
 * Create the main window, load the renderer, and resolve once it is visible.
 *
 * Resolves on `ready-to-show` rather than on `did-finish-load` so the caller can
 * sequence "window is on screen" work (updater check, deep-link replay) after
 * the user actually has something to look at.
 */
export async function createMainWindow(): Promise<BrowserWindow> {
  const existing = getMainWindow();
  if (existing !== null) return existing;

  const state = readWindowState();
  const bounds = initialBounds(state);

  const window = new BrowserWindow({
    ...bounds,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,

    /* Hidden until the first frame is ready. See the header comment. */
    show: false,
    backgroundColor: backgroundColor(),

    /* The renderer draws its own title bar; `hiddenInset` keeps the native
       traffic lights (and their hover, fullscreen and window-management
       behaviours) while removing the bar itself. A fully frameless window
       would mean reimplementing all of that in CSS, badly. */
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    title: 'Juno',

    /* A click that both focuses the window *and* activates what was clicked.
       Without it, returning to Juno from another app costs two clicks on every
       control — which is felt most on the composer's send button and on the
       approval prompts, where the first click is the one the user meant. */
    acceptFirstMouse: true,

    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      preload: resolvePreloadPath(),
    },
  });

  mainWindow = window;

  /* Before any content loads: navigation policy, session policy, and the IPC
     trust mark. Doing this after `loadURL` would leave a window of a few
     milliseconds during which the renderer is live and unpoliced. */
  hardenWindow(window);
  trustWindow(window);

  wireWindowEvents(window, state);

  const dev = devServerUrl();
  if (dev !== null) {
    log.info('loading renderer from the dev server', { url: dev });
    await window.loadURL(dev);
  } else {
    log.info('loading renderer from the app protocol', { origin: APP_ORIGIN });
    await window.loadURL(`${APP_ORIGIN}/index.html`);
  }

  return window;
}

function wireWindowEvents(window: BrowserWindow, state: WindowState | null): void {
  window.once('ready-to-show', () => {
    /*
     * Maximise / full screen are applied *after* the first paint rather than
     * through the constructor. Constructing a hidden window directly into full
     * screen on macOS produces a black screen and a missing space-transition
     * animation, because the full-screen transition needs a window that is
     * actually on screen to animate.
     */
    window.show();
    if (state?.fullScreen === true) {
      window.setFullScreen(true);
    } else if (state?.maximized === true) {
      window.maximize();
    }
    log.info('main window shown', {
      bounds: window.getBounds(),
      fullScreen: window.isFullScreen(),
    });
  });

  /* Listed one call at a time rather than looped over a union of event names:
     `BrowserWindow.on` is a heavily overloaded signature, and passing it a
     union selects no overload. Explicit calls keep each name checked against
     the real event map. */
  const persistState = (): void => {
    scheduleStateWrite(window);
  };
  window.on('resize', persistState);
  window.on('move', persistState);
  window.on('maximize', persistState);
  window.on('unmaximize', persistState);
  window.on('enter-full-screen', persistState);
  window.on('leave-full-screen', persistState);

  /* The debounced write may not have fired; capture synchronously on close so
     the last resize before quitting is not the one that gets lost. */
  window.on('close', () => {
    if (pendingStateWrite !== null) {
      clearTimeout(pendingStateWrite);
      pendingStateWrite = null;
    }
    writeWindowStateNow(captureState(window));
  });

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  /* Keep the pre-paint colour in step with the theme, so a reload or a
     navigation in dark mode does not flash paper-white. */
  const onThemeUpdated = (): void => {
    if (!window.isDestroyed()) window.setBackgroundColor(backgroundColor());
  };
  nativeTheme.on('updated', onThemeUpdated);
  window.on('closed', () => {
    nativeTheme.off('updated', onThemeUpdated);
  });

  /* Real failure handling rather than a blank window. A failed main-frame load
     in production almost always means the protocol handler could not find the
     renderer bundle, which is a packaging bug worth naming precisely. */
  window.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      /* -3 is ERR_ABORTED, which is what a superseded navigation looks like. */
      if (errorCode === -3) return;
      log.error('renderer failed to load', { errorCode, errorDescription, url: validatedUrl });
    },
  );

  window.webContents.on('render-process-gone', (_event, details) => {
    log.error('renderer process gone', { reason: details.reason, exitCode: details.exitCode });
  });

  window.on('unresponsive', () => {
    log.warn('main window became unresponsive');
  });
  window.on('responsive', () => {
    log.info('main window became responsive again');
  });
}

/**
 * Bring the app forward, creating the window if the user closed it.
 *
 * This is the `activate` / second-instance / deep-link entry point: on macOS an
 * app stays running with no windows, and clicking the Dock icon or following a
 * `juno://` link has to be able to bring one back.
 */
export async function showOrCreateMainWindow(): Promise<BrowserWindow> {
  const existing = getMainWindow();
  if (existing === null) return createMainWindow();

  if (existing.isMinimized()) existing.restore();
  existing.show();
  existing.focus();
  return existing;
}
