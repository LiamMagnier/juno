/**
 * Deep Research Headless Browser Crawler Pipeline
 *
 * Provides resilient web scraping for Deep Research, combining ultra-fast
 * HTTP/Readability extraction with an automated headless Playwright Chromium fallback
 * for JavaScript-rendered Single-Page Applications (React, Vue, Angular, Next.js).
 */

import type { ExtractOutcome, ExtractResult } from "@/lib/search/search-engine";
import { isDisallowedHost } from "@/lib/search/url-safety";
import type { Browser, Route } from "@playwright/test";

// The shell heuristic lives with the other page signals now, where the
// extractor — the only code holding the raw HTML — can import it too; it is
// re-exported here so the crawler's own tests and callers keep their import.
export { isPotentialSpa } from "@/lib/search/page-signals";

export interface CrawlerOptions {
  signal?: AbortSignal;
  maxChars?: number;
  timeoutMs?: number;
  forceHeadless?: boolean;
  waitForSelector?: string;
  userAgent?: string;
}

export interface CrawledPage extends ExtractResult {
  isSpa: boolean;
  crawler: "http_fast" | "headless_playwright";
}

export type CrawlResult =
  | { ok: true; page: CrawledPage }
  /** The extractor's failure, with the status and the server's `Retry-After` when it was an HTTP refusal. */
  | { ok: false; failure: { reason: string; detail?: string; httpStatus?: number; retryAfterMs?: number } };

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CHARS = 16_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 JunoResearch/2.0";
/**
 * Below this many characters a successful fast fetch is not trusted as the
 * page. The extractor accepts anything over fifty, so a "please enable
 * JavaScript" notice of sixty characters used to come back `ok` and be stored
 * as the document; only a fetch that FAILED ever reached the headless path.
 */
const MIN_FAST_TEXT_CHARS = 250;

/**
 * Whether the fast fetch's outcome is worth a headless render.
 *
 * Three cases, and the second is the one that was missing: the fetch failed
 * outright; the fetch succeeded but yielded a shell — too little text, or
 * markup the extractor recognised as a client-rendered root; or the fetch
 * succeeded with a real document, in which case a browser would only cost
 * time. Pure, because it is the decision the whole fallback hinges on and the
 * crawler itself needs the network to run.
 */
export function shouldRenderHeadless(fast: ExtractOutcome): boolean {
  if (!fast.ok) return true;
  return fast.page.text.length < MIN_FAST_TEXT_CHARS || fast.page.shell === true;
}

/**
 * The headless renderer is opt-in per deployment.
 *
 * `@playwright/test` is a development dependency and nothing installs a
 * browser into the production image, so on an ordinary `next start` the
 * dynamic import below throws and every attempt returns
 * `headless_render_failed` — after paying an import and a launch attempt per
 * page. A deployment that has installed a browser says so with
 * `RESEARCH_HEADLESS=1`; everybody else keeps the fast path and a named skip.
 */
export function headlessRenderingEnabled(): boolean {
  const raw = process.env.RESEARCH_HEADLESS?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/**
 * Why this process cannot render headlessly, once it has found out.
 *
 * A missing module or a missing browser binary is a fact about the deployment,
 * not about the page, so it is learned once and every later call answers from
 * memory rather than importing and launching again. A transient launch error
 * is not cached: that one may well succeed for the next page.
 */
let headlessUnavailable: string | null = null;

function browserIsMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  // The wording is the launcher's own for a browser that was never
  // installed. Deliberately not the generic launch prefix, which a transient
  // failure carries too and which would switch the renderer off for good.
  return /executable doesn't exist|Cannot find module|MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND/i.test(message);
}

/**
 * Renders a web page using a headless Playwright Chromium instance
 * with resource blocking (images, media, fonts) for minimal latency and memory usage.
 */
