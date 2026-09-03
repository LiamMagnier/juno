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
  | { ok: false; failure: { reason: string; detail?: string } };

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_CHARS = 16_000;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 JunoResearch/2.0";

/**
 * Heuristic check to detect whether a page's initial HTML is a client-side rendered SPA shell.
 */
export function isPotentialSpa(html: string, textLength: number): boolean {
  if (textLength < 150) return true;

  const spaPatterns = [
    /<div[^>]+id=["'](?:root|app|__next)["'][^>]*>\s*<\/div>/i,
    /<div[^>]+id=["'](?:root|app|__next)["'][^>]*\/>/i,
    /<div[^>]+id=["'](?:root|app)["'][^>]*><\/div>/i,
    /enable javascript/i,
    /javascript is required/i,
    /requires javascript/i,
    /<noscript>[\s\S]*?javascript[\s\S]*?<\/noscript>/i,
  ];

  for (const pattern of spaPatterns) {
    if (pattern.test(html)) return true;
  }

  return false;
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

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  let browser: Browser | undefined;

  try {
    const { chromium } = await import("@playwright/test");

    browser = await chromium.launch({
      headless: true,
      args: [
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-gpu",
      ],
    });

    const context = await browser.newContext({
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      viewport: { width: 1280, height: 800 },
      javaScriptEnabled: true,
    });

    const page = await context.newPage();

    // Abort abortable signals
    if (options.signal) {
      if (options.signal.aborted) {
        await browser.close();
        return { ok: false, failure: { reason: "aborted" } };
      }
      options.signal.addEventListener("abort", () => {
        page.close().catch(() => {});
        context.close().catch(() => {});
        browser.close().catch(() => {});
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

/**
 * High-level Deep Research crawler:
 * 1. Executes fast HTTP extraction first.
 * 2. If the page is an SPA, empty, or blocked by JS requirement, falls back to headless Playwright Chromium.
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

  if (fastOutcome.ok) {
    const textLen = fastOutcome.page.text.length;
    // If we extracted substantial text, return fast result immediately
    if (textLen >= 250) {
      return {
        ok: true,
        page: {
          title: fastOutcome.page.title,
          text: fastOutcome.page.text,
          links: fastOutcome.page.links,
          author: fastOutcome.page.author,
          publishedAt: fastOutcome.page.publishedAt,
          isSpa: false,
          crawler: "http_fast",
        },
      };
    }
  }

  // If fast extraction was empty or failed, attempt headless browser fallback
  const isLikelySpa = !fastOutcome.ok && (
    fastOutcome.failure.reason === "empty_document" ||
    fastOutcome.failure.reason === "fetch_failed"
  );

  if (isLikelySpa || !fastOutcome.ok) {
    const headlessOutcome = await renderHeadlessPage(url, options);
    if (headlessOutcome.ok) {
      return headlessOutcome;
    }
  }

  // Return original fast outcome or failure if headless also failed
  if (fastOutcome.ok) {
    return {
      ok: true,
      page: {
        title: fastOutcome.page.title,
        text: fastOutcome.page.text,
        links: fastOutcome.page.links,
        author: fastOutcome.page.author,
        publishedAt: fastOutcome.page.publishedAt,
        isSpa: false,
        crawler: "http_fast",
      },
    };
  }

  return {
    ok: false,
    failure: fastOutcome.failure,
  };
}
