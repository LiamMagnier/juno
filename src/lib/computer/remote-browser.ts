import "server-only";
import type { Browser, BrowserContext, Page } from "playwright";
import type {
  BrowserElement,
  BrowserOutcome,
  BrowserPageState,
  WorkBrowser,
} from "@/lib/work/browser";
import {
  describeBrowserError,
  selectorForElement,
  snapshotPage,
  submitsFormOnPage,
} from "@/lib/work/browser-page";
import { computerProvider } from "./provider";
import type { ComputerHandle, ComputerProvider, ComputerSecrets } from "./types";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 25_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

export interface ConnectAgentBrowserOptions {
  provider?: ComputerProvider;
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
}

export interface RemoteAgentBrowser extends WorkBrowser {
  withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>;
}

function createFakeAgentBrowser(): RemoteAgentBrowser {
  let currentUrlValue = "";
  let elements: BrowserElement[] = [];
  let takesPayment = false;

  function makePageState(url: string): BrowserPageState {
    elements = [
      {
        ref: 1,
        role: "link",
        label: "Continue",
        href: `${url.replace(/\/$/, "")}/next`,
      },
      {
        ref: 2,
        role: "textbox",
        label: "Search",
        method: "get",
      },
    ];
    takesPayment = url.includes("checkout") || url.includes("pay");
    return {
      url,
      title: `Agent Browser — ${url}`,
      html: `<html><head><title>Agent Browser — ${url}</title></head><body><a href="${url}/next">Continue</a></body></html>`,
      elements,
    };
  }

  return {
    available: () => true,
    currentUrl: () => currentUrlValue,
    submitMethod: (target) =>
      (typeof target.ref === "number"
        ? elements.find((e) => e.ref === target.ref)?.method
        : undefined) ?? null,
    pageTakesPayment: () => takesPayment,
    async open(url: string): Promise<BrowserOutcome> {
      currentUrlValue = url;
      return { ok: true, page: makePageState(url) };
    },
    async read(): Promise<BrowserOutcome> {
      if (!currentUrlValue) {
        return { ok: false, message: "Nothing is open yet. Open a URL first." };
      }
      return { ok: true, page: makePageState(currentUrlValue) };
    },
    async click(target): Promise<BrowserOutcome> {
      if (!currentUrlValue) {
        return { ok: false, message: "Nothing is open yet. Open a URL first." };
      }
      const resolved = selectorForElement(elements, target);
      if ("refusal" in resolved) {
        return { ok: false, message: resolved.refusal };
      }
      return { ok: true, page: makePageState(currentUrlValue) };
    },
    async typeText(target): Promise<BrowserOutcome> {
      if (!currentUrlValue) {
        return { ok: false, message: "Nothing is open yet. Open a URL first." };
      }
      const resolved = selectorForElement(elements, target);
      if ("refusal" in resolved) {
        return { ok: false, message: resolved.refusal };
      }
      return { ok: true, page: makePageState(currentUrlValue) };
    },
    async submit(target): Promise<BrowserOutcome> {
      if (!currentUrlValue) {
        return { ok: false, message: "Nothing is open yet. Open a URL first." };
      }
      const resolved = selectorForElement(elements, target);
      if ("refusal" in resolved) {
        return { ok: false, message: resolved.refusal };
      }
      return { ok: true, page: makePageState(currentUrlValue) };
    },
    async withPage(): Promise<never> {
      throw new Error("withPage is only available on real CDP browsers");
    },
    async close(): Promise<void> {
      // No-op for fake browser
    },
  };
}

