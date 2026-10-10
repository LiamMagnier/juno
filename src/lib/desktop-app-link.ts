/**
 * "Mac app" from the browser: open the installed app, or the download page
 * when there is none.
 *
 * The Mac app registers the custom scheme `com.liammagnier.juno`
 * (native/Config/Base.xcconfig `JUNO_AUTH_CALLBACK_SCHEME`, the same one its
 * sign-in callback rides), and reads `com.liammagnier.juno://open`, with an
 * optional `?path=/chat/<id>` or `/code/<id>`, as "come forward and go there"
 * (native/macOS/JunoDesktop/App/DesktopOpenLink.swift). A build without that
 * reader (1.10.5 and earlier) still comes forward on it.
 *
 * A page cannot ask whether a scheme is handled, and asking blindly is not
 * free: Safari answers an unregistered one with an "address is invalid"
 * alert. So the scheme is tried only with evidence the app is there
 * (`decideMacAppOpen`): the account has a Mac seen in the last 30 days
 * (GET /api/devices/mac-app), or this browser opened the app before. With
 * none, the click goes straight to the download page.
 *
 * With evidence, the answer is read from what happens next: when the app
 * opens (or the browser asks "Open Alevr?"), the page loses focus or is hidden
 * within a moment; when nothing takes it, after `DESKTOP_APP_PROBE_MS` the
 * visitor is taken to the download page instead, and this browser forgets it
 * ever opened the app.
 *
 * Chromium launches a scheme from a top-level navigation and silently ignores
 * one nobody handles. Safari and Firefox show an error page (Safari an alert)
 * for an unhandled top-level one, so there the attempt rides a hidden iframe,
 * which fails silently and still launches a registered app.
 *
 * Only on a Mac: the iPhone app registers the same scheme, and a Windows or
 * Linux visitor has no app to open.
 */

export const DESKTOP_APP_SCHEME = "com.liammagnier.juno";
/** Opens (or brings forward) the app on its main window. */
export const DESKTOP_APP_URL = `${DESKTOP_APP_SCHEME}://open`;
export const DESKTOP_APP_DOWNLOAD_PATH = "/download";
/** How long to wait for the page to lose focus before deciding the app did not open. */
export const DESKTOP_APP_PROBE_MS = 1500;
/** This browser opened the app before: evidence on its own (localStorage). */
export const DESKTOP_APP_OPENED_KEY = "alevr.macApp.opened";

/** The in-app routes the Mac app follows; anything else opens it where it was. */
const DEEP_LINK = /^\/(chat|code)\/[A-Za-z0-9_-]{1,128}$/;

/** A Mac browser (not an iPad asking for the desktop site: it has touch points). */
export function isMacBrowser(nav: Pick<Navigator, "userAgent" | "maxTouchPoints">): boolean {
  return /Macintosh|Mac OS X/i.test(nav.userAgent) && !(nav.maxTouchPoints > 1);
}

/** Inside the app's own shell, where a link to the app would point at itself. */
export function isDesktopShell(userAgent: string): boolean {
  return /Electron|Alevr|Juno/i.test(userAgent);
}

