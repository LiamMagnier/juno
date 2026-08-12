/**
 * Everything the shell knows about the world outside the renderer.
 *
 * Four facts, one provider: who is signed in, what the system looks like, what
 * the agent host is doing, and what build this is. They live together because
 * they share a lifecycle — all four are read once on mount and then kept
 * current by a push channel — and because separating them would mean four
 * providers each holding one `useEffect` with the same shape.
 *
 * The rules this provider exists to enforce:
 *
 *   - **Every subscription is torn down.** `bridge.on` returns its own
 *     unsubscribe; each effect returns it. A leaked listener here would keep
 *     re-rendering the entire shell after unmount, and in an app with one root
 *     that is a leak that only shows up in tests and in HMR.
 *   - **A first load can fail.** If main is not answering, that is a state with
 *     a retry, not a spinner that never ends.
 *   - **Appearance is applied to the document, not just held in state.** Main
 *     stamps <html> too, but the renderer must be correct on its own in the
 *     window between paint and the first IPC response, and in a plain browser
 *     tab where main never stamps anything.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AppInfo,
  AuthState,
  DiagnosticsSnapshot,
  EventPayload,
  SystemAppearance,
  ThemeAppearance,
} from '../../shared/ipc.js';
import { isBridgeAvailable, subscribe, tryInvoke } from '../lib/bridge.js';
import {
  REDUCE_MOTION_ATTRIBUTE,
  REDUCE_TRANSPARENCY_ATTRIBUTE,
  createMotionProfile,
  readReducedMotionFromDocument,
  type MotionProfile,
} from '../lib/motion.js';
import { STORAGE_KEYS, writeStoredJson } from '../lib/storage.js';
import { useAnnounce } from './announcer.js';

export type HostStatus = EventPayload<'code:host-status'>;
export type AgentHostState = HostStatus['status'];

/** Boot is a state machine, not a boolean: 'error' has a retry affordance. */
export type BootPhase = 'loading' | 'ready' | 'error';

interface SystemState {
  readonly boot: BootPhase;
  readonly bootError: string | null;
  /** False when preload did not run — the whole shell goes read-only. */
  readonly connected: boolean;
  readonly appInfo: AppInfo | null;
  readonly appearance: SystemAppearance;
  /** What the user asked for, which is not the same as what the system resolved to. */
  readonly themePreference: ThemeAppearance;
  readonly auth: AuthState;
  /** True between pressing "Sign in" and main reporting a new auth state. */
  readonly signInPending: boolean;
  readonly host: HostStatus;
  readonly motion: MotionProfile;
  readonly diagnostics: DiagnosticsSnapshot | null;
  readonly diagnosticsError: string | null;
  readonly diagnosticsPending: boolean;
}

interface SystemApi extends SystemState {
  retryBoot: () => void;
  beginSignIn: () => void;
  signOut: () => void;
  setThemePreference: (preference: ThemeAppearance) => void;
  refreshDiagnostics: () => void;
}

const DEFAULT_APPEARANCE: SystemAppearance = {
  shouldUseDarkColors: false,
  reduceMotion: false,
  reduceTransparency: false,
  increaseContrast: false,
  accentColor: null,
};

const SystemContext = createContext<SystemApi | null>(null);

