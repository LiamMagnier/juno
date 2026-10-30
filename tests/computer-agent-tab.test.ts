/**
 * Which page the agent's browser drives on its computer (src/lib/computer/remote-browser.ts).
 * Chromium exposes its own WebUI as page targets (the address bar's suggestion popup,
 * chrome://omnibox-popup.top-chrome/), and Playwright lists them before the tabs, so
 * `context.pages()[0]` was a page with no window: the agent typed into a page nobody could
 * see while the person's live view showed the real tab. The real-container suite
 * (tests/computer-real-e2e.test.ts, tests 3 and 9) proves the fix on a real Chromium; this
 * holds the choice itself.
 */
import assert from "node:assert/strict";
import Module, { createRequire } from "node:module";
import { describe, it } from "node:test";

const loader = Module as unknown as { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
const original = loader._load;
loader._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === "server-only") return {};
  return original.call(this, request, parent, isMain);
};
const req = createRequire(__filename);
const remoteBrowser = req("../src/lib/computer/remote-browser") as typeof import("@/lib/computer/remote-browser");

describe("the agent browser's tab", () => {
  const omnibox = { url: "chrome-error://chromewebdata/", window: false };
  const omniboxAim = { url: "chrome-error://chromewebdata/", window: false };
  const tab = { url: "about:blank", window: true };
  const errorTab = { url: "chrome-error://chromewebdata/", window: true };
  const isTab = async (page: { window: boolean }) => page.window;

  it("skips Chromium's own pages, which come first, and takes the first tab", async () => {
    assert.equal(await remoteBrowser.firstBrowserTab([omnibox, omniboxAim, tab], isTab), tab);
  });

  it("keeps a tab that shows an error page: it is a tab, whatever its URL", async () => {
    assert.equal(await remoteBrowser.firstBrowserTab([omnibox, errorTab, tab], isTab), errorTab);
  });

  it("finds none when there is no tab, so the caller opens one", async () => {
    assert.equal(await remoteBrowser.firstBrowserTab([omnibox, omniboxAim], isTab), null);
    assert.equal(await remoteBrowser.firstBrowserTab([], isTab), null);
  });

  it("a page whose window cannot be asked about is not a tab", async () => {
    const broken = { context: () => ({ newCDPSession: async () => Promise.reject(new Error("Target closed")) }) };
    assert.equal(await remoteBrowser.isBrowserTab(broken as never), false);
    const popup = {
      context: () => ({
        newCDPSession: async () => ({
          send: async () => Promise.reject(new Error("Protocol error (Browser.getWindowForTarget): Browser window not found")),
          detach: async () => undefined,
        }),
      }),
    };
    assert.equal(await remoteBrowser.isBrowserTab(popup as never), false);
    let detached = false;
    const real = {
      context: () => ({
        newCDPSession: async () => ({ send: async () => ({ windowId: 1 }), detach: async () => void (detached = true) }),
      }),
    };
    assert.equal(await remoteBrowser.isBrowserTab(real as never), true);
    assert.equal(detached, true, "the probe's session is detached");
  });
});
