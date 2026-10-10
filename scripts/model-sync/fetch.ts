import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Fetching official pages, with two switches that make a run reproducible:
 *
 *   --save-pages DIR   keep every page read, so a report can be re-derived
 *   --pages DIR        read pages from DIR instead of the network (tests,
 *                      re-running a report, reviewing a parser change)
 *
 * A page file is named after its URL, so the same directory serves both.
 */
export interface PageStore {
  get(url: string): Promise<string>;
}

const TIMEOUT_MS = 30_000;
const UA = "alevr-models-sync/1.0 (+https://alevr.com; catalogue accuracy check)";

export function pageFileName(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 200);
}

export function pageStore(opts: { readDir?: string; saveDir?: string } = {}): PageStore {
  const cache = new Map<string, Promise<string>>();
  return {
    get(url) {
      const hit = cache.get(url);
      if (hit) return hit;
      const p = (async () => {
        if (opts.readDir) {
          const file = join(opts.readDir, pageFileName(url));
          if (!existsSync(file)) throw new Error(`no saved page for ${url} (${file})`);
          return readFileSync(file, "utf8");
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": UA } }); // no Accept: docs.x.ai 404s a negotiated one
          if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
          const text = await res.text();
          if (opts.saveDir) {
            mkdirSync(opts.saveDir, { recursive: true });
            writeFileSync(join(opts.saveDir, pageFileName(url)), text);
          }
          return text;
        } finally {
          clearTimeout(timer);
        }
      })();
      cache.set(url, p);
      return p;
    },
  };
}

/** GET JSON with a header (lab model-list APIs). Never logs the header. */
export async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { "user-agent": UA, ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