export function connectAgentBrowser(
  handle: ComputerHandle,
  secrets: ComputerSecrets,
  options?: ConnectAgentBrowserOptions
): RemoteAgentBrowser {
  const provider = options?.provider ?? computerProvider();
  if (provider?.name === "fake") {
    return createFakeAgentBrowser();
  }

  const navigationTimeout =
    options?.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  const actionTimeout = options?.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let unavailable: string | null = null;
  let elements: BrowserElement[] = [];
  let takesPayment = false;

  function resolveWsEndpoint(baseCdpUrl: string): string {
    const endpoint = new URL(baseCdpUrl);
    endpoint.protocol = ["https:", "wss:"].includes(endpoint.protocol) ? "wss:" : "ws:";
    endpoint.pathname = "/devtools/browser";
    return endpoint.toString();
  }

  async function ensurePage(): Promise<Page | string> {
    if (page && !page.isClosed()) return page;
    if (unavailable) return unavailable;
    if (!provider) {
      unavailable = "Agent computer provider is not configured.";
      return unavailable;
    }

    try {
      const ep = await provider.endpoints(handle);
      const wsUrl = await resolveWsEndpoint(ep.cdpUrl);
      const { chromium } = await import("playwright");
      browser = await chromium.connectOverCDP(wsUrl, {
        headers: {
          "X-Juno-Cdp-Token": secrets.cdpToken,
        },
        timeout: 15_000,
      });

      const existingContexts = browser.contexts();
      context = existingContexts[0] ?? (await browser.newContext());
      context.setDefaultNavigationTimeout(navigationTimeout);
      context.setDefaultTimeout(actionTimeout);
      context.on("page", (opened) => {
        page = opened;
      });
      const existingPages = context.pages();
      page = existingPages[0] ?? (await context.newPage());
      return page;
    } catch (error) {
      unavailable = `Juno could not connect to the agent computer's browser: ${describeBrowserError(error)}`;
      await close();
      return unavailable;
    }
  }

  async function snapshot(current: Page): Promise<BrowserPageState> {
    const res = await snapshotPage(current, navigationTimeout);
    elements = res.elements;
    takesPayment = res.takesPayment;
    return res.page;
  }

  async function act(
    run: (current: Page) => Promise<string | null>
  ): Promise<BrowserOutcome> {
    const current = await ensurePage();
    if (typeof current === "string") return { ok: false, message: current };
    if (!current.url() || current.url() === "about:blank") {
      return { ok: false, message: "Nothing is open yet. Open a URL first." };
    }
    try {
      const refusal = await run(current);
      if (refusal) return { ok: false, message: refusal };
      return { ok: true, page: await snapshot(page ?? current) };
    } catch (error) {
      return { ok: false, message: describeBrowserError(error) };
    }
  }

  async function close(): Promise<void> {
    const b = browser;
    page = null;
    context = null;
    browser = null;
    elements = [];
    takesPayment = false;
    // Disconnect Playwright from CDP without closing the container's Chromium pages
    await b?.close().catch(() => {});
  }

  return {
    available: () => unavailable === null,
    currentUrl: () => {
      const url = page?.url() ?? "";
      return url === "about:blank" ? "" : url;
    },
    submitMethod: (target) =>
      (typeof target.ref === "number"
        ? elements.find((element) => element.ref === target.ref)?.method
        : undefined) ?? null,
    pageTakesPayment: () => takesPayment,

    async open(url: string) {
      const current = await ensurePage();
      if (typeof current === "string") return { ok: false, message: current };
      try {
        const response = await current.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: navigationTimeout,
        });
        const status = response?.status() ?? 0;
        if (status >= 400) {
          return { ok: false, message: `${url} answered ${status}.` };
        }
        return { ok: true, page: await snapshot(page ?? current) };
      } catch (error) {
        return { ok: false, message: describeBrowserError(error) };
      }
    },

    read() {
      return act(() => Promise.resolve(null));
    },

    click(target) {
      const resolved = selectorForElement(elements, target);
      if ("refusal" in resolved) {
        return Promise.resolve({ ok: false, message: resolved.refusal });
      }
      const selector = resolved.selector;
      return act(async (current) => {
        if (await submitsFormOnPage(current, selector)) {
          return 'That control sends the form it is in, so it is not a click. Use action "submit" instead — the user is asked before a form is sent.';
        }
        await current.click(selector, { timeout: actionTimeout });
        return null;
      });
    },

    typeText(target, text) {
      const resolved = selectorForElement(elements, target);
      if ("refusal" in resolved) {
        return Promise.resolve({ ok: false, message: resolved.refusal });
      }
      const selector = resolved.selector;
      return act(async (current) => {
        await current.fill(selector, text, { timeout: actionTimeout });
        return null;
      });
    },

    submit(target) {
      const resolved = selectorForElement(elements, target);
      if ("refusal" in resolved) {
        return Promise.resolve({ ok: false, message: resolved.refusal });
      }
      const selector = resolved.selector;
      return act(async (current) => {
        const field = await current
          .$eval(selector, (node) =>
            ["input", "textarea"].includes(node.tagName.toLowerCase())
          )
          .catch(() => false);
        if (field) {
          await current.press(selector, "Enter", { timeout: actionTimeout });
        } else {
          await current.click(selector, { timeout: actionTimeout });
        }
        await current
          .waitForLoadState("load", { timeout: navigationTimeout })
          .catch(() => {});
        return null;
      });
    },

    async withPage<T>(fn: (current: Page) => Promise<T>): Promise<T> {
      const current = await ensurePage();
      if (typeof current === "string") {
        throw new Error(current);
      }
      return fn(current);
    },

    close,
  };
}
