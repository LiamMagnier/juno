import test from "node:test";
import assert from "node:assert/strict";
import {
  DESKTOP_APP_DOWNLOAD_PATH,
  DESKTOP_APP_OPENED_KEY,
  DESKTOP_APP_SCHEME,
  DESKTOP_APP_URL,
  decideMacAppOpen,
  desktopAppURL,
  isDesktopShell,
  isMacBrowser,
  launchesFromFrame,
  macAppDeepLinkPath,
  macAppProbeResult,
  readOpenedHereBefore,
  writeOpenedHereBefore,
} from "@/lib/desktop-app-link";
import { macAppPresence } from "@/lib/mac-app-presence";

/*
 * The home tray's "Mac app" (src/lib/desktop-app-link.ts): open the installed
 * app on its registered scheme, the download page when nothing answers, and
 * the scheme only with evidence the app is there.
 */

const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15";
const MAC_FIREFOX = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:140.0) Gecko/20100101 Firefox/140.0";
const MAC_EDGE = `${MAC_CHROME} Edg/141.0.0.0`;
const WINDOWS_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

test("the scheme is the one the Mac app registers (native/Config/Base.xcconfig)", async () => {
  const { readFileSync } = await import("node:fs");
  const config = readFileSync("native/Config/Base.xcconfig", "utf8");
  assert.match(config, new RegExp(`JUNO_AUTH_CALLBACK_SCHEME = ${DESKTOP_APP_SCHEME.replace(/\./g, "\\.")}\\s`));
  assert.ok(DESKTOP_APP_URL.startsWith(`${DESKTOP_APP_SCHEME}://`));
  assert.equal(DESKTOP_APP_DOWNLOAD_PATH, "/download");
});

test("only a Mac tries the app; an iPad asking for the desktop site does not", () => {
  assert.equal(isMacBrowser({ userAgent: MAC_CHROME, maxTouchPoints: 0 }), true);
  assert.equal(isMacBrowser({ userAgent: MAC_SAFARI, maxTouchPoints: 0 }), true);
  assert.equal(isMacBrowser({ userAgent: MAC_SAFARI, maxTouchPoints: 5 }), false);
  assert.equal(isMacBrowser({ userAgent: WINDOWS_CHROME, maxTouchPoints: 0 }), false);
});

test("Safari and Firefox try the scheme from a frame, Chromium from a navigation", () => {
  assert.equal(launchesFromFrame(MAC_SAFARI), true);
  assert.equal(launchesFromFrame(MAC_FIREFOX), true);
  assert.equal(launchesFromFrame(MAC_CHROME), false);
  assert.equal(launchesFromFrame(MAC_EDGE), false);
});

test("inside the app's own shell the link is not offered", () => {
  assert.equal(isDesktopShell(`${MAC_SAFARI} Alevr/1.9.3`), true);
  assert.equal(isDesktopShell(MAC_SAFARI), false);
});

const none = { accountHasMac: false, openedHereBefore: false };

test("a browser that is not a Mac goes to the download page, whatever the evidence", () => {
  assert.equal(decideMacAppOpen({ isMac: false, inDesktopShell: false, evidence: none }), "download");
  assert.equal(
    decideMacAppOpen({ isMac: false, inDesktopShell: false, evidence: { accountHasMac: true, openedHereBefore: true } }),
    "download",
  );
});

test("a Mac with no evidence goes straight to the download page: the scheme is never fired blind", () => {
  assert.equal(decideMacAppOpen({ isMac: true, inDesktopShell: false, evidence: none }), "download");
});

test("a Mac with either kind of evidence tries the app first", () => {
  assert.equal(
    decideMacAppOpen({ isMac: true, inDesktopShell: false, evidence: { accountHasMac: true, openedHereBefore: false } }),
    "try-app",
  );
  assert.equal(
    decideMacAppOpen({ isMac: true, inDesktopShell: false, evidence: { accountHasMac: false, openedHereBefore: true } }),
    "try-app",
  );
});

test("inside the app's own shell the control is hidden", () => {
  assert.equal(
    decideMacAppOpen({ isMac: true, inDesktopShell: true, evidence: { accountHasMac: true, openedHereBefore: true } }),
    "hidden",
  );
});

test("a timeout falls back to the download page and forgets; losing focus remembers and stays", () => {
  assert.deepEqual(macAppProbeResult("timeout"), { fallback: true, remember: false });
  assert.deepEqual(macAppProbeResult("left"), { fallback: false, remember: true });
});

test("only a conversation or a Code session is deep linked", () => {
  assert.equal(macAppDeepLinkPath("/chat/cm1abc23"), "/chat/cm1abc23");
  assert.equal(macAppDeepLinkPath("/code/3f2a-11_b"), "/code/3f2a-11_b");
  for (const path of ["/", "/chat", "/chat/", "/chat/a/b", "/settings", "/chat/a.b", "//evil/chat/a", "/chat/a%2Fb", null, undefined]) {
    assert.equal(macAppDeepLinkPath(path), null, String(path));
  }
  assert.equal(desktopAppURL("/chat/cm1abc23"), `${DESKTOP_APP_URL}?path=%2Fchat%2Fcm1abc23`);
  assert.equal(desktopAppURL("/settings"), DESKTOP_APP_URL);
  assert.equal(desktopAppURL(null), "com.liammagnier.juno://open");
});

test("this browser's flag survives a round trip and a storage that throws", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  assert.equal(readOpenedHereBefore(storage), false);
  writeOpenedHereBefore(true, storage);
  assert.equal(store.get(DESKTOP_APP_OPENED_KEY), "1");
  assert.equal(readOpenedHereBefore(storage), true);
  writeOpenedHereBefore(false, storage);
  assert.equal(readOpenedHereBefore(storage), false);

  const blocked = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => {
      throw new Error("SecurityError");
    },
    removeItem: () => {
      throw new Error("SecurityError");
    },
  };
  assert.equal(readOpenedHereBefore(blocked), false);
  assert.doesNotThrow(() => writeOpenedHereBefore(true, blocked));
  assert.equal(readOpenedHereBefore(null), false);
});

test("the account's presence is the latest Mac signal, or none", () => {
  assert.deepEqual(macAppPresence([null, undefined]), { installed: false, lastSeenAt: null });
  const older = new Date("2026-09-20T10:00:00Z");
  const newer = new Date("2026-10-09T08:30:00Z");
  assert.deepEqual(macAppPresence([older, null, newer]), { installed: true, lastSeenAt: newer.toISOString() });
});
