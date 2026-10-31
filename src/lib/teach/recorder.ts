import "server-only";
import type { Browser, BrowserContext, CDPSession, Page } from "playwright";
import { cdpConnectHeaders, cdpConnectUrl, isBrowserTab } from "@/lib/computer/remote-browser";
import type { ComputerHandle, ComputerProvider, ComputerSecrets } from "@/lib/computer/types";
import {
  PAGE_CAPTURE_SCRIPT,
  TEACH_BINDING_NAME,
  TEACH_WORLD_NAME,
  readPageReport,
} from "@/lib/teach/demonstration";
import type { RecorderSession, StartRecorderInput } from "@/lib/teach/service";

/*
 * The recorder: listens to the agent's Chromium while the person shows it a
 * task (docs/design/agents-v2/TEACH.md).
 *
 * It uses the computer's existing CDP gate, with the same token the agent's
 * browser uses, from the web process. The gate takes one connection at a
 * time, so a recording only starts when no task holds the computer (the
 * service checks the lease) and it disconnects before Hand back lets the
 * agent carry on. It never acts on a page: it adds a capture script to an
 * isolated world of each tab (`PAGE_CAPTURE_SCRIPT`), reads the main frame's
 * navigations, and now and then takes a small screenshot, only when the page
 * has said no secret is focused or filled in. Every report goes through
 * `readPageReport` and the collector; nothing here decides what is kept.
 */

const POLL_MS = 2_000;
const SHOT_WIDTH = 640;

export interface CdpRecorderTarget {
  handle: ComputerHandle;
  secrets: ComputerSecrets;
  provider: ComputerProvider;
}

interface Tab {
  page: Page;
  key: string;
  session: CDPSession;
  /** The capture world's execution context in the main frame, when known. */
  worldContextId: number | null;
  mainFrameId: string | null;
}

