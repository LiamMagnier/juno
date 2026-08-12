/**
 * macOS appearance and accessibility, read from the OS.
 *
 * The renderer cannot answer these questions for itself. `prefers-color-scheme`
 * and `prefers-reduced-motion` have CSS media queries; "Reduce transparency",
 * "Increase contrast" and the accent colour do not. So main reads them and
 * pushes a `SystemAppearance` over `app:appearance-changed`, and the renderer
 * treats that as the source of truth for all five values rather than mixing two
 * mechanisms that can disagree mid-frame.
 *
 * ## What Electron 43 genuinely exposes
 *
 * Every value below comes from a real API. None is inferred, defaulted or
 * guessed, because a fake accessibility signal is worse than none: a user who
 * has asked the system to reduce motion and is told the app respects that
 * setting, while the app never actually read it, has been lied to.
 *
 * | Field                | Source                                                    | Notes |
 * | -------------------- | --------------------------------------------------------- | ----- |
 * | `shouldUseDarkColors`| `nativeTheme.shouldUseDarkColors`                          | All platforms. Reflects `themeSource` overrides. |
 * | `reduceMotion`       | `systemPreferences.getAnimationSettings().prefersReducedMotion` | Documented as reading platform APIs; on macOS this is Accessibility → Display → Reduce motion. |
 * | `reduceTransparency` | `nativeTheme.prefersReducedTransparency`                   | Real property, no platform caveat in the Electron 43 docs. Accessibility → Display → Reduce transparency. |
 * | `increaseContrast`   | `nativeTheme.shouldUseHighContrastColors`                  | Documented `@platform darwin,win32`. See the caveat below. |
 * | `accentColor`        | `systemPreferences.getAccentColor()`                       | macOS 10.14+. Returns RGBA hex. |
 *
 * ### Caveat on `increaseContrast`
 *
 * The Electron docs describe `shouldUseHighContrastColors` as "if the OS /
 * Chromium currently has high-contrast mode enabled" and list darwin as a
 * supported platform, but they do **not** name the macOS setting it maps to.
 * In Chromium's macOS native theme this is the platform contrast preference,
 * which is backed by `NSWorkspace.accessibilityDisplayShouldIncreaseContrast`
 * — i.e. Accessibility → Display → Increase contrast. That mapping is stated
 * here from Chromium's implementation rather than from Electron's
 * documentation, so treat it as high-confidence rather than contractual. There
 * is no *other* Electron API for this setting; `systemPreferences.getUserDefault`
 * cannot reach it because it lives in the `com.apple.universalaccess` domain
 * rather than in the app's standard defaults.
 *
 * ### What is not available, and is therefore not in the payload
 *
 * - **Differentiate without colour.** `nativeTheme.shouldDifferentiateWithoutColor`
 *   exists and is macOS-only, but `SystemAppearanceSchema` has no field for it,
 *   so it is not reported. It is read here only as a change trigger.
 * - **"Reduce motion" as an event.** Electron documents `nativeTheme`'s
 *   `updated` event as firing for dark / high-contrast / inverted changes. It
 *   is not documented as firing when reduce-motion changes, and relying on an
 *   undocumented side effect would make the app silently stale. The workspace
 *   notification below is the real fix; window focus is the backstop.
 * - **Accent-colour change events on macOS.** `systemPreferences`'
 *   `accent-color-changed` event is `@platform win32,linux`. On macOS the
 *   accent colour is re-read on the same triggers as everything else.
 */

import { nativeTheme, systemPreferences, type BrowserWindow } from 'electron';
import type { SystemAppearance, ThemeAppearance } from '../shared/ipc.js';
import { emitTo } from './ipc-router.js';
import { createLogger } from './logger.js';

const log = createLogger('app');

/**
 * Posted by AppKit whenever any of Reduce Motion, Reduce Transparency, Increase
 * Contrast or Differentiate Without Color changes. This is the notification
 * that makes accessibility changes land live instead of on next launch.
 *
 * It is an `NSWorkspace` notification, so it needs `subscribeWorkspaceNotification`
 * rather than `subscribeNotification` — the latter listens on
 * `NSDistributedNotificationCenter`, where this never arrives.
 */
const ACCESSIBILITY_NOTIFICATION = 'NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification';

/* -------------------------------------------------------------------------- */
/* Reading                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The accent colour, normalised to `#RRGGBBAA`.
 *
 * Electron returns RGBA hex, historically without a leading `#` on some
 * platforms, so the `#` is added rather than assumed. Returns `null` rather
 * than a fabricated blue if the API is unavailable (pre-10.14) or throws — the
 * schema is nullable precisely so this case can be honest.
 */
function readAccentColor(): string | null {
  if (process.platform !== 'darwin') return null;

  try {
    const raw = systemPreferences.getAccentColor();
    if (typeof raw !== 'string' || raw.length === 0) return null;

    const hex = raw.startsWith('#') ? raw.slice(1) : raw;
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) {
      log.warn('unexpected accent colour format from systemPreferences', { raw });
      return null;
    }
    return `#${hex.length === 6 ? `${hex}ff` : hex}`.toLowerCase();
  } catch (error) {
    log.warn('accent colour unavailable', { error });
    return null;
  }
}

/**
 * Whether the user has asked for reduced motion.
 *
 * `getAnimationSettings()` also returns `shouldRenderRichAnimation`, which
 * folds in session type (remote desktop, screen sharing). That is a broader
 * signal and a tempting one, but it is not the accessibility preference, and
 * conflating the two would mean an app that disables motion over Screen Sharing
 * and reports that as the user's accessibility choice. Only
 * `prefersReducedMotion` is used.
 */