export function SystemStateProvider({ children }: { children: ReactNode }): ReactNode {
  const announce = useAnnounce();

  const [boot, setBoot] = useState<BootPhase>('loading');
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootNonce, setBootNonce] = useState(0);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [appearance, setAppearance] = useState<SystemAppearance>(() => ({
    ...DEFAULT_APPEARANCE,
    reduceMotion: readReducedMotionFromDocument(),
  }));
  const [themePreference, setThemePreferenceState] = useState<ThemeAppearance>('system');
  const [auth, setAuth] = useState<AuthState>({ status: 'signed-out' });
  const [signInPending, setSignInPending] = useState(false);
  const [host, setHost] = useState<HostStatus>({ status: 'stopped', detail: null });
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);
  const [diagnosticsError, setDiagnosticsError] = useState<string | null>(null);
  const [diagnosticsPending, setDiagnosticsPending] = useState(false);

  const connected = isBridgeAvailable();

  /* ---------------------------------------------------------------------- */
  /* Initial load                                                            */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (!connected) {
      setBoot('error');
      setBootError('The privileged bridge did not load, so Juno cannot reach the main process.');
      return;
    }

    let cancelled = false;
    setBoot('loading');
    setBootError(null);

    void (async () => {
      const [appearanceResult, authResult, infoResult] = await Promise.all([
        tryInvoke('app:appearance'),
        tryInvoke('auth:state'),
        tryInvoke('app:info'),
      ]);
      if (cancelled) return;

      if (appearanceResult.ok) setAppearance(appearanceResult.value);
      if (authResult.ok) setAuth(authResult.value);
      if (infoResult.ok) setAppInfo(infoResult.value);

      /* Appearance and auth are load-bearing; app info is metadata. A build
         that can sign in but cannot report its own version is degraded, not
         broken, and should not be shown a full-window error. */
      if (!appearanceResult.ok) {
        setBoot('error');
        setBootError(appearanceResult.error);
        return;
      }
      if (!authResult.ok) {
        setBoot('error');
        setBootError(authResult.error);
        return;
      }
      setBoot('ready');
    })();

    return () => {
      cancelled = true;
    };
  }, [connected, bootNonce]);

  /* ---------------------------------------------------------------------- */
  /* Push channels                                                           */
  /* ---------------------------------------------------------------------- */

  const previousAuthStatus = useRef<AuthState['status']>(auth.status);
  useEffect(() => {
    return subscribe('auth:changed', (next) => {
      setAuth(next);
      setSignInPending(next.status === 'signing-in');
      if (next.status !== previousAuthStatus.current) {
        previousAuthStatus.current = next.status;
        announce(describeAuth(next), next.status === 'unauthorized' ? 'assertive' : 'polite');
      }
    });
  }, [announce]);

  useEffect(() => {
    return subscribe('app:appearance-changed', (next) => {
      setAppearance(next);
    });
  }, []);

  const previousHostStatus = useRef<AgentHostState>(host.status);
  useEffect(() => {
    return subscribe('code:host-status', (next) => {
      setHost(next);
      if (next.status !== previousHostStatus.current) {
        previousHostStatus.current = next.status;
        announce(
          `Agent host ${next.status}${next.detail ? `. ${next.detail}` : ''}`,
          next.status === 'crashed' ? 'assertive' : 'polite',
        );
      }
    });
  }, [announce]);

  /* ---------------------------------------------------------------------- */
  /* Appearance -> document                                                  */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    applyAppearanceToDocument(appearance);
    /* Cached so the next launch paints the right background on the first
       frame. Without it the window opens white and then turns black, which on
       an OLED dark theme is the most visible flash the app can produce. */
    writeStoredJson(STORAGE_KEYS.appearance, { dark: appearance.shouldUseDarkColors });
  }, [appearance]);

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                 */
  /* ---------------------------------------------------------------------- */

  const retryBoot = useCallback(() => {
    setBootNonce((value) => value + 1);
  }, []);

  const beginSignIn = useCallback(() => {
    setSignInPending(true);
    void (async () => {
      const result = await tryInvoke('auth:begin-sign-in');
      if (!result.ok) {
        setSignInPending(false);
        setAuth({ status: 'unauthorized', reason: result.error });
        announce(`Sign-in failed. ${result.error}`, 'assertive');
      }
      /* On success the flow continues in the browser; `auth:changed` is what
         ends the pending state, not this reply. */
    })();
  }, [announce]);

  const signOut = useCallback(() => {
    void (async () => {
      const result = await tryInvoke('auth:sign-out');
      if (result.ok) {
        setAuth({ status: 'signed-out' });
        announce('Signed out.');
      } else {
        announce(`Could not sign out. ${result.error}`, 'assertive');
      }
    })();
  }, [announce]);

  const setThemePreference = useCallback(
    (preference: ThemeAppearance) => {
      setThemePreferenceState(preference);
      void (async () => {
        const result = await tryInvoke('app:set-appearance', { appearance: preference });
        if (!result.ok) announce(`Could not change appearance. ${result.error}`, 'assertive');
        /* The resolved appearance arrives on `app:appearance-changed`; this
           call only states the preference. Guessing the result locally is how
           "system" ends up disagreeing with the OS. */
      })();
    },
    [announce],
  );

  const refreshDiagnostics = useCallback(() => {
    setDiagnosticsPending(true);
    void (async () => {
      const result = await tryInvoke('diagnostics:snapshot');
      setDiagnosticsPending(false);
      if (result.ok) {
        setDiagnostics(result.value);
        setDiagnosticsError(null);
      } else {
        setDiagnosticsError(result.error);
      }
    })();
  }, []);

  const motion = useMemo(() => createMotionProfile(appearance.reduceMotion), [appearance.reduceMotion]);

  const value = useMemo<SystemApi>(
    () => ({
      boot,
      bootError,
      connected,
      appInfo,
      appearance,
      themePreference,
      auth,
      signInPending,
      host,
      motion,
      diagnostics,
      diagnosticsError,
      diagnosticsPending,
      retryBoot,
      beginSignIn,
      signOut,
      setThemePreference,
      refreshDiagnostics,
    }),
    [
      boot,
      bootError,
      connected,
      appInfo,
      appearance,
      themePreference,
      auth,
      signInPending,
      host,
      motion,
      diagnostics,
      diagnosticsError,
      diagnosticsPending,
      retryBoot,
      beginSignIn,
      signOut,
      setThemePreference,
      refreshDiagnostics,
    ],
  );

  return <SystemContext.Provider value={value}>{children}</SystemContext.Provider>;
}

export function useSystem(): SystemApi {
  const context = useContext(SystemContext);
  if (!context) throw new Error('useSystem must be used inside <SystemStateProvider>.');
  return context;
}

/** Convenience for the many components that only need the motion profile. */
export function useMotionProfile(): MotionProfile {
  return useSystem().motion;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

export function describeAuth(state: AuthState): string {
  switch (state.status) {
    case 'signed-in':
      return `Signed in as ${state.displayName ?? state.email}`;
    case 'signing-in':
      return 'Signing in';
    case 'unauthorized':
      return `Session rejected. ${state.reason}`;
    case 'signed-out':
      return 'Signed out';
  }
}

/**
 * Mirror the system appearance onto <html>.
 *
 * Three separate mechanisms, because three different consumers read three
 * different things: Tailwind's `darkMode: 'class'` reads `.dark`, the token
 * sheet may key off `data-theme`, and Chromium's own form controls, scrollbars
 * and focus rings read `color-scheme` — miss that last one and a dark window
 * gets light scrollbars.
 */
function applyAppearanceToDocument(appearance: SystemAppearance): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.classList.toggle('dark', appearance.shouldUseDarkColors);
  root.dataset['theme'] = appearance.shouldUseDarkColors ? 'dark' : 'light';
  root.style.colorScheme = appearance.shouldUseDarkColors ? 'dark' : 'light';
  root.setAttribute(REDUCE_MOTION_ATTRIBUTE, String(appearance.reduceMotion));
  root.setAttribute(REDUCE_TRANSPARENCY_ATTRIBUTE, String(appearance.reduceTransparency));
  root.setAttribute('data-increase-contrast', String(appearance.increaseContrast));
}
