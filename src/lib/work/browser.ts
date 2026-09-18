/**
 * The browser a cloud Work run drives, and the leash it is on.
 *
 * `browserTool` in the vendored runtime says what a browser IS to a Work run —
 * its rung on the lattice, the risk of each action, the provenance of what it
 * returns. This is the process behind it, and it lives here rather than there
 * for the reason every other effect does: `runner/agent-core` is built with
 * this repository absent and cannot depend on a browser driver.
 *
 * THE LEASH
 *
 * Chromium makes no network requests of its own. Every request the page makes —
 * the document, its scripts, its XHRs, the POST a form submits — is intercepted
 * and handed to `fetchResource`, which the executor implements with the same
 * DNS-pinned, address-checked fetch `web_fetch` uses, and the response is
 * fulfilled back into the page. The browser's own network stack is never
 * reached.
 *
 * That is not belt-and-braces, it is the only version of this that is safe. The
 * lexical URL check `blockedFetchTarget` performs is explicitly "not a DNS
 * containment boundary" — its own docblock says so — and a browser is the one
 * client where that gap is not theoretical: a hostile page can hold a name that
 * resolves public at check time and to the link-local metadata endpoint a
 * moment later, read the answer with a script, and post it to its own origin
 * without a single line of it passing through the model or the transcript.
 * Intercept-and-fulfil closes that by construction, because there is no socket
 * for a second resolution to affect, and it costs one function seam.
 *
 * WHAT IS STILL TRUE
 *
 * The page's scripts run, and they run against whatever the run has in this
 * browser: cookies set by pages this run visited. That is the capability, not a
 * defect — a site with a search box is the case the tool exists for — and the
 * containment around it is that the browser holds no Juno credential, that
 * everything it returns is marked untrusted and enveloped before the model
 * reads it, and that nothing it reaches is a Juno host.
 *
 * Those cookies live exactly as long as the process. The executor closes the
 * browser when the run ends OR pauses, because a paused run resumes on
 * whichever worker is free and a browser held open for it would be a session
 * nobody is watching on a machine the run may never come back to. A run that
 * signs into something and then stops for a question signs in again afterwards.
 */

import type { Browser, BrowserContext, Page, Route } from "playwright";

/*
 * The three shapes below mirror `BrowserElement`, `BrowserPageState` and
 * `BrowserOutcome` in runner/agent-core/src/work/tools.ts, and are declared
 * here rather than imported for the reason work/types.ts gives for its own
 * copies: the runner is a standalone package built with this repository
 * absent, and a relative import into it would resolve in this checkout and
 * nowhere the package is actually consumed.
 *
 * What polices the copy is tests/work-browser.test.ts, which builds the tool
 * out of this driver: it imports the runtime from source rather than from the
 * built `dist/` the executor deep-imports, so the compiler has both shapes in
 * scope there and a drifted field is a type error. The executor itself cannot
 * do that job — its `WorkRuntime` is a `typeof import` of a directory that does
 * not exist until the package is built, so everything it reaches through
 * `runtime.` is `any` to the web app's compiler.
 */

/** One thing on the page a call can address, as the snapshot numbered it. */
export interface BrowserElement {
  ref: number;
  role: string;
  label: string;
  href?: string;
  submits?: boolean;
}

export interface BrowserPageState {
  url: string;
  title: string;
  html: string;
  elements: BrowserElement[];
}

export type BrowserOutcome =
  | { ok: true; page: BrowserPageState }
  | { ok: false; message: string };

/** One request the page wants to make, as the executor has to satisfy it. */
export interface BrowserResourceRequest {
  url: string;
  method: string;
  /** The browser's own headers, minus the ones the transport owns. */
  headers: Record<string, string>;
  body: Buffer | null;
  /** True for the request that becomes the page itself. */
  isNavigation: boolean;
}

export type BrowserResourceResult =
  | {
      ok: true;
      status: number;
      /**
       * Response headers, as Chromium should see them.
       *
       * One string per name: a header that legitimately repeats — `set-cookie`
       * above all — is joined with a newline, which is how Playwright's fulfil
       * takes multiples. Content-Encoding and Content-Length are the caller's
       * to drop, since the body handed over here is already decoded.
       */
      headers: Record<string, string>;
      body: Buffer;
    }
  | { ok: false; message: string };

export interface WorkBrowserOptions {
  fetchResource(request: BrowserResourceRequest): Promise<BrowserResourceResult>;
  /**
   * Where Chromium is, when the deployment pins it rather than letting
   * Playwright resolve its own download. A worker image that ships a browser
   * under a path of its own is the common case in production.
   */
  executablePath?: string;
  navigationTimeoutMs?: number;
  actionTimeoutMs?: number;
  log?(message: string, extra?: Record<string, unknown>): void;
}