/** Whether the scheme should be tried from a hidden iframe (Safari, Firefox) rather than a navigation (Chromium). */
export function launchesFromFrame(userAgent: string): boolean {
  if (/Chrome|Chromium|CriOS|Edg\//i.test(userAgent)) return false;
  return /Safari|Firefox/i.test(userAgent);
}

/**
 * The page path the app should land on, when it is one the app follows:
 * a conversation (`/chat/<id>`) or a Code session (`/code/<id>`). Pure.
 */
export function macAppDeepLinkPath(pathname: string | null | undefined): string | null {
  if (!pathname) return null;
  return DEEP_LINK.test(pathname) ? pathname : null;
}

/** `com.liammagnier.juno://open`, with `?path=` only for an allow-listed route. Pure. */
export function desktopAppURL(path?: string | null): string {
  const target = macAppDeepLinkPath(path);
  return target ? `${DESKTOP_APP_URL}?path=${encodeURIComponent(target)}` : DESKTOP_APP_URL;
}

export type MacAppEvidence = {
  /** The account has a Mac seen in the last 30 days (GET /api/devices/mac-app). */
  accountHasMac: boolean;
  /** This browser opened the app before (`DESKTOP_APP_OPENED_KEY`). */
  openedHereBefore: boolean;
};

/**
 * What a click on "Mac app" does. Pure.
 *  - `hidden`: inside the app's own shell, where the link would point at itself.
 *  - `download`: not a Mac, or no evidence the app is there.
 *  - `try-app`: ask for the scheme, falling back to the download page.
 */
export function decideMacAppOpen({
  isMac,
  inDesktopShell,
  evidence,
}: {
  isMac: boolean;
  inDesktopShell: boolean;
  evidence: MacAppEvidence;
}): "hidden" | "download" | "try-app" {
  if (inDesktopShell) return "hidden";
  if (!isMac) return "download";
  return evidence.accountHasMac || evidence.openedHereBefore ? "try-app" : "download";
}

/**
 * What the probe's outcome means. Pure.
 *  - `left`: the page lost focus or was hidden, so the app (or the browser's
 *    "Open Alevr?" prompt) took it: remember this browser opened the app.
 *  - `timeout`: nothing took it: go to the download page, and forget.
 */
export function macAppProbeResult(outcome: "left" | "timeout"): { fallback: boolean; remember: boolean } {
  return outcome === "left" ? { fallback: false, remember: true } : { fallback: true, remember: false };
}

/** Reads this browser's flag; false whenever storage is unavailable. */
export function readOpenedHereBefore(storage: Pick<Storage, "getItem"> | null = safeStorage()): boolean {
  try {
    return storage?.getItem(DESKTOP_APP_OPENED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Writes (or clears) this browser's flag; a blocked storage is ignored. */
export function writeOpenedHereBefore(
  value: boolean,
  storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage(),
): void {
  try {
    if (value) storage?.setItem(DESKTOP_APP_OPENED_KEY, "1");
    else storage?.removeItem(DESKTOP_APP_OPENED_KEY);
  } catch {
    // Private windows and blocked site data: the account's signal still works.
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Asks the browser for the app's URL; calls `fallback` (the download page)
 * when the page keeps its focus for `timeoutMs`, and `onResult` with the
 * outcome either way. Returns a cancel function. Callers decide first, with
 * `decideMacAppOpen`, whether to try at all.
 */
export function probeDesktopApp({
  url,
  fallback,
  onResult,
  timeoutMs = DESKTOP_APP_PROBE_MS,
}: {
  url: string;
  fallback: () => void;
  onResult?: (outcome: "left" | "timeout") => void;
  timeoutMs?: number;
}): () => void {
  let settled = false;
  let frame: HTMLIFrameElement | null = null;
  const left = () => {
    if (!document.hidden && document.hasFocus()) return;
    finish("left");
  };
  const onBlur = () => finish("left");
  const detach = () => {
    window.clearTimeout(timer);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("pagehide", onBlur);
    document.removeEventListener("visibilitychange", left);
  };
  const finish = (outcome: "left" | "timeout") => {
    if (settled) return;
    settled = true;
    detach();
    const result = macAppProbeResult(outcome);
    // The frame stays a beat after a launch: removing it mid-handoff can
    // cancel the open in Safari.
    const stale = frame;
    if (stale) window.setTimeout(() => stale.remove(), result.fallback ? 0 : 2000);
    onResult?.(outcome);
    if (result.fallback) fallback();
  };

  window.addEventListener("blur", onBlur);
  window.addEventListener("pagehide", onBlur);
  document.addEventListener("visibilitychange", left);
  const timer = window.setTimeout(() => finish("timeout"), timeoutMs);

  try {
    if (launchesFromFrame(navigator.userAgent)) {
      frame = document.createElement("iframe");
      frame.hidden = true;
      frame.setAttribute("aria-hidden", "true");
      frame.tabIndex = -1;
      frame.src = url;
      document.body.appendChild(frame);
    } else {
      window.location.href = url;
    }
  } catch {
    finish("timeout");
  }

  return () => {
    if (settled) return;
    settled = true;
    detach();
    frame?.remove();
  };
}
