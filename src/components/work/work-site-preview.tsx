"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import type JSZip from "jszip";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { StatusIcons } from "@/lib/app-icons";
import { workArtifactDownloadUrl } from "@/components/work/work-transport";

/*
 * LOOKING AT A SITE A RUN PRODUCED, WITHOUT DOWNLOADING IT.
 *
 * `src/lib/work/deliverables/site.ts` spends its whole header arguing that a
 * bundle is safe to look at, and then names the thing that should look at it:
 * "an opaque-origin iframe with no `allow-same-origin`, the way
 * src/components/canvas/sandbox-frame.tsx already does it". This file is that
 * previewer. It does not lean on the argument it is downstream of — the bundle
 * being script-free is the reason a preview is worth building, not a reason to
 * render it in the app origin.
 *
 * ── Why the frame is still treated as hostile ────────────────────────────────
 *
 * `sandbox="allow-scripts"` with no `allow-same-origin` is what makes it an
 * opaque origin: nothing inside can read Juno's cookies, its storage, or any
 * other tab. Everything else is closed by the CSP meta injected below —
 * `default-src 'none'` means no fetch, no XHR, no WebSocket, no font, no nested
 * frame, no remote stylesheet, no beacon. A page in here cannot report that it
 * was opened, which is the property the bundle format was designed to have and
 * this frame is where it is enforced rather than asserted.
 *
 * ── The nonce, which is the load-bearing detail ──────────────────────────────
 *
 * `script-src 'nonce-…'` rather than `'unsafe-inline'`. Only the navigation
 * bridge below carries the nonce, so it is the ONLY script the browser will run
 * here — an authored `<script>` in the page, which site.ts says cannot exist and
 * validate.ts re-checks against the produced bytes, meets a third refusal rather
 * than being the first thing to go wrong if either of those ever regressed.
 *
 * It is also the precondition that makes the two popup flags on the iframe
 * defensible. `allow-popups allow-popups-to-escape-sandbox` is the classic
 * sandbox escape when hostile script can call `window.open`, and here no script
 * but ours can run at all. They are present because a prose link in a page is a
 * real `<a href="https://…">` (report.ts renders one, filtered to http/https),
 * and both alternatives were worse: without them an external link either dies
 * silently under the pointer or navigates the preview away to a live
 * third-party page.
 *
 * ── Why the pages are read lazily ────────────────────────────────────────────
 *
 * A site may hold 100 pages (`MAX_PAGES` in site.ts) inside 50 MB of zip
 * (`ARTIFACT_MAX_BYTES.site`). The entry list is cheap and is needed up front —
 * the bridge has to know which hrefs are internal — but inflating every page to
 * a string on open spends that on pages nobody clicks to. The archive stays in a
 * ref and a page is decompressed when it is navigated to.
 *
 * JSZip is `import()`ed at that same moment, for the same reason: it is a
 * ~100 KB client dependency that already exists in the tree for the SERVER's
 * bundler, and a Work thread that never opens a preview should not carry it.
 *
 * ── What is deliberately not here ────────────────────────────────────────────
 *
 * No asset inlining. `documentBlockSchema` has no image block, so a page built
 * by `renderPage` cannot reference one of the bundle's assets — every `<img>`
 * this previewer could ever meet today would be one that does not exist. The
 * CSP admits `img-src data:` and nothing else, so if the block vocabulary grows
 * an image the honest failure is a broken image rather than a network request.
 */

/** The one entry `buildSite` guarantees. */
const INDEX_PAGE = "index.html";
/** Written by the bundler, never by a page (`buildSite` refuses it as a page). */
const STYLESHEET = "styles.css";

/**
 * Which deliverables can be looked at rather than only downloaded.
 *
 * `site` alone, and the narrowness is the point: it is the only kind whose
 * builder refuses a spec without an `index.html`, so it is the only kind where
 * offering Preview cannot open onto "there is nothing in here to show". The
 * other three zip kinds — `bundle`, `archive`, and whatever a host relay
 * uploads — may or may not contain a page, and a button that dead-ends half the
 * time is worse than no button.
 */
export function canPreviewArtifact(kind: string): boolean {
  return kind === "site";
}

// ---------------------------------------------------------------------------
// The document handed to the frame
// ---------------------------------------------------------------------------

