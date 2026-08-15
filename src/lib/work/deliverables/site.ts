/**
 * Typed site specs -> a static bundle that is safe to preview.
 *
 * THE SANDBOX ARGUMENT, written out because it is the whole design:
 *
 * A preview that executes arbitrary authored script in the app origin is the
 * same as having no sandbox at all. Juno's session cookie, its API surface and
 * every other tab's same-origin data are reachable from one line of script
 * running on juno's origin, so a "preview" that renders an agent-authored page
 * there is not a weaker sandbox than an iframe — it is an XSS primitive with a
 * Preview button on it, and it is reachable by anything that can influence what
 * the agent writes. A Work run reads web pages, connector records and files;
 * every one of those is untrusted input, and prompt injection turning into
 * script in the app origin is the shortest path from "read a hostile web page"
 * to "read the user's account".
 *
 * Two independent things are therefore true of every bundle produced here:
 *
 *  1. There is no authored script to execute. Pages are generated from the same
 *     typed blocks a report uses, and every string goes through `escapeHtml`.
 *     The spec has no field that carries markup, so `<script>` in a heading is
 *     the six characters `&lt;script&gt;` in the output, not an element.
 *  2. There is no remote subresource. No CDN script, no web font, no external
 *     stylesheet, no third-party iframe. The bundle renders identically with
 *     the network off, and it cannot report to anyone that it was opened.
 *
 * `validate.ts` re-opens the finished zip and scans every page for exactly
 * those violations, so the guarantee is checked against the bytes that were
 * produced rather than asserted about the code that produced them. And the
 * previewer that renders these bundles — `src/components/work/work-site-preview.tsx`
 * — still puts them in an opaque-origin iframe with no `allow-same-origin`, the
 * way `src/components/canvas/sandbox-frame.tsx` does: this file removes the
 * reason to trust the content, not the reason to isolate it. That previewer goes
 * one further than an iframe and serves the page under a nonce CSP, so a
 * `<script>` that both guarantees above failed to prevent would still not run.
 */

import JSZip from "jszip";
import { z } from "zod";
import { documentBlockSchema, type DocumentBlock } from "@/lib/work/deliverables/document";
import { escapeHtml, renderBlocksHtml } from "@/lib/work/deliverables/report";
import { assertSafeBundlePath, DeliverableError } from "@/lib/work/deliverables/validate";

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

const MAX_PAGES = 100;
const MAX_BLOCKS_PER_PAGE = 2_000;
const MAX_ASSETS = 200;
/** One embedded image, before base64. Past this it belongs in the run's files. */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
/** Canonical base64 only — no whitespace, no base64url alphabet, correct padding. */
const STRICT_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Image types a bundle may embed.
 *
 * SVG is absent and its absence is the point: an SVG is a document, it may
 * contain `<script>` and event handlers, and browsers execute both when it is
 * loaded as a top-level document or inlined. Allowing "just images" while
 * allowing SVG reintroduces the exact script-execution hole the rest of this
 * file exists to close.
 */
export const SITE_ASSET_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type SiteAssetType = (typeof SITE_ASSET_TYPES)[number];

/** A named colour choice, not a CSS string — see `SITE_STYLESHEET`. */
export const SITE_THEMES = ["neutral", "warm", "cool"] as const;
export type SiteTheme = (typeof SITE_THEMES)[number];

const ACCENTS: Record<SiteTheme, string> = {
  neutral: "#3b5bdb",
  warm: "#b6531c",
  cool: "#127a6b",
};

export const sitePageSchema = z.object({
  /** Relative, `.html`, checked by `assertSafeBundlePath`. `index.html` required. */
  path: z.string().trim().min(1).max(180),
  title: z.string().trim().min(1).max(200),
  /** Shown in the page header under the title. */
  summary: z.string().trim().max(2_000).optional(),
  blocks: z.array(documentBlockSchema).min(1).max(MAX_BLOCKS_PER_PAGE),
});

export type SitePageSpec = z.infer<typeof sitePageSchema>;

export const siteAssetSchema = z.object({
  path: z.string().trim().min(1).max(180),
  contentType: z.enum(SITE_ASSET_TYPES),
  /** Base64. The spec is JSON, and JSON has no bytes. */
  base64: z.string().max(Math.ceil((MAX_ASSET_BYTES * 4) / 3) + 4),
});

export const siteSpecSchema = z.object({
  kind: z.literal("site"),
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(400).optional(),
  theme: z.enum(SITE_THEMES).optional(),
  pages: z.array(sitePageSchema).min(1).max(MAX_PAGES),
  assets: z.array(siteAssetSchema).max(MAX_ASSETS).optional(),
});