export interface WorkBrowser {
  available(): boolean;
  open(url: string): Promise<BrowserOutcome>;
  read(): Promise<BrowserOutcome>;
  click(target: { ref?: number; selector?: string }): Promise<BrowserOutcome>;
  typeText(target: { ref?: number; selector?: string }, text: string): Promise<BrowserOutcome>;
  submit(target: { ref?: number; selector?: string }): Promise<BrowserOutcome>;
  currentUrl(): string;
  close(): Promise<void>;
}

const DEFAULT_NAVIGATION_TIMEOUT_MS = 25_000;
const DEFAULT_ACTION_TIMEOUT_MS = 10_000;

/** How many interactive elements one snapshot names. Mirrors the tool's cap. */
const MAX_ELEMENTS = 60;

/**
 * Headers the transport owns, which must not be forwarded from the page.
 *
 * `host` is set from the URL by the pinned fetcher and a forwarded one would
 * contradict it; `accept-encoding` is forced to identity because the body is
 * handed to Chromium already decoded; the rest are hop-by-hop.
 */
const TRANSPORT_HEADERS = new Set([
  "host",
  "accept-encoding",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
]);

/**
 * Resource kinds fetched only to be looked at.
 *
 * Dropped rather than fetched: a Work run reads pages as text, so every image
 * is a round trip through the executor's fetcher for bytes nothing will ever
 * read. Stylesheets and scripts are kept, because an element that a stylesheet
 * hides is one the snapshot must not offer and a page that renders through its
 * scripts is the reason this tool exists.
 */
const IGNORED_RESOURCE_TYPES = new Set(["image", "media", "font"]);

/**
 * Requests one action may cause before the page is cut off.
 *
 * Every request the page makes is a real outbound fetch from the worker, made
 * because a page asked for it rather than because the model did. Without a
 * ceiling, one `open` of a hostile page is an amplifier: a loop in its script
 * turns a single tool call into thousands of requests from Juno's address, and
 * the only thing that would eventually stop it is the run's own clock. A
 * hundred and fifty is far past what a document needs once images, fonts and
 * media are already dropped, and the counter resets for each action so a long
 * browsing session is not the thing that hits it.
 */
const MAX_REQUESTS_PER_ACTION = 150;