/** `</script` inside a string literal ends the element, not the string. */
const CLOSE_SCRIPT = /<\/script/gi;
const CLOSE_STYLE = /<\/style/gi;

/** JSON safe to sit inside a `<script>` body. Escaping `<` covers `</script`
 *  and `<!--` at once. Neither is legal in a path `assertSafeBundlePath`
 *  accepted — but these bytes are read back out of storage rather than held in
 *  memory since that check ran, so they are escaped rather than trusted. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * The navigation bridge.
 *
 * Relative hrefs are the problem this exists to solve: a `srcdoc` document
 * resolves them against the CONTAINING page's URL, so the site's own nav —
 * `<a href="about.html">` — would try to fetch `/work/<id>/about.html` from
 * Juno. No `<base>` fixes it, because the pages are entries in a zip and are not
 * at any URL at all. So the resolution happens here against the bundle's own
 * entry list, and the answer is handed to the parent, which swaps the document.
 *
 * Anything that is not an internal page is left alone: an in-page `#anchor`, a
 * `mailto:`, an `https://` link. The last of those gets `target="_blank"` so it
 * opens as its own tab instead of replacing the preview with a live web page.
 */
function navigationBridge(pages: readonly string[], current: string): string {
  return `
(function () {
  var pages = ${scriptJson(pages)};
  var here = ${scriptJson(current)};
  function resolve(href) {
    var base = here.split("/");
    base.pop();
    var parts = href.split("/");
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part === "" || part === ".") continue;
      if (part === "..") { base.pop(); continue; }
      base.push(part);
    }
    return base.join("/").toLowerCase();
  }
  document.addEventListener("DOMContentLoaded", function () {
    var links = document.querySelectorAll("a[href]");
    for (var i = 0; i < links.length; i++) {
      if (!/^https?:/i.test(links[i].getAttribute("href") || "")) continue;
      links[i].target = "_blank";
      links[i].rel = "noreferrer noopener";
    }
  });
  document.addEventListener("click", function (event) {
    var node = event.target;
    while (node && node !== document && node.nodeName !== "A") node = node.parentNode;
    if (!node || node === document) return;
    var raw = node.getAttribute("href") || "";
    // A scheme, a fragment or a root-relative path is never a bundle entry.
    if (raw === "" || raw.charAt(0) === "#" || raw.charAt(0) === "/") return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return;
    var target = resolve(raw.split("#")[0].split("?")[0]);
    if (pages.indexOf(target) === -1) return;
    event.preventDefault();
    try { parent.postMessage({ type: "juno:site-page", path: target }, "*"); } catch (err) {}
  });
})();
`.trim();
}

/**
 * Wraps one page of the bundle in the policy that makes it safe to render.
 *
 * The CSP goes in immediately after `<head>` and the stylesheet and bridge go in
 * immediately before `</head>`, and the split is not tidiness. A meta policy
 * only governs what the parser reaches AFTER it, so it has to be first — but
 * `<meta charset>` has to land inside the document's first 1024 bytes or the
 * page is decoded as something other than UTF-8, and injecting a few KB of CSS
 * ahead of it is exactly how that happens.
 *
 * Returns null when there is no `<head>` to inject into. That is not a page this
 * product built, and rendering it without the policy is the one outcome not
 * worth having.
 */
function previewDoc(
  html: string,
  stylesheet: string,
  pages: readonly string[],
  current: string,
  nonce: string
): string | null {
  const open = /<head\b[^>]*>/i.exec(html);
  const close = html.search(/<\/head\s*>/i);
  if (!open || close === -1 || close < open.index) return null;

  const csp =
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; ` +
    `script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; ` +
    `frame-src 'none'; object-src 'none'">`;
  const bridge = navigationBridge(pages, current).replace(CLOSE_SCRIPT, "<\\/script");
  const tail =
    `<style>${stylesheet.replace(CLOSE_STYLE, "<\\/style")}</style>` +
    `<script nonce="${nonce}">${bridge}</${"script"}>`;

  const headEnd = open.index + open[0].length;
  return html.slice(0, headEnd) + csp + html.slice(headEnd, close) + tail + html.slice(close);
}

/** A fresh nonce per rendered document — one reused across pages would let a
 *  cached copy of an earlier page's markup satisfy a later page's policy, which
 *  is the one thing a nonce exists to prevent. */
function randomNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Case-insensitive lookup of one entry. `bundleFiles` already refuses two
 *  entries that differ only in case, so a lowercased key cannot be ambiguous. */
function entryFor(zip: JSZip, path: string) {
  return zip.file(new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"))[0] ?? null;
}

// ---------------------------------------------------------------------------
// Reading the bundle
// ---------------------------------------------------------------------------

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; pages: string[]; stylesheet: string }
  | { kind: "failed"; message: string };

/** The download route answers a broken read with JSON that explains itself, and
 *  a 409 content-hash mismatch in particular is a sentence the reader needs
 *  verbatim: "these are not the bytes the run produced" is not a retry. */
async function downloadProblem(response: Response): Promise<string> {
  if (response.headers.get("content-type")?.includes("application/json")) {
    try {
      const body: unknown = await response.json();
      if (body && typeof body === "object" && typeof (body as { message?: unknown }).message === "string") {
        return (body as { message: string }).message;
      }
    } catch {
      // A body that is not the JSON it claimed to be adds nothing to say.
    }
  }
  return "Couldn’t read this site’s files. The download beside it is unaffected.";
}

// ---------------------------------------------------------------------------
// The dialog
// ---------------------------------------------------------------------------

export function WorkSitePreview({
  artifactId,
  version,
  title,
  open,
  onOpenChange,
}: {
  artifactId: string;
  /** The version on screen, so the frame and the header cannot disagree. */
  version: number;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [state, setState] = React.useState<LoadState>({ kind: "loading" });
  const [path, setPath] = React.useState(INDEX_PAGE);
  const [html, setHtml] = React.useState<string | null>(null);
  const [pageProblem, setPageProblem] = React.useState<string | null>(null);
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  // Held rather than re-read: opening a second page must not re-download 50 MB.
  const zipRef = React.useRef<JSZip | null>(null);
  /*
   * Which open this work belongs to.
   *
   * A download and an inflate are both long enough to outlive the dialog that
   * asked for them — close it and reopen it and there are two of each in
   * flight, racing to write `zipRef` and the state. Bumped on every open and on
   * every close, and checked after each await, so the loser drops out instead of
   * pushing an older bundle over a newer one.
   */
  const generation = React.useRef(0);

  const load = React.useCallback(async () => {
    const mine = ++generation.current;
    setState({ kind: "loading" });
    setHtml(null);
    setPageProblem(null);
    setPath(INDEX_PAGE);

    let bytes: ArrayBuffer;
    try {
      const response = await fetch(workArtifactDownloadUrl(artifactId, version));
      if (generation.current !== mine) return;
      if (!response.ok) {
        setState({ kind: "failed", message: await downloadProblem(response) });
        return;
      }
      bytes = await response.arrayBuffer();
    } catch {
      if (generation.current !== mine) return;
      setState({
        kind: "failed",
        message: "Couldn’t reach the file. The download beside it is unaffected.",
      });
      return;
    }
    if (generation.current !== mine) return;

    try {
      const { default: JSZipModule } = await import("jszip");
      const zip = await JSZipModule.loadAsync(bytes);
      if (generation.current !== mine) return;
      zipRef.current = zip;

      const pages: string[] = [];
      let stylesheetPath: string | null = null;
      for (const [entryPath, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        const lower = entryPath.toLowerCase();
        if (lower.endsWith(".html")) pages.push(lower);
        else if (lower === STYLESHEET) stylesheetPath = entryPath;
      }

      if (!pages.includes(INDEX_PAGE)) {
        setState({
          kind: "failed",
          message:
            "This bundle has no index.html, so there is no page to open. It can still be downloaded.",
        });
        return;
      }

      const sheet = stylesheetPath === null ? null : entryFor(zip, stylesheetPath);
      const stylesheet = sheet === null ? "" : await sheet.async("string");
      if (generation.current !== mine) return;
      setState({ kind: "ready", pages, stylesheet });
    } catch {
      if (generation.current !== mine) return;
      setState({
        kind: "failed",
        message: "This file could not be opened as an archive. The download beside it is unaffected.",
      });
    }
  }, [artifactId, version]);

  React.useEffect(() => {
    if (!open) {
      // Closing frees the archive. This component stays mounted while shut — so
      // that Radix can play the dialog's own exit rather than having it yanked
      // out from under it — and a decompressed 50 MB site held behind a closed
      // dialog, once per document row, is not a thing a Work thread should carry.
      generation.current += 1;
      zipRef.current = null;
      return;
    }
    // Re-read on every open rather than once: a scheduled task can write a new
    // version while this row is on screen, and showing bytes that are no longer
    // the current ones is exactly the confusion the deliverable pipeline hashes
    // against everywhere else.
    void load();
  }, [open, load]);

  // The page's own markup, inflated the first time it is asked for.
  React.useEffect(() => {
    if (state.kind !== "ready") return;
    const zip = zipRef.current;
    if (!zip) return;

    setHtml(null);
    setPageProblem(null);

    const entry = entryFor(zip, path);
    if (entry === null) {
      setPageProblem(`“${path}” is listed in this site but is not in the archive.`);
      return;
    }

    let cancelled = false;
    void entry.async("string").then((text) => {
      if (cancelled) return;
      const doc = previewDoc(text, state.stylesheet, state.pages, path, randomNonce());
      if (doc === null) {
        setPageProblem(`“${path}” is not a page Juno can show safely, so it has not been rendered.`);
        return;
      }
      setHtml(doc);
    });
    return () => {
      cancelled = true;
    };
  }, [state, path]);

  // Only this frame's window is trusted, and only a path the entry list already
  // named: the bridge computes the target, but the parent decides whether it is
  // a page in this bundle.
  React.useEffect(() => {
    if (state.kind !== "ready") return;
    const pages = state.pages;
    const onMessage = (event: MessageEvent) => {
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;
      const data = event.data as { type?: unknown; path?: unknown } | null;
      if (!data || typeof data !== "object" || data.type !== "juno:site-page") return;
      if (typeof data.path !== "string" || !pages.includes(data.path)) return;
      setPath(data.path);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [state]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // A preview is the one dialog in Work whose content is the point, so it
        // takes the width and the height rather than the `max-w-lg` default —
        // and it does not scroll, because the frame inside it does.
        className="h-[min(48rem,calc(100dvh-2rem))] max-w-5xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
      >
        <DialogHeader>
          {/* pr-10 so a long site name never runs under the close button. */}
          <DialogTitle className="pr-10">{title}</DialogTitle>
          <DialogDescription>
            {/* Stated plainly because it is the reason this is allowed to
                exist: the frame reaches neither Juno nor the network. */}
            Version {version} · <span className="font-mono">{path}</span> · this page runs no script
            and loads nothing from the network.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-hidden rounded-field border border-border/60 bg-card">
          {state.kind === "loading" ? (
            <PreviewWait label="Unpacking the site…" />
          ) : state.kind === "failed" ? (
            <PreviewProblem message={state.message} onRetry={() => void load()} />
          ) : pageProblem !== null ? (
            <PreviewProblem
              message={pageProblem}
              onRetry={() => setPath(INDEX_PAGE)}
              retryLabel="Back to the first page"
            />
          ) : html === null ? (
            <PreviewWait label={`Opening ${path}…`} />
          ) : (
            <iframe
              ref={frameRef}
              title={`${title} — ${path}`}
              srcDoc={html}
              // No `allow-same-origin`: the opaque origin is what stops anything
              // in here reaching Juno's cookies or storage. The two popup flags
              // are what let an external link open as a real tab, and they are
              // only defensible because the injected nonce means no script from
              // the bundle can ever run to abuse them.
              sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
              // The bundle paints its own background for both colour schemes, so
              // a fill here would flash the wrong one before the page arrives.
              className="size-full border-0 bg-transparent"
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PreviewWait({ label }: { label: string }) {
  return (
    <p
      role="status"
      className="flex h-full items-center justify-center gap-1.5 font-mono text-micro text-muted-foreground"
    >
      <Loader2 className="size-3 animate-spin" aria-hidden="true" /> {label}
    </p>
  );
}

function PreviewProblem({
  message,
  onRetry,
  retryLabel = "Try again",
}: {
  message: string;
  onRetry: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 px-6 text-center">
      <StatusIcons.warning className="size-4 text-warning" aria-hidden="true" />
      <p className="max-w-md text-ui leading-relaxed text-muted-foreground">{message}</p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        {retryLabel}
      </Button>
    </div>
  );
}