export type SiteSpec = z.infer<typeof siteSpecSchema>;

// ---------------------------------------------------------------------------
// Bundling
// ---------------------------------------------------------------------------

export interface BundleEntry {
  path: string;
  content: string | Buffer;
}

/**
 * Fixed timestamp on every entry.
 *
 * Without it the zip's central directory carries the wall clock, so bundling
 * the same spec twice produces different bytes and therefore a different
 * content hash — which would make every regeneration look like a change and
 * make the hash useless as an answer to "is this the same deliverable". 1980 is
 * the earliest date the DOS timestamp in a zip header can hold.
 */
const FIXED_ENTRY_DATE = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

/**
 * Zips a set of entries, refusing any name that could escape on extraction.
 *
 * Every path goes through `assertSafeBundlePath` — the same check
 * `validate.ts` re-applies to the finished archive — so a traversal entry is
 * refused at the moment it is added rather than discovered by whoever unzips
 * it. The duplicate check is case-insensitive because macOS and Windows are:
 * `Index.html` and `index.html` are two entries in the archive and one file on
 * disk, and which of the two survives depends on extraction order.
 */
export async function bundleFiles(entries: readonly BundleEntry[]): Promise<Buffer> {
  if (entries.length === 0) {
    throw new DeliverableError("invalid_spec", "A bundle needs at least one file.");
  }

  const zip = new JSZip();
  const seen = new Set<string>();

  for (const entry of entries) {
    assertSafeBundlePath(entry.path);
    const key = entry.path.toLowerCase();
    if (seen.has(key)) {
      throw new DeliverableError(
        "invalid_spec",
        `Two bundle entries resolve to the same file name: ${entry.path}. Extraction on a ` +
          `case-insensitive filesystem would keep only one of them.`
      );
    }
    seen.add(key);
    zip.file(entry.path, entry.content, { date: FIXED_ENTRY_DATE });
  }

  try {
    return await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
      // UNIX rather than the platform Node happens to be on, so the archive is
      // byte-identical whether it was produced on a developer's Mac or in the
      // cloud runner's container.
      platform: "UNIX",
    });
  } catch (err) {
    throw new DeliverableError(
      "build_failed",
      `Could not write the archive: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

/**
 * The bundle's only stylesheet, chosen from a closed set of themes.
 *
 * The spec carries a theme name, never CSS. Author-supplied CSS is not the
 * inert thing it looks like: `@import` fetches remotely, `url()` fetches
 * remotely, and both turn an offline bundle into one that phones home with the
 * time and place it was opened. A closed set of themes gives the agent the
 * choice that actually matters and none of the ones that do damage.
 */
function siteStylesheet(theme: SiteTheme): string {
  return `
:root { color-scheme: light dark; --accent: ${ACCENTS[theme]}; --fg: #16181d; --muted: #6b7280;
  --bg: #ffffff; --surface: #f4f5f7; --line: #dfe1e6; }
@media (prefers-color-scheme: dark) {
  :root { --fg: #e7e9ee; --muted: #8d94a2; --bg: #14161a; --surface: #1e2128; --line: #2c313a; }
}
* { box-sizing: border-box; }
body { margin: 0; color: var(--fg); background: var(--bg);
  font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.shell { max-width: 52rem; margin: 0 auto; padding: 2.5rem 1.25rem 4rem; }
.site-nav { border-bottom: 1px solid var(--line); padding-bottom: 1rem; margin-bottom: 2rem;
  display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; align-items: baseline; }
.site-nav .brand { font-weight: 650; margin-right: auto; }
.site-nav a { color: var(--muted); text-decoration: none; }
.site-nav a[aria-current="page"] { color: var(--accent); font-weight: 600; }
h1 { font-size: 2rem; line-height: 1.2; margin: 0 0 0.4em; }
h2, h3, h4, h5, h6 { line-height: 1.25; margin: 2em 0 0.6em; }
p { margin: 0 0 1em; }
.summary { color: var(--muted); font-size: 1.05rem; margin-bottom: 2rem; }
a { color: var(--accent); }
ul, ol { margin: 0 0 1em; padding-left: 1.4em; }
blockquote { margin: 0 0 1em; padding: 0.2em 0 0.2em 1em; border-left: 3px solid var(--line); color: var(--muted); }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em;
  background: var(--surface); padding: 0.15em 0.35em; border-radius: 4px; }
pre { background: var(--surface); padding: 1em; border-radius: 8px; overflow-x: auto; }
pre code { background: none; padding: 0; }
img { max-width: 100%; height: auto; }
.table-scroll { overflow-x: auto; margin: 0 0 1.4em; }
table { border-collapse: collapse; width: 100%; font-size: 0.95rem; }
caption { text-align: left; font-weight: 650; padding-bottom: 0.5em; }
th, td { border: 1px solid var(--line); padding: 0.5em 0.7em; text-align: left; vertical-align: top; }
th { background: var(--surface); }
.page-break { height: 0; }
.footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 0.9rem; }
`.trim();
}

/** The relative href from one page to another, both being flat or nested paths. */
function relativeHref(from: string, to: string): string {
  const depth = from.split("/").length - 1;
  return depth === 0 ? to : `${"../".repeat(depth)}${to}`;
}

function renderPage(spec: SiteSpec, page: SitePageSpec, blocks: readonly DocumentBlock[]): string {
  const nav = spec.pages
    .map((other) => {
      const current = other.path === page.path;
      const href = escapeHtml(relativeHref(page.path, other.path));
      // `aria-current` rather than a class alone, so the current page is
      // announced and not merely coloured.
      return `<a href="${href}"${current ? ' aria-current="page"' : ""}>${escapeHtml(other.title)}</a>`;
    })
    .join("");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(page.title)} — ${escapeHtml(spec.title)}</title>`,
    spec.description ? `<meta name="description" content="${escapeHtml(spec.description)}">` : "",
    `<link rel="stylesheet" href="${escapeHtml(relativeHref(page.path, "styles.css"))}">`,
    "</head>",
    "<body>",
    '<div class="shell">',
    `<nav class="site-nav"><span class="brand">${escapeHtml(spec.title)}</span>${nav}</nav>`,
    "<main>",
    `<h1>${escapeHtml(page.title)}</h1>`,
    page.summary ? `<p class="summary">${escapeHtml(page.summary)}</p>` : "",
    renderBlocksHtml(blocks, `site page "${page.path}"`),
    "</main>",
    '<p class="footer">Generated by Juno Work. This page runs no script and loads nothing remotely.</p>',
    "</div>",
    "</body>",
    "</html>",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/**
 * Builds the .zip bytes for a validated site spec.
 *
 * Asset bytes are decoded from base64 strictly: `Buffer.from(x, "base64")`
 * silently discards anything it cannot read, so a corrupt payload would
 * otherwise become a short, valid-looking file and ship as a broken image.
 */
export async function buildSite(spec: SiteSpec): Promise<Buffer> {
  const paths = new Set<string>();

  for (const page of spec.pages) {
    assertSafeBundlePath(page.path);
    if (!page.path.endsWith(".html")) {
      throw new DeliverableError("invalid_spec", `Site page "${page.path}" must end in .html`);
    }
    paths.add(page.path.toLowerCase());
  }
  if (!paths.has("index.html")) {
    throw new DeliverableError(
      "invalid_spec",
      "A site needs an index.html; it is the file a browser opens when the folder is opened."
    );
  }
  if (paths.has("styles.css")) {
    throw new DeliverableError(
      "invalid_spec",
      "styles.css is written by the bundler and cannot be a page."
    );
  }

  const entries: BundleEntry[] = spec.pages.map((page) => ({
    path: page.path,
    content: renderPage(spec, page, page.blocks),
  }));

  entries.push({ path: "styles.css", content: siteStylesheet(spec.theme ?? "neutral") });

  for (const asset of spec.assets ?? []) {
    assertSafeBundlePath(asset.path);
    // Checked before decoding, because `Buffer.from(x, "base64")` discards every
    // character it does not recognise instead of failing: a payload mangled in
    // transit decodes to a short, plausible-looking buffer and ships as a
    // broken image rather than as an error.
    if (!STRICT_BASE64.test(asset.base64) || asset.base64.length % 4 !== 0) {
      throw new DeliverableError("invalid_spec", `Asset "${asset.path}" is not valid base64.`);
    }
    const bytes = Buffer.from(asset.base64, "base64");
    if (bytes.byteLength === 0) {
      throw new DeliverableError("invalid_spec", `Asset "${asset.path}" decoded to zero bytes.`);
    }
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw new DeliverableError(
        "invalid_spec",
        `Asset "${asset.path}" is larger than the ${MAX_ASSET_BYTES / (1024 * 1024)} MB per-asset limit.`
      );
    }
    entries.push({ path: asset.path, content: bytes });
  }

  return bundleFiles(entries);
}
