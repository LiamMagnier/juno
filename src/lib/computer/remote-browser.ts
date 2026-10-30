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
  fieldKindOnPage,
  SECRET_FIELD_REFUSAL,
} from "@/lib/work/browser-page";
import { computerProvider } from "./provider";
import type { ComputerHandle, ComputerProvider, ComputerSecrets, Endpoints } from "./types";
import { PRODUCT_NAME } from "@/lib/brand/names";

const DEFAULT_NAVIGATION_TIMEOUT_MS = 25_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

export interface ConnectAgentBrowserOptions {
  provider?: ComputerProvider;
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
  /**
   * Site policy for navigations the AGENT causes (security audit, computer
   * gap 7): a refusal sentence, or null to allow. Applied to top-level
   * navigations only, and only while an agent action is in flight — the
   * person driving the same Chromium during a takeover is never filtered.
   */
  navigationRefusal?: (url: string) => string | null;
}

/**
 * The navigation rule, pure for tests: a top-level navigation during an agent
 * action is refused when the policy says so; everything else continues.
 */
export function agentNavigationVerdict(input: {
  agentActing: boolean;
  isNavigation: boolean;
  isMainFrame: boolean;
  url: string;
  policy?: (url: string) => string | null;
}): string | null {
  if (!input.agentActing || !input.isNavigation || !input.isMainFrame || !input.policy) return null;
  return input.policy(input.url);
}

/** What is under a point, or focused, in the page in front, in words. */
export interface PageTarget {
  role: string;
  name: string;
  host: string;
}

/**
 * Turns a screen point into words, for the sentences a person is shown
 * ("Click the “Sign in” button on example.com"). Null whenever the answer
 * would be a guess: Chromium is not the window in front, the point is on the
 * browser's own toolbar or outside the page, or the element is a frame.
 */
export interface PointDescriber {
  describePoint(x: number, y: number): Promise<PageTarget | null>;
  describeFocus(): Promise<PageTarget | null>;
}

export interface RemoteAgentBrowser extends WorkBrowser, PointDescriber {
  withPage<T>(fn: (page: Page) => Promise<T>): Promise<T>;
}

/**
 * The URL the agent browser connects to. Docker: the gate on the computer's
 * address, at the gate's one path. A remote host's tunnel (`cdpHeaders` set):
 * exactly as given, since the host relays the path itself.
 */
export function cdpConnectUrl(ep: Pick<Endpoints, "cdpUrl" | "cdpHeaders">): string {
  if (ep.cdpHeaders) return ep.cdpUrl;
  const endpoint = new URL(ep.cdpUrl);
  endpoint.protocol = ["https:", "wss:"].includes(endpoint.protocol) ? "wss:" : "ws:";
  endpoint.pathname = "/devtools/browser";
  return endpoint.toString();
}

/**
 * The connection's headers: the gate's token always, and a remote host's
 * tunnel ticket when it has one. No subprotocol is offered either way (the
 * host selects none, and Playwright offers none).
 */
export function cdpConnectHeaders(ep: Pick<Endpoints, "cdpHeaders">, cdpToken: string): Record<string, string> {
  return { ...(ep.cdpHeaders ?? {}), "X-Juno-Cdp-Token": cdpToken };
}

/** Whether a browser can describe points (the runner holds it as a plain WorkBrowser). */
export function canDescribePoints(browser: unknown): browser is PointDescriber {
  const candidate = browser as Partial<PointDescriber> | null;
  return typeof candidate?.describePoint === "function" && typeof candidate?.describeFocus === "function";
}

/*
 * Runs inside the page. A string rather than a function on purpose: the runner
 * is executed through a transpiler that may wrap named functions in helpers
 * the page does not have, and a string is sent exactly as written.
 *
 * The point arrives in screen pixels. The page's own viewport starts below the
 * browser's toolbar and inside its border, so it is moved by the window's
 * position and chrome before `elementFromPoint`. Nothing reads a field's
 * value except a button's caption: a typed password must never become a name.
 */
