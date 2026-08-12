/**
 * Process-wide hardening.
 *
 * These policies are applied once, at startup, to the whole `app` and to every
 * session — not per-window. A policy attached to a single window is a policy
 * that a future second window silently does not have, and "we forgot to harden
 * the settings window" is a recognisable way for this class of app to be
 * compromised.
 *
 * Every deny below is deliberate. Where a capability is genuinely needed later
 * (microphone for voice, screen capture for Computer Use) it is granted through
 * an explicit, user-consented path with its own audit trail, not by loosening
 * one of these defaults.
 */

import { app, session, shell, type BrowserWindow, type WebContents } from 'electron';
import { URL } from 'node:url';

/**
 * The origin the renderer is served from in production.
 *
 * A custom scheme rather than `file://`. `file://` origins are opaque, which
 * makes a meaningful CSP and sane `fetch` semantics awkward, and historically
 * `file://` has been the starting point for local-file-read escalations. A
 * registered standard scheme gets a real origin with normal web security.
 */
export const APP_SCHEME = 'juno';
export const APP_HOST = 'app';
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`;

/**
 * Hosts the app may open in the user's *external* browser.
 *
 * This is not a list of things the app may load — nothing external is ever
 * loaded in-process. It is the allowlist for `shell.openExternal`, which hands
 * a URL to the OS. Without it, any link in agent output or a sync payload could
 * ask the OS to open an arbitrary URL, and `openExternal` will happily launch
 * non-http schemes that map to local applications.
 */
const EXTERNAL_HOST_ALLOWLIST = new Set([
  'chat.liams.dev',
  'liams.dev',
  'github.com',
  'docs.claude.com',
  'developers.openai.com',
]);

/**
 * The Content-Security-Policy for the renderer.
 *
 * `script-src 'self'` with no `'unsafe-inline'` and no `'unsafe-eval'`: the
 * renderer bundle is the only script that runs. `connect-src 'self'` means the
 * renderer cannot originate network traffic at all — every backend call goes
 * through main over IPC, which is what keeps bearer tokens out of the renderer.
 *
 * `style-src` permits inline styles because React and Framer Motion set them on
 * elements directly; there is no practical way to run a motion system without
 * it. That is an accepted, documented residual risk in `THREAT_MODEL.md`, and
 * it is a much smaller one than inline *script* because style injection cannot
 * execute code under this policy.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

/**
 * `webPreferences` for every window in the app.
 *
 * Exported as a frozen object so a window cannot be created with a
 * near-miss variant of it.
 */
export const SECURE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  /* The <webview> tag is a large, historically leaky surface and this app has
     no use for it — previews use a separate window with its own partition. */
  webviewTag: false,
  /* Deny the renderer any access to Chromium's spellcheck network fetches. */
  spellcheck: false,
} as const);

/**
 * Applied to the default session and to every partition the app creates.
 */
export function hardenSession(target: Electron.Session): void {
  /* Every permission request is denied by default. Electron's default is to
     *grant* several of these for non-remote content, which for an app that
     loads its own renderer means effectively granting them outright. */
  target.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(false);
    logDeniedPermission(permission);
  });

  /* `setPermissionRequestHandler` covers asynchronous requests; the check
     handler covers synchronous ones (`navigator.permissions.query` and some
     media paths). Both must be set or the sync path silently defaults to
     allowed. */
  target.setPermissionCheckHandler(() => false);

  /* Deny all device access: HID, serial, USB, Bluetooth. None are used, and
     each is an OS-level capability reachable from a compromised renderer. */
  target.setDevicePermissionHandler(() => false);
  target.setBluetoothPairingHandler((_details, callback) => callback({ confirmed: false }));

  target.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CONTENT_SECURITY_POLICY],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });
}

function logDeniedPermission(permission: string): void {
  /* Routed through the structured logger in a later phase; kept explicit here
     so a denied permission is never silent during development. */
  console.warn(`[security] denied permission request: ${permission}`);
}

/**
 * Navigation and window-open policy for one WebContents.
 *
 * `will-navigate` catches in-page navigation (a link, a `location.assign`).
 * `setWindowOpenHandler` catches `window.open` and `target=_blank`. Both are
 * needed: neither implies the other.
 */
export function hardenWebContents(contents: WebContents): void {
  contents.on('will-navigate', (event, url) => {
    if (!isInternalUrl(url)) {
      event.preventDefault();
      console.warn(`[security] blocked in-page navigation to ${redactUrl(url)}`);
    }
  });

  contents.setWindowOpenHandler(({ url }) => {
    /* Never open a new Electron window. External links go to the user's
       browser, where they are subject to the browser's own sandboxing rather
       than running beside our preload bridge. */
    void openExternal(url);
    return { action: 'deny' };
  });

  /* A renderer that manages to attach a webview would otherwise inherit
     whatever webPreferences the attacker specifies. `webviewTag: false` should
     make this unreachable; this is the second lock on the same door. */
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
    console.warn('[security] blocked webview attachment');
  });
}

/**
 * Whether a URL belongs to the application itself.
 *
 * Compares the parsed `protocol` and `host` separately rather than using
 * `startsWith`, because `juno://app.evil.example/` shares a prefix with
 * `juno://app` and prefix checks on URLs are a well-worn source of bypasses.
 *
 * It compares `host` rather than `origin` for a specific reason. `juno:` is not
 * a "special" scheme to the WHATWG URL parser, and for non-special schemes the
 * parser returns the *string* `"null"` as the origin — so an origin comparison
 * rejects every legitimate URL, including our own renderer. Registering the
 * scheme as privileged fixes this inside Chromium's network stack but not in
 * Node's `URL`, which is what runs here in the main process. `host` is parsed
 * correctly for non-special schemes and is therefore the sound discriminator.
 */
