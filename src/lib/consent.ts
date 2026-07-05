/**
 * Cookie-consent state shared between the consent banner and any future
 * tracking code.
 *
 * The user's choice lives in localStorage under `juno:consent:v1`. Essential
 * cookies (the sign-in session) are always on; `analytics` gates anything
 * optional added later. Any future analytics/tracking MUST check
 * `getConsent()?.analytics === true` before loading, and re-check via
 * `onConsentChange` so a withdrawn consent takes effect without a reload.
 */

export interface ConsentState {
  /** Sign-in/session cookies — required for the service to work, never optional. */
  essential: true;
  /** Whether the user opted into (future) analytics cookies. */
  analytics: boolean;
  /** Epoch ms when the choice was made. */
  ts: number;
}

export const CONSENT_STORAGE_KEY = "juno:consent:v1";

/** Same-tab change notifications (the native `storage` event only fires cross-tab). */
const CONSENT_EVENT = "juno:consent-change";

/** Read the stored choice, or null when the user hasn't decided yet (or on the server). */
export function getConsent(): ConsentState | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CONSENT_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ConsentState>;
    if (typeof parsed?.analytics !== "boolean") return null;
    return { essential: true, analytics: parsed.analytics, ts: typeof parsed.ts === "number" ? parsed.ts : 0 };
  } catch {
    return null;
  }
}

/** Persist a choice and notify listeners in this tab. Returns the stored state. */
export function setConsent(analytics: boolean): ConsentState {
  const state: ConsentState = { essential: true, analytics, ts: Date.now() };
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Storage unavailable (private mode, quota) — the banner simply reappears next visit.
  }
  window.dispatchEvent(new CustomEvent<ConsentState>(CONSENT_EVENT, { detail: state }));
  return state;
}

/** Subscribe to consent changes (same tab and other tabs). Returns an unsubscribe. */
export function onConsentChange(listener: (state: ConsentState | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onLocal = (e: Event) => listener((e as CustomEvent<ConsentState>).detail ?? getConsent());
  const onStorage = (e: StorageEvent) => {
    if (e.key === CONSENT_STORAGE_KEY) listener(getConsent());
  };
  window.addEventListener(CONSENT_EVENT, onLocal);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CONSENT_EVENT, onLocal);
    window.removeEventListener("storage", onStorage);
  };
}