export async function startCdpRecorder(target: CdpRecorderTarget, input: StartRecorderInput): Promise<RecorderSession> {
  const ep = await target.provider.endpoints(target.handle, { purpose: "cdp" });
  const { chromium } = await import("playwright");
  const browser: Browser = await chromium.connectOverCDP(cdpConnectUrl(ep), {
    headers: cdpConnectHeaders(ep, target.secrets.cdpToken),
    timeout: 15_000,
  });
  const context: BrowserContext | undefined = browser.contexts()[0];
  if (!context) {
    await browser.close().catch(() => undefined);
    throw new Error("The computer's browser has no window.");
  }

  const tabs = new Map<Page, Tab>();
  let closed = false;
  let ended = false;
  let tabCount = 0;
  let front: Tab | null = null;

  const end = (reason: Parameters<StartRecorderInput["onEnd"]>[0]) => {
    if (ended || closed) return;
    ended = true;
    input.onEnd(reason);
  };

  const record = (tab: Tab, payload: string) => {
    const report = readPageReport(payload, Date.now());
    if (!report) return;
    if (report.kind !== "state") front = tab;
    if (input.collector.push(report, tab.key) === "full") end("step_cap");
    input.onCheckpoint();
  };

  async function attach(page: Page): Promise<void> {
    if (closed || tabs.has(page) || page.isClosed()) return;
    if (!(await isBrowserTab(page))) return;
    const session = await context!.newCDPSession(page);
    tabCount += 1;
    const tab: Tab = { page, key: `tab-${tabCount}`, session, worldContextId: null, mainFrameId: null };
    tabs.set(page, tab);
    session.on("Runtime.bindingCalled", (event: { name: string; payload: string; executionContextId: number }) => {
      // Only the capture world can call it: the binding exists nowhere else.
      if (event.name === TEACH_BINDING_NAME) record(tab, event.payload);
    });
    session.on("Runtime.executionContextCreated", (event: { context: { id: number; name: string; auxData?: { frameId?: string; isDefault?: boolean } } }) => {
      if (event.context.name === TEACH_WORLD_NAME && tab.mainFrameId && event.context.auxData?.frameId === tab.mainFrameId) {
        tab.worldContextId = event.context.id;
      }
    });
    session.on("Runtime.executionContextDestroyed", (event: { executionContextId: number }) => {
      if (event.executionContextId === tab.worldContextId) tab.worldContextId = null;
    });
    session.on("Runtime.executionContextsCleared", () => {
      tab.worldContextId = null;
    });
    session.on("Page.frameNavigated", (event: { frame: { id: string; parentId?: string } }) => {
      if (!event.frame.parentId) tab.mainFrameId = event.frame.id;
    });
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      front = tab;
      if (input.collector.push({ kind: "navigate", at: Date.now(), url: frame.url() }, tab.key) === "full") end("step_cap");
    });
    page.on("close", () => {
      tabs.delete(page);
      void session.detach().catch(() => undefined);
    });
    await session.send("Runtime.enable");
    await session.send("Runtime.addBinding", { name: TEACH_BINDING_NAME, executionContextName: TEACH_WORLD_NAME });
    await session.send("Page.enable");
    await session.send("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_CAPTURE_SCRIPT, worldName: TEACH_WORLD_NAME });
    // The document already open gets the script now, in a world of its own.
    const tree = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } };
    const world = (await session.send("Page.createIsolatedWorld", {
      frameId: tree.frameTree.frame.id,
      worldName: TEACH_WORLD_NAME,
      grantUniveralAccess: false,
    })) as { executionContextId: number };
    tab.mainFrameId = tree.frameTree.frame.id;
    tab.worldContextId = world.executionContextId;
    await session.send("Runtime.evaluate", { expression: PAGE_CAPTURE_SCRIPT, contextId: world.executionContextId });
    // Where the person starts is the first step.
    const url = page.url();
    if (url && url !== "about:blank") input.collector.push({ kind: "navigate", at: Date.now(), url }, tab.key);
    front = front ?? tab;
  }

  /** A screenshot of the tab in front, only when that page said no secret is on screen. */
  async function maybeShoot(): Promise<void> {
    const tab = front;
    const now = Date.now();
    if (!tab || tab.page.isClosed() || !input.collector.shotAllowed(now, tab.key)) return;
    // Asked again right before the capture, in the capture world; any doubt skips it.
    if (tab.worldContextId === null) return;
    const check = (await tab.session
      .send("Runtime.evaluate", {
        expression: "(function(){try{var a=document.activeElement;var f=document.querySelectorAll('input[type=password],input[autocomplete*=cc-],input[autocomplete=one-time-code]');for(var i=0;i<f.length;i++){if(f[i].value)return true;if(f[i]===a)return true;}return false;}catch(e){return true;}})()",
        contextId: tab.worldContextId,
        returnByValue: true,
      })
      .catch(() => null)) as { result?: { value?: unknown } } | null;
    if (check?.result?.value !== false) return;
    const metrics = (await tab.session.send("Page.getLayoutMetrics").catch(() => null)) as {
      cssVisualViewport?: { clientWidth: number; clientHeight: number; pageX: number; pageY: number };
    } | null;
    const viewport = metrics?.cssVisualViewport;
    if (!viewport || viewport.clientWidth <= 0 || viewport.clientHeight <= 0) return;
    const shot = (await tab.session
      .send("Page.captureScreenshot", {
        format: "jpeg",
        quality: 40,
        clip: {
          x: viewport.pageX,
          y: viewport.pageY,
          width: viewport.clientWidth,
          height: viewport.clientHeight,
          scale: Math.min(1, SHOT_WIDTH / viewport.clientWidth),
        },
      })
      .catch(() => null)) as { data?: string } | null;
    if (shot?.data) input.collector.addShot(shot.data, now);
    else input.collector.addShot("", now);
  }

  context.on("page", (page) => void attach(page).catch(() => undefined));
  browser.on("disconnected", () => end("error"));
  try {
    for (const page of context.pages()) await attach(page);
  } catch (error) {
    closed = true;
    await browser.close().catch(() => undefined);
    throw error;
  }

  let polling = false;
  const timer = setInterval(() => {
    if (polling || closed) return;
    polling = true;
    void (async () => {
      try {
        if (input.collector.expired(Date.now())) return end("time_cap");
        if (!(await input.stillHeld())) return end("handed_back");
        await maybeShoot();
        input.onCheckpoint();
      } catch {
        // One missed beat; the next one tries again.
      } finally {
        polling = false;
      }
    })();
  }, POLL_MS);
  timer.unref?.();

  return {
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const tab of tabs.values()) await tab.session.detach().catch(() => undefined);
      tabs.clear();
      // Disconnects from the gate; the computer's Chromium and its tabs stay.
      await browser.close().catch(() => undefined);
    },
  };
}