export async function renderHeadlessPage(
  url: string,
  options: CrawlerOptions = {}
): Promise<CrawlResult> {
  if (!url || (!url.startsWith("data:") && isDisallowedHost(url))) {
    return { ok: false, failure: { reason: "blocked_host" } };
  }
  if (headlessUnavailable) {
    return { ok: false, failure: { reason: "headless_render_failed", detail: headlessUnavailable } };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  let browser: Browser | undefined;

  try {
    let chromium: (typeof import("@playwright/test"))["chromium"];
    try {
      ({ chromium } = await import("@playwright/test"));
    } catch (error) {
      headlessUnavailable = "the headless browser package is not installed in this build";
      throw error;
    }

    try {
      browser = await chromium.launch({
        headless: true,
        args: [
          "--disable-dev-shm-usage",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-gpu",
        ],
      });
    } catch (error) {
      if (browserIsMissing(error)) headlessUnavailable = "no headless browser binary is installed in this build";
      throw error;
    }

    // Keep a narrowed reference for the abort callback; `browser` is also
    // owned by the outer finally block and is intentionally optional there.
    const activeBrowser = browser;

    const context = await activeBrowser.newContext({
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      viewport: { width: 1280, height: 800 },
      javaScriptEnabled: true,
    });

    const page = await context.newPage();

    // Abort abortable signals
    if (options.signal) {
      if (options.signal.aborted) {
        await activeBrowser.close();
        return { ok: false, failure: { reason: "aborted" } };
      }
      options.signal.addEventListener("abort", () => {
        page.close().catch(() => {});
        context.close().catch(() => {});
        activeBrowser.close().catch(() => {});
      });
    }

    // Block images, fonts, and heavy media to maximize scrape performance
    await page.route("**/*", (route: Route) => {
      const type = route.request().resourceType();
      if (["image", "media", "font", "imageset"].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });

      if (options.waitForSelector) {
        await page.waitForSelector(options.waitForSelector, {
          timeout: Math.min(5000, timeoutMs),
        }).catch(() => {});
      } else {
        // Wait briefly for hydration (up to 1500ms)
        await page.waitForTimeout(800);
      }

      const title = await page.title();

      // Extract rendered text content and discovered links directly from DOM
      const { text, links } = await page.evaluate(() => {
        // Remove script, style, noscript elements before extracting text
        const toRemove = document.querySelectorAll("script, style, noscript, svg, nav, footer, header");
        toRemove.forEach((el) => el.remove());

        const mainEl = document.querySelector("article, main, [role='main']") || document.body;
        const innerText = mainEl ? (mainEl as HTMLElement).innerText || mainEl.textContent || "" : "";

        // Collect visible hyperlinks
        const anchors = Array.from(document.querySelectorAll("a[href]"));
        const links: Array<{ href: string; text: string }> = [];
        const seen = new Set<string>();

        for (const a of anchors) {
          const href = (a as HTMLAnchorElement).href;
          if ((href.startsWith("http://") || href.startsWith("https://")) && !seen.has(href)) {
            seen.add(href);
            links.push({
              href,
              text: (a.textContent || "").trim().slice(0, 100),
            });
            if (links.length >= 30) break;
          }
        }

        return {
          text: innerText,
          links,
        };
      });

      await context.close();
      await browser.close();

      const cleanText = text.replace(/\s+/g, " ").trim();

      if (!cleanText || cleanText.length < 50) {
        return { ok: false, failure: { reason: "empty_document", detail: "Rendered page contained insufficient text" } };
      }

      return {
        ok: true,
        page: {
          title: title || url,
          text: cleanText.slice(0, maxChars),
          links,
          author: undefined,
          publishedAt: undefined,
          isSpa: true,
          crawler: "headless_playwright",
        },
      };
    } catch (pageErr) {
      await context.close().catch(() => {});
      throw pageErr;
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      failure: {
        reason: "headless_render_failed",
        detail,
      },
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

function fastPage(page: ExtractResult): CrawlResult {
  return {
    ok: true,
    page: {
      title: page.title,
      text: page.text,
      links: page.links,
      author: page.author,
      publishedAt: page.publishedAt,
      isSpa: false,
      crawler: "http_fast",
    },
  };
}

/**
 * High-level Deep Research crawler:
 * 1. Executes fast HTTP extraction first.
 * 2. When that failed or produced a client-rendered shell, and this
 *    deployment has opted into a browser, renders the page headlessly.
 * 3. Otherwise returns the fast result as it was — a shell included, because
 *    a few sentences of navigation beats nothing and the run's ranking will
 *    keep it near the bottom.
 */
export async function crawlResearchPage(
  url: string,
  options: CrawlerOptions = {}
): Promise<CrawlResult> {
  if (!url || (!url.startsWith("data:") && isDisallowedHost(url))) {
    return { ok: false, failure: { reason: "blocked_host" } };
  }

  if (options.forceHeadless) {
    return await renderHeadlessPage(url, options);
  }

  // Fast HTTP extraction
  const { extractUrlDocument } = await import("@/lib/search/search-engine");
  const fastOutcome: ExtractOutcome = await extractUrlDocument(url, options.signal, {
    maxChars: options.maxChars,
  });

  if (shouldRenderHeadless(fastOutcome) && headlessRenderingEnabled()) {
    const headlessOutcome = await renderHeadlessPage(url, options);
    if (headlessOutcome.ok) return headlessOutcome;
  }

  if (fastOutcome.ok) return fastPage(fastOutcome.page);
  return { ok: false, failure: fastOutcome.failure };
}
