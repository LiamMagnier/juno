import test from "node:test";
import assert from "node:assert/strict";
import {
  DESKTOP_APP_DOWNLOAD_PATH,
  DESKTOP_APP_SCHEME,
  DESKTOP_APP_URL,
  isDesktopShell,
  isMacBrowser,
  launchesFromFrame,
} from "@/lib/desktop-app-link";

/*
 * The home tray's "Mac app" (src/lib/desktop-app-link.ts): open the installed
 * app on its registered scheme, the download page when nothing answers.
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