function readReduceMotion(): boolean {
  try {
    return systemPreferences.getAnimationSettings().prefersReducedMotion;
  } catch (error) {
    /* Defaulting to `false` is the honest default: it means "we could not
       determine that the user wants reduced motion", not "the user wants
       animation". The failure is logged so it cannot pass unnoticed. */
    log.warn('animation settings unavailable; assuming motion is permitted', { error });
    return false;
  }
}

/** Build the payload the renderer consumes. Cheap; safe to call per event. */
export function readSystemAppearance(): SystemAppearance {
  return {
    shouldUseDarkColors: nativeTheme.shouldUseDarkColors,
    reduceMotion: readReduceMotion(),
    reduceTransparency: nativeTheme.prefersReducedTransparency,
    /* `shouldUseHighContrastColors` is documented for darwin and win32 only;
       elsewhere it is not meaningful, and reporting whatever the property
       happens to return would be reporting noise. */
    increaseContrast:
      process.platform === 'darwin' || process.platform === 'win32'
        ? nativeTheme.shouldUseHighContrastColors
        : false,
    accentColor: readAccentColor(),
  };
}

/* -------------------------------------------------------------------------- */
/* Theme override                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Apply the user's Light / Dark / System preference.
 *
 * `themeSource` is deliberately the whole implementation. Setting it makes
 * `shouldUseDarkColors`, the `prefers-color-scheme` media query, the native
 * window frame, menus and any native dialogs all agree — a renderer-only theme
 * toggle produces a dark app with a light title bar and light context menus,
 * which reads as a bug on macOS.
 *
 * Setting it also emits `nativeTheme`'s `updated` event, so the broadcast below
 * pushes the new payload to the renderer without a second call site.
 */
export function applyThemeAppearance(preference: ThemeAppearance): void {
  if (nativeTheme.themeSource === preference) return;
  nativeTheme.themeSource = preference;
  log.info('theme preference applied', { preference });
}

/** The current Light / Dark / System preference. */
export function getThemeAppearance(): ThemeAppearance {
  return nativeTheme.themeSource;
}

/* -------------------------------------------------------------------------- */
/* Broadcast                                                                   */
/* -------------------------------------------------------------------------- */

export interface AppearanceBroadcastOptions {
  /** The windows to notify. Called per event so late-created windows are included. */
  readonly targets: () => readonly BrowserWindow[];
}

let lastBroadcast: string | null = null;

/**
 * Start pushing `app:appearance-changed`. Returns a disposer.
 *
 * Three triggers, because no single one covers everything:
 *
 *   1. `nativeTheme.on('updated')` — dark mode, high contrast, inverted colours,
 *      and any `themeSource` change we make ourselves.
 *   2. The AppKit accessibility notification — reduce motion, reduce
 *      transparency, increase contrast, differentiate-without-colour. This is
 *      the one that makes the accessibility half of the payload live rather
 *      than sampled once at launch.
 *   3. Window focus — the backstop. A user who changes a setting in System
 *      Settings and comes back to Juno gets a correct UI on the way in, even if
 *      a future macOS release renames the notification out from under us.
 *
 * Every trigger funnels through `broadcast`, which compares against the last
 * payload sent and does nothing if it is unchanged, so the focus backstop costs
 * one struct read per activation and never causes a spurious re-render.
 */
export function startAppearanceBroadcast(options: AppearanceBroadcastOptions): () => void {
  const broadcast = (): void => {
    const appearance = readSystemAppearance();
    const serialised = JSON.stringify(appearance);
    if (serialised === lastBroadcast) return;
    lastBroadcast = serialised;

    log.debug('appearance changed', { ...appearance });
    for (const window of options.targets()) {
      emitTo(window, 'app:appearance-changed', appearance);
    }
  };

  nativeTheme.on('updated', broadcast);

  let workspaceSubscription: number | null = null;
  if (process.platform === 'darwin') {
    try {
      workspaceSubscription = systemPreferences.subscribeWorkspaceNotification(
        ACCESSIBILITY_NOTIFICATION,
        () => {
          broadcast();
        },
      );
    } catch (error) {
      /* Not fatal: trigger 3 still covers it, at the cost of the change landing
         on focus rather than immediately. Logged because a silent downgrade of
         an accessibility feature is exactly the kind of regression that never
         gets noticed. */
      log.warn('could not subscribe to the accessibility workspace notification', { error });
    }
  }

  /* Seed `lastBroadcast` so the first real change is detected as a change, and
     so the renderer's initial `app:appearance` invoke and the first pushed
     event cannot disagree. */
  lastBroadcast = JSON.stringify(readSystemAppearance());

  return () => {
    nativeTheme.off('updated', broadcast);
    if (workspaceSubscription !== null) {
      try {
        systemPreferences.unsubscribeWorkspaceNotification(workspaceSubscription);
      } catch (error) {
        log.warn('could not unsubscribe from the workspace notification', { error });
      }
    }
    lastBroadcast = null;
  };
}

/**
 * Force a re-read and push if anything moved.
 *
 * Call from `browser-window-focus` and after `powerMonitor`'s `resume` — both
 * are moments when the OS state may have changed while we were not listening.
 */
export function refreshAppearance(targets: readonly BrowserWindow[]): void {
  const appearance = readSystemAppearance();
  const serialised = JSON.stringify(appearance);
  if (serialised === lastBroadcast) return;
  lastBroadcast = serialised;

  for (const window of targets) {
    emitTo(window, 'app:appearance-changed', appearance);
  }
}
