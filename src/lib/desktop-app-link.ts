/**
 * "Mac app" from the browser: open the installed app, or the download page
 * when there is none.
 *
 * The Mac app registers the custom scheme `com.liammagnier.juno`
 * (native/Config/Base.xcconfig `JUNO_AUTH_CALLBACK_SCHEME`, the same one its
 * sign-in callback rides), so asking the browser to open a URL on that scheme
 * launches or activates it. A page cannot ask whether a scheme is handled, so
 * the answer is read from what happens next: when the app opens (or the
 * browser asks "Open Alevr?"), the page loses focus or is hidden within a
 * moment; when nothing handles the scheme, nothing happens at all, and after
 * `DESKTOP_APP_PROBE_MS` the visitor is taken to the download page instead.
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
/** How long to wait for the page to lose focus before deciding the app is not installed. */
export const DESKTOP_APP_PROBE_MS = 1200;

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
 * Tries the installed app; calls `fallback` (the download page) when the page
 * keeps its focus for `DESKTOP_APP_PROBE_MS`. Returns a cancel function.
 */
export function openDesktopApp({
  fallback,
  url = DESKTOP_APP_URL,
  timeoutMs = DESKTOP_APP_PROBE_MS,
}: {
  fallback: () => void;
  url?: string;
  timeoutMs?: number;
}): () => void {
  if (!isMacBrowser(navigator)) {
    fallback();
    return () => {};
  }

  let settled = false;
  let frame: HTMLIFrameElement | null = null;
  const left = () => {
    if (!document.hidden && document.hasFocus()) return;
    finish(false);
  };
  const onBlur = () => finish(false);
  const finish = (fellBack: boolean) => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("pagehide", onBlur);
    document.removeEventListener("visibilitychange", left);
    // The frame stays a beat after a launch: removing it mid-handoff can
    // cancel the open in Safari.
    const stale = frame;
    if (stale) window.setTimeout(() => stale.remove(), fellBack ? 0 : 2000);
    if (fellBack) fallback();
  };

  window.addEventListener("blur", onBlur);
  window.addEventListener("pagehide", onBlur);
  document.addEventListener("visibilitychange", left);
  const timer = window.setTimeout(() => finish(true), timeoutMs);

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
    finish(true);
  }

  return () => {
    if (settled) return;
    settled = true;
    window.clearTimeout(timer);
    window.removeEventListener("blur", onBlur);
    window.removeEventListener("pagehide", onBlur);
    document.removeEventListener("visibilitychange", left);
    frame?.remove();
  };
}