export const DESCRIBE_TARGET_SCRIPT = String.raw`(function (arg) {
  if (typeof document.hasFocus === "function" && !document.hasFocus()) return null;
  if (document.visibilityState && document.visibilityState !== "visible") return null;
  var el = null;
  if (arg && typeof arg.x === "number" && typeof arg.y === "number") {
    var dpr = window.devicePixelRatio || 1;
    var side = Math.max(0, (window.outerWidth - window.innerWidth) / 2);
    var top = Math.max(0, window.outerHeight - window.innerHeight - side);
    var vx = arg.x / dpr - window.screenX - side;
    var vy = arg.y / dpr - window.screenY - top;
    if (vx < 0 || vy < 0 || vx >= window.innerWidth || vy >= window.innerHeight) return null;
    el = document.elementFromPoint(vx, vy);
  } else {
    el = document.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
  }
  if (!el) return null;
  var first = String(el.tagName || "").toLowerCase();
  if (first === "iframe" || first === "frame") return null;
  var target = (el.closest && el.closest('a[href],button,input,select,textarea,summary,label,[role],[contenteditable="true"]')) || el;
  var tag = String(target.tagName || "").toLowerCase();
  var type = String(target.getAttribute("type") || "").toLowerCase();
  var explicit = String(target.getAttribute("role") || "").toLowerCase().split(" ")[0];
  var buttonInput = tag === "input" && (type === "submit" || type === "button" || type === "reset" || type === "image");
  var role = explicit || (
    tag === "a" ? "link" :
    tag === "button" || tag === "summary" || buttonInput ? "button" :
    tag === "select" ? "combobox" :
    tag === "textarea" ? "textbox" :
    tag === "input" && type === "password" ? "password" :
    tag === "input" && (type === "checkbox" || type === "radio") ? type :
    tag === "input" && type === "search" ? "searchbox" :
    tag === "input" ? "textbox" :
    tag === "img" ? "img" :
    /^h[1-6]$/.test(tag) ? "heading" :
    target.isContentEditable ? "textbox" : "");
  var labelled = "";
  var ids = String(target.getAttribute("aria-labelledby") || "").split(/\s+/);
  for (var i = 0; i < ids.length && !labelled; i++) {
    var named = ids[i] ? document.getElementById(ids[i]) : null;
    if (named) labelled = String(named.textContent || "");
  }
  var fieldLabel = target.labels && target.labels.length ? String(target.labels[0].textContent || "") : "";
  // An editable region's text is what someone typed (a draft, a message), not
  // its name, so it is read no more than an input's value is.
  var field = tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable === true ||
    role === "textbox" || role === "searchbox";
  var text = field ? "" : String(target.innerText || target.textContent || "");
  var name = text.trim() || target.getAttribute("aria-label") || labelled.trim() || fieldLabel.trim() ||
    target.getAttribute("alt") || target.getAttribute("placeholder") || target.getAttribute("title") ||
    (buttonInput ? target.getAttribute("value") : "") || "";
  return { role: role, name: String(name).replace(/\s+/g, " ").trim().slice(0, 120), host: String(location.hostname || "") };
})`;

/** A page's answer, checked: the page is untrusted, so nothing is taken on faith. */
export function readPageTarget(raw: unknown): PageTarget | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { role, name, host } = raw as Record<string, unknown>;
  if (typeof role !== "string" || typeof name !== "string" || typeof host !== "string") return null;
  const cleanRole = role.toLowerCase().trim();
  if (cleanRole.length > 40 || !/^[a-z]*$/.test(cleanRole)) return null;
  const cleanHost = host.toLowerCase().trim();
  if (!/^[a-z0-9.-]{1,253}$/.test(cleanHost)) return null;
  return { role: cleanRole, name: name.slice(0, 200), host: cleanHost };
}