export function createWorkBrowser(options: WorkBrowserOptions): WorkBrowser {
  const navigationTimeout = options.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS;
  const actionTimeout = options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;

  let browser: Browser | null = null;
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  /** Set once a launch has failed; the tool reports itself unhealthy from then. */
  let unavailable: string | null = null;
  /** The last snapshot's elements, which is what a `ref` addresses. */
  let elements: BrowserElement[] = [];
  /** Why the last document request did not arrive, when it did not. */
  let navigationFailure: string | null = null;
  /** Requests caused by the action in flight. See `MAX_REQUESTS_PER_ACTION`. */
  let requests = 0;

  async function handleRoute(route: Route): Promise<void> {
    const request = route.request();
    try {
      if (IGNORED_RESOURCE_TYPES.has(request.resourceType())) {
        await route.abort("blockedbyclient");
        return;
      }

      requests += 1;
      if (requests > MAX_REQUESTS_PER_ACTION) {
        if (requests === MAX_REQUESTS_PER_ACTION + 1) {
          options.log?.("work browser cut off a page asking for too much", {
            url: request.url(),
            limit: MAX_REQUESTS_PER_ACTION,
          });
        }
        if (request.isNavigationRequest()) {
          navigationFailure = `That page asked for more than ${MAX_REQUESTS_PER_ACTION} resources, so Juno stopped loading it.`;
        }
        await route.abort("blockedbyclient");
        return;
      }

      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(request.headers())) {
        if (!TRANSPORT_HEADERS.has(name.toLowerCase())) headers[name] = value;
      }

      const isNavigation = request.isNavigationRequest();
      const result = await options.fetchResource({
        url: request.url(),
        method: request.method(),
        headers,
        body: request.postDataBuffer(),
        isNavigation,
      });

      if (!result.ok) {
        if (isNavigation) navigationFailure = result.message;
        // Fulfilled rather than aborted so the failure is a page with the
        // reason written on it. An aborted navigation surfaces as Chromium's
        // own net::ERR_FAILED, which names nothing a person or a model can act
        // on.
        await route.fulfill({
          status: 502,
          headers: { "content-type": "text/plain; charset=utf-8" },
          body: result.message,
        });
        return;
      }

      await route.fulfill({ status: result.status, headers: result.headers, body: result.body });
    } catch (error) {
      // A page closed mid-flight leaves routes in the air; failing to answer
      // one hangs the navigation that is already over.
      options.log?.("work browser could not answer a request", {
        url: request.url(),
        error: String(error),
      });
      await route.abort("failed").catch(() => {});
    }
  }

  async function ensurePage(): Promise<Page | string> {
    if (page) return page;
    if (unavailable) return unavailable;
    try {
      const { chromium } = await import("playwright");
      browser = await chromium.launch({
        headless: true,
        // `--no-sandbox` because the worker is already the isolation boundary
        // and a container without user namespaces cannot start the sandbox at
        // all; `--disable-dev-shm-usage` because the default /dev/shm in a
        // container is 64MB and Chromium crashes on a large page without it.
        args: ["--no-sandbox", "--disable-dev-shm-usage"],
        ...(options.executablePath ? { executablePath: options.executablePath } : {}),
      });
      context = await browser.newContext({
        acceptDownloads: false,
        // A service worker would answer requests from its own cache after the
        // interception was installed, which is a request nothing checked.
        serviceWorkers: "block",
      });
      context.setDefaultNavigationTimeout(navigationTimeout);
      context.setDefaultTimeout(actionTimeout);
      await context.route("**/*", handleRoute);
      // A link with target="_blank" opens a page this driver did not create,
      // and without this the next snapshot would be of the page the model has
      // just navigated away from — it would read the same document twice and
      // conclude the click did nothing. Following the newest page is what a
      // person watching the window would see.
      context.on("page", (opened) => {
        page = opened;
      });
      page = await context.newPage();
      return page;
    } catch (error) {
      unavailable = `Juno could not start a browser on this deployment: ${
        error instanceof Error ? error.message : String(error)
      }`;
      options.log?.("work browser unavailable", { error: unavailable });
      await close();
      return unavailable;
    }
  }

  /**
   * The page as it now is, with its interactive elements numbered.
   *
   * The numbering is written into the DOM as `data-juno-ref`, so a later click
   * addresses the element the model was actually shown rather than the nth
   * match of a selector on a page that has since changed under it.
   */
  async function snapshot(current: Page): Promise<BrowserPageState> {
    await current.waitForLoadState("domcontentloaded", { timeout: navigationTimeout }).catch(() => {});
    const collected = (await current.evaluate((max: number) => {
      const selector =
        'a[href], button, input, textarea, select, [role="button"], [role="link"], [contenteditable="true"]';
      const found: Array<{
        ref: number;
        role: string;
        label: string;
        href?: string;
        submits?: boolean;
      }> = [];
      let ref = 0;
      for (const node of Array.from(document.querySelectorAll(selector))) {
        if (found.length >= max) break;
        const element = node as HTMLElement;
        const rect = element.getBoundingClientRect();
        const style = window.getComputedStyle(element);
        const visible =
          rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
        if (!visible) continue;

        const tag = element.tagName.toLowerCase();
        const type = (element.getAttribute("type") ?? "").toLowerCase();
        const role =
          tag === "a"
            ? "link"
            : tag === "button" || type === "submit" || type === "button"
              ? "button"
              : tag === "select"
                ? "dropdown"
                : tag === "input" && (type === "checkbox" || type === "radio")
                  ? type
                  : "textbox";
        const label =
          (element.innerText || "").trim() ||
          element.getAttribute("aria-label") ||
          element.getAttribute("placeholder") ||
          element.getAttribute("name") ||
          element.getAttribute("value") ||
          element.getAttribute("title") ||
          "";
        const submits =
          Boolean(element.closest("form")) &&
          ((tag === "button" && (type === "" || type === "submit")) ||
            (tag === "input" && (type === "submit" || type === "image")));

        ref += 1;
        element.setAttribute("data-juno-ref", String(ref));
        found.push({
          ref,
          role,
          label: label.replace(/\s+/g, " ").slice(0, 80),
          ...(tag === "a" ? { href: element.getAttribute("href") ?? "" } : {}),
          ...(submits ? { submits: true } : {}),
        });
      }
      return found;
    }, MAX_ELEMENTS)) as BrowserElement[];

    elements = collected;
    return {
      url: current.url(),
      title: await current.title().catch(() => ""),
      html: await current.content(),
      elements: collected,
    };
  }

  /** The selector a target names, or the sentence saying why it names none. */
  function selectorFor(
    target: { ref?: number; selector?: string },
  ): { selector: string } | { refusal: string } {
    if (typeof target.ref === "number") {
      const known = elements.some((element) => element.ref === target.ref);
      if (!known) {
        return {
          refusal: `There is nothing numbered ${target.ref} on the page you last read. Read the page again and use a number from that list.`,
        };
      }
      return { selector: `[data-juno-ref="${target.ref}"]` };
    }
    if (target.selector) return { selector: target.selector };
    return { refusal: "A ref or a selector is required." };
  }

  /** Whether pressing this element would send the form it is in. */
  async function submitsForm(current: Page, selector: string): Promise<boolean> {
    return current
      .$eval(selector, (node) => {
        const element = node as HTMLElement;
        if (!element.closest("form")) return false;
        const tag = element.tagName.toLowerCase();
        const type = (element.getAttribute("type") ?? "").toLowerCase();
        return (
          (tag === "button" && (type === "" || type === "submit")) ||
          (tag === "input" && (type === "submit" || type === "image"))
        );
      })
      .catch(() => false);
  }

  /**
   * Runs one interaction and returns the page it left behind.
   *
   * Every action re-snapshots, because every one of them can navigate and a
   * model told "clicked" with no page after it will address the old numbering
   * against the new document.
   */
  async function act(
    run: (current: Page) => Promise<string | null>,
  ): Promise<BrowserOutcome> {
    const current = await ensurePage();
    if (typeof current === "string") return { ok: false, message: current };
    if (!current.url() || current.url() === "about:blank") {
      return { ok: false, message: "Nothing is open yet. Open a URL first." };
    }
    navigationFailure = null;
    requests = 0;
    try {
      const refusal = await run(current);
      if (refusal) return { ok: false, message: refusal };
      // A click can navigate, and a navigation the fetcher refused leaves a
      // page whose whole body is the refusal. Reporting that as a successful
      // read would hand the model a sentence about Juno's own network policy
      // to summarise as though it were the site's content.
      if (navigationFailure) return { ok: false, message: navigationFailure };
      // `page` and not `current`: the action may have opened a new tab, and the
      // page in front is the one to report.
      return { ok: true, page: await snapshot(page ?? current) };
    } catch (error) {
      return { ok: false, message: navigationFailure ?? describe(error) };
    }
  }

  async function close(): Promise<void> {
    const closing = [page, context, browser];
    page = null;
    context = null;
    browser = null;
    elements = [];
    for (const handle of closing) {
      await handle?.close().catch(() => {});
    }
  }

  return {
    available: () => unavailable === null,
    currentUrl: () => {
      const url = page?.url() ?? "";
      return url === "about:blank" ? "" : url;
    },

    async open(url) {
      const current = await ensurePage();
      if (typeof current === "string") return { ok: false, message: current };
      navigationFailure = null;
      requests = 0;
      try {
        const response = await current.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: navigationTimeout,
        });
        if (navigationFailure) return { ok: false, message: navigationFailure };
        const status = response?.status() ?? 0;
        if (status >= 400) {
          return { ok: false, message: `${url} answered ${status}.` };
        }
        // As in `act`: a page that opens another on load leaves the newest one
        // in front, and that is the one the model is about to act on.
        return { ok: true, page: await snapshot(page ?? current) };
      } catch (error) {
        return { ok: false, message: navigationFailure ?? describe(error) };
      }
    },

    read() {
      return act(() => Promise.resolve(null));
    },

    click(target) {
      const resolved = selectorFor(target);
      if ("refusal" in resolved) return Promise.resolve({ ok: false, message: resolved.refusal });
      const selector = resolved.selector;
      return act(async (current) => {
        if (await submitsForm(current, selector)) {
          // The structural half of the approval ladder: reaching `command` is
          // not a matter of the model describing its own click honestly.
          return 'That control sends the form it is in, so it is not a click. Use action "submit" instead — the user is asked before a form is sent.';
        }
        await current.click(selector, { timeout: actionTimeout });
        return null;
      });
    },

    typeText(target, text) {
      const resolved = selectorFor(target);
      if ("refusal" in resolved) return Promise.resolve({ ok: false, message: resolved.refusal });
      const selector = resolved.selector;
      return act(async (current) => {
        await current.fill(selector, text, { timeout: actionTimeout });
        return null;
      });
    },

    submit(target) {
      const resolved = selectorFor(target);
      if ("refusal" in resolved) return Promise.resolve({ ok: false, message: resolved.refusal });
      const selector = resolved.selector;
      return act(async (current) => {
        // A form is sent either by pressing its button or by pressing Enter in
        // one of its fields, and the model should not have to know which shape
        // this particular form is.
        const field = await current
          .$eval(selector, (node) => ["input", "textarea"].includes(node.tagName.toLowerCase()))
          .catch(() => false);
        if (field) await current.press(selector, "Enter", { timeout: actionTimeout });
        else await current.click(selector, { timeout: actionTimeout });
        await current.waitForLoadState("load", { timeout: navigationTimeout }).catch(() => {});
        return null;
      });
    },

    close,
  };
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Playwright's timeouts are a paragraph with a call log in them; the first
  // line is the sentence, and the rest is for a developer with the page in
  // front of them.
  return message.split("\n")[0] ?? message;
}