export function isInternalUrl(candidate: string): boolean {
  try {
    const url = new URL(candidate);
    if (url.protocol === `${APP_SCHEME}:`) return url.host === APP_HOST;
    /* The dev server, and only on an unpackaged build. */
    if (!app.isPackaged && (url.protocol === 'http:' || url.protocol === 'https:')) {
      return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Hand a URL to the OS, if and only if it is an allowlisted https destination.
 *
 * The scheme check is the important half. `shell.openExternal` will act on
 * schemes that launch local applications, so a bare host check would still let
 * agent-authored output invoke handlers registered by other installed software.
 */
export async function openExternal(candidate: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') {
    console.warn(`[security] refused to open non-https URL: ${redactUrl(candidate)}`);
    return false;
  }
  if (!EXTERNAL_HOST_ALLOWLIST.has(url.hostname)) {
    console.warn(`[security] refused to open non-allowlisted host: ${url.hostname}`);
    return false;
  }

  await shell.openExternal(url.toString());
  return true;
}

/** Strips query and fragment, which are the parts most likely to carry a token. */
export function redactUrl(candidate: string): string {
  try {
    const url = new URL(candidate);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return '<unparseable-url>';
  }
}

/**
 * Startup-time, process-wide policy. Call before `app.whenReady()`.
 */
export function applyProcessSecurityPolicy(): void {
  /* A second instance would race the first for the SQLite database and the
     agent host's port. The single-instance lock is a data-integrity control as
     much as a UX one. */
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  /* Chromium's sandbox for every renderer, including any created later. */
  app.enableSandbox();

  app.on('web-contents-created', (_event, contents) => {
    hardenWebContents(contents);
  });

  /* Deny every certificate error rather than surfacing a proceed-anyway
     affordance. The app talks to exactly one backend over TLS; a certificate
     error there is an incident, not a prompt. */
  app.on('certificate-error', (event, _wc, url, error, _cert, callback) => {
    event.preventDefault();
    console.error(`[security] certificate error for ${redactUrl(url)}: ${error}`);
    callback(false);
  });
}

/**
 * Attach the window-level policies that need a concrete window.
 */
export function hardenWindow(window: BrowserWindow): void {
  hardenWebContents(window.webContents);
  hardenSession(window.webContents.session);
}

export { CONTENT_SECURITY_POLICY, EXTERNAL_HOST_ALLOWLIST };
export { session as defaultSessionModule };