/**
 * Whether a page is a tab in a browser window. Chromium also exposes its own
 * WebUI as page targets: the address bar's suggestion popup
 * (chrome://omnibox-popup.top-chrome/, which Playwright reports as
 * chrome-error://chromewebdata/ and lists before the tabs). It has no window,
 * and an agent driving it acts on a page nobody sees (found on a real computer,
 * tests/computer-real-e2e.test.ts). A tab showing an error page still has one.
 */
export async function isBrowserTab(page: Page): Promise<boolean> {
  try {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Browser.getWindowForTarget");
      return true;
    } finally {
      await session.detach().catch(() => {});
    }
  } catch {
    return false;
  }
}

/** The first of `pages` that is a tab, in order; null when none is. */
export async function firstBrowserTab<P>(pages: readonly P[], isTab: (page: P) => Promise<boolean>): Promise<P | null> {
  for (const candidate of pages) {
    if (await isTab(candidate)) return candidate;
  }
  return null;
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
    // No Chromium behind the fake: every sentence falls back to coordinates.
    describePoint: async () => null,
    describeFocus: async () => null,
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
  /** True only while one of the agent's own actions runs (see navigationRefusal). */
  let agentActing = false;
  let navigationRefused: string | null = null;

  async function asAgent<T>(run: () => Promise<T>): Promise<T> {
    agentActing = true;
    navigationRefused = null;
    try {
      return await run();
    } finally {
      agentActing = false;
    }
  }

  async function ensurePage(): Promise<Page | string> {
    if (page && !page.isClosed()) return page;
    if (unavailable) return unavailable;
    if (!provider) {
      unavailable = "Agent computer provider is not configured.";
      return unavailable;
    }

    try {
      // A new connection asks for its endpoint again: a remote host's tunnel
      // ticket is single use, so a reconnect gets a fresh one.
      const ep = await provider.endpoints(handle, { purpose: "cdp" });
      const { chromium } = await import("playwright");
      browser = await chromium.connectOverCDP(cdpConnectUrl(ep), {
        headers: cdpConnectHeaders(ep, secrets.cdpToken),
        timeout: 15_000,
      });

      const existingContexts = browser.contexts();
      context = existingContexts[0] ?? (await browser.newContext());
      context.setDefaultNavigationTimeout(navigationTimeout);
      context.setDefaultTimeout(actionTimeout);
      // A tab the page opens becomes the agent's page; Chromium's own WebUI
      // pages (the address bar's suggestion popup) never do (isBrowserTab).
      context.on("page", (opened) => {
        void isBrowserTab(opened).then((tab) => {
          if (tab && !opened.isClosed()) page = opened;
        });
      });
      if (options?.navigationRefusal) {
        const policy = options.navigationRefusal;
        await context.route("**/*", async (route) => {
          const request = route.request();
          const refusal = agentNavigationVerdict({
            agentActing,
            isNavigation: request.isNavigationRequest(),
            isMainFrame: request.frame() === request.frame().page().mainFrame(),
            url: request.url(),
            policy,
          });
          if (refusal) {
            navigationRefused = refusal;
            await route.abort("blockedbyclient").catch(() => {});
            return;
          }
          await route.continue().catch(() => {});
        });
      }
      // The first real tab, not the first page target: Playwright lists
      // Chromium's omnibox popup WebUI before the tabs, and an agent that
      // drove it acted on a page nobody can see, under the person's live view.
      page =
        (await firstBrowserTab(context.pages().filter((candidate) => !candidate.isClosed()), isBrowserTab)) ??
        (await context.newPage());
      return page;
    } catch (error) {
      unavailable = `${PRODUCT_NAME} could not connect to the agent computer's browser: ${describeBrowserError(error)}`;
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
      const refusal = await asAgent(() => run(current));
      if (refusal) return { ok: false, message: refusal };
      if (navigationRefused) return { ok: false, message: navigationRefused };
      return { ok: true, page: await snapshot(page ?? current) };
    } catch (error) {
      return { ok: false, message: navigationRefused ?? describeBrowserError(error) };
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
        const response = await asAgent(() =>
          current.goto(url, {
            waitUntil: "domcontentloaded",
            timeout: navigationTimeout,
          }),
        );
        if (navigationRefused) return { ok: false, message: navigationRefused };
        const status = response?.status() ?? 0;
        if (status >= 400) {
          return { ok: false, message: `${url} answered ${status}.` };
        }
        return { ok: true, page: await snapshot(page ?? current) };
      } catch (error) {
        return { ok: false, message: navigationRefused ?? describeBrowserError(error) };
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
        const kind = await fieldKindOnPage(current, selector);
        if (kind === "password" || kind === "secret") return SECRET_FIELD_REFUSAL;
        await current.fill(selector, text, { timeout: actionTimeout });
        return null;
      });
    },

    async fieldKind(target) {
      const resolved = selectorForElement(elements, target);
      if ("refusal" in resolved || !page) return null;
      return fieldKindOnPage(page, resolved.selector);
    },

    fillSecret(target, value, opts) {
      const resolved = selectorForElement(elements, target);
      if ("refusal" in resolved) {
        return Promise.resolve({ ok: false, message: resolved.refusal });
      }
      const selector = resolved.selector;
      return act(async (current) => {
        const kind = await fieldKindOnPage(current, selector);
        if (opts.requirePasswordField ? kind !== "password" : kind !== "text" && kind !== "password") {
          return "That field is not one a saved credential can be filled into.";
        }
        await current.fill(selector, value, { timeout: actionTimeout });
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

    describePoint(x: number, y: number) {
      return describeInFront({ x, y });
    },

    describeFocus() {
      return describeInFront(null);
    },

    close,
  };

  /**
   * Asks each open tab; only the one that is visible and focused answers
   * (the script returns null everywhere else). Never connects just to look:
   * a run that has not used the browser yet gets coordinates.
   */
  async function describeInFront(point: { x: number; y: number } | null): Promise<PageTarget | null> {
    const pages = context ? context.pages().filter((candidate) => !candidate.isClosed()) : [];
    const ordered = page && !page.isClosed() ? [page, ...pages.filter((candidate) => candidate !== page)] : pages;
    return describeAcrossPages(ordered, point);
  }
}

/** The slice of a Playwright page `describeAcrossPages` uses. */
export interface DescribablePage {
  isClosed(): boolean;
  url(): string;
  evaluate(expression: string): Promise<unknown>;
}

/** An http(s) URL's hostname, lowercased, or null for anything else (about:blank, chrome://, data:). */
function trustedHost(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    const host = url.hostname.toLowerCase();
    return /^[a-z0-9.-]{1,253}$/.test(host) ? host : null;
  } catch {
    return null;
  }
}

/**
 * Asks each tab in turn (the agent's own first); the first one that answers
 * names the target.
 *
 * The script runs in the page's own JavaScript world, so the page can answer
 * whatever it likes: a page that replaces `String` or `document.hasFocus` can
 * report any host. The role and name are page content whatever happens (the
 * marked screenshot beside them is the ground truth). The site is not: an
 * approval reading "on accounts.google.com" while the agent is on another
 * site is the sentence a hostile page would most want to write. So the host
 * always comes from the browser's own record of the tab's address, never from
 * the page, and a tab with no web address gives no description at all.
 */
export async function describeAcrossPages(
  pages: readonly DescribablePage[],
  point: { x: number; y: number } | null,
): Promise<PageTarget | null> {
  const expression = `${DESCRIBE_TARGET_SCRIPT}(${JSON.stringify(point)})`;
  for (const candidate of pages.slice(0, 8)) {
    try {
      if (candidate.isClosed()) continue;
      const host = trustedHost(candidate.url());
      if (!host) continue;
      const answer = readPageTarget(await candidate.evaluate(expression));
      if (answer) return { ...answer, host };
    } catch {
      // A tab mid-navigation has no document to ask; the next one might.
    }
  }
  return null;
}
