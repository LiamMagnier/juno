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
import { Markdown } from "@/components/chat/markdown";
import { StatusIcons } from "@/lib/app-icons";
import { workArtifactDownloadUrl } from "@/components/work/work-transport";
import {
  prepareReportPreview,
  REPORT_PREVIEW_MAX_CHARS,
} from "@/lib/work/deliverables/report-preview";

/*
 * LOOKING AT WHAT A RUN PRODUCED, WITHOUT DOWNLOADING IT.
 *
 * Two previewers live here, one per kind that has one, because they share the
 * dialog shell, the download-and-race handling and the two states below — and
 * because `canPreviewArtifact` is the single sentence about which kinds are
 * offered a Preview at all, which is easiest to keep true when it sits beside
 * everything it licenses. The file is named for the first of the two and is now
 * one previewer behind its contents; a rename is a rename this change did not
 * need to make, and the export it is reached through says what it covers.
 *
 * ── The site previewer ──────────────────────────────────────────────────────
 *
 * `src/lib/work/deliverables/site.ts` spends its whole header arguing that a
 * bundle is safe to look at, and then names the thing that should look at it:
 * "an opaque-origin iframe with no `allow-same-origin`, the way
 * src/components/canvas/sandbox-frame.tsx already does it". `WorkSitePreview`
 * below is that previewer. It does not lean on the argument it is downstream of
 * — the bundle
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
 *
 * ── The report previewer ────────────────────────────────────────────────────
 *
 * A `report`'s stored bytes are markdown, so it does NOT go in the frame above.
 * The whole argument for why — what markdown can carry, what is done about each
 * of those things, and the two ways the app's chat renderer silently corrupts a
 * report file if it is handed one unprepared — is written out at the top of
 * `src/lib/work/deliverables/report-preview.ts`, next to the code that acts on
 * it. `WorkReportPreview` below is only the surface: fetch, prepare, render,
 * and say on screen what was changed and what was cut.
 */

/** The one entry `buildSite` guarantees. */
const INDEX_PAGE = "index.html";
/** Written by the bundler, never by a page (`buildSite` refuses it as a page). */
const STYLESHEET = "styles.css";

/**
 * Which deliverables can be looked at rather than only downloaded.
 *
 * Two of the nine, and the narrowness is the point. The rule the whole file is
 * built on is that a Preview must not be able to open onto "there is nothing in
 * here to show", so a kind earns the button only when something GUARANTEES
 * there is a thing to show and this build can show it faithfully.
 *
 *   `site` — `buildSite` refuses a spec without an `index.html`, so there is
 *   always an entry page, and `validate.ts` re-opens the produced zip to check
 *   it. See the frame above for how it is rendered.
 *
 *   `report` — the stored bytes are markdown, which this product renders on
 *   half a dozen other surfaces already, and `buildReport` throws rather than
 *   store a report that rendered to nothing.
 *
 * The seven that are refused, each for its own reason rather than by default:
 *
 *   `bundle` and `archive` are generic zips with no guaranteed entry page, and
 *   whatever a host relay uploads is a zip nothing in this repo composed. Half
 *   of them would dead-end, and a button that dead-ends half the time is worse
 *   than no button.
 *
 *   `document` is a .docx. Nothing in the tree reads one: `docx` is a writer
 *   with no parser, so previewing one means hand-walking WordprocessingML —
 *   several hundred lines to produce a layout that is wrong wherever the
 *   document is interesting (tables, sections, numbering, anything floated).
 *   The download opens in the application the file was written for.
 *
 *   `pdf` is the one that looked buildable, because `unpdf` is in the tree for
 *   research extraction, and it is still refused. Rasterising a first page is
 *   what a reader actually wants, and unpdf cannot do it without `@napi-rs/canvas`
 *   — the optional native peer `pdf-text.ts` was specifically written to avoid —
 *   plus a server route to run it on. What unpdf CAN give the browser is
 *   `extractPdfText`'s output: 1.6 MB of pdf.js loaded to produce an unlaid-out
 *   wall of text with no columns, no tables, no figures and, for a scan, the
 *   `no_text_layer` verdict and nothing at all. That is not a preview of a PDF,
 *   it is a different document; the row's download and its size say more.
 *
 *   `spreadsheet`, `presentation` and `image` are outside this milestone rather
 *   than judged: nobody has argued them either way here, so they are absent.
 */
export function canPreviewArtifact(kind: string): boolean {
  return kind === "site" || kind === "report";
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
 *  verbatim: "these are not the bytes the run produced" is not a retry. The
 *  fallback is the caller's because the two previewers are reading different
 *  things, and "this site's files" in front of a report names the wrong file. */
async function downloadProblem(response: Response, fallback: string): Promise<string> {
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
  return fallback;
}

/** Said whenever the bytes could not be reached at all, for either kind: the
 *  download link in the row is a separate request and is not implicated. */
const UNREACHABLE = "Couldn’t reach the file. The download beside it is unaffected.";

// ---------------------------------------------------------------------------
// The dialogs
// ---------------------------------------------------------------------------

/** What every previewer here needs, and nothing else. `version` travels with
 *  the rest so the frame and the header cannot disagree about which one is on
 *  screen. */
interface PreviewProps {
  artifactId: string;
  version: number;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The Preview control's one entry point, so the row does not have to know which
 * previewer a kind gets.
 *
 * It refuses an unpreviewable kind itself rather than trusting the caller to
 * have asked `canPreviewArtifact` first. Without that, the fallback branch
 * would put a .docx through the site previewer the day a new kind is added and
 * one of the two call sites is missed — and the failure would be a dialog
 * saying "this file could not be opened as an archive", which reads as a
 * corrupt document rather than as this component's mistake.
 */
export function WorkDeliverablePreview({ kind, ...props }: PreviewProps & { kind: string }) {
  if (!canPreviewArtifact(kind)) return null;
  if (kind === "report") return <WorkReportPreview {...props} />;
  return <WorkSitePreview {...props} />;
}

function WorkSitePreview({ artifactId, version, title, open, onOpenChange }: PreviewProps) {
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
        setState({
          kind: "failed",
          message: await downloadProblem(
            response,
            "Couldn’t read this site’s files. The download beside it is unaffected."
          ),
        });
        return;
      }
      bytes = await response.arrayBuffer();
    } catch {
      if (generation.current !== mine) return;
      setState({ kind: "failed", message: UNREACHABLE });
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

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

type ReportState =
  | { kind: "loading" }
  | { kind: "ready"; markdown: string; truncated: boolean; imageRefs: number }
  | { kind: "failed"; message: string };

/**
 * A report's markdown, laid out with the renderer the rest of the product uses.
 *
 * Simpler than the site previewer by exactly the amount the format is simpler:
 * one request, one string, no archive to hold open and no second page to
 * navigate to. What it does keep is the generation guard — a close-and-reopen
 * still leaves an in-flight download racing a newer one, and a report that
 * arrives after its dialog was reopened at a different version would otherwise
 * paint the wrong version under the right header.
 *
 * The bytes are read on every open rather than cached for the same reason the
 * site previewer re-reads: a schedule can write v4 while v3 is on screen, and
 * every other part of this pipeline hashes specifically so that nobody is shown
 * bytes that are no longer the current ones.
 */
function WorkReportPreview({ artifactId, version, title, open, onOpenChange }: PreviewProps) {
  const [state, setState] = React.useState<ReportState>({ kind: "loading" });
  const generation = React.useRef(0);

  const load = React.useCallback(async () => {
    const mine = ++generation.current;
    setState({ kind: "loading" });

    let text: string;
    try {
      const response = await fetch(workArtifactDownloadUrl(artifactId, version));
      if (generation.current !== mine) return;
      if (!response.ok) {
        setState({
          kind: "failed",
          message: await downloadProblem(
            response,
            "Couldn’t read this report. The download beside it is unaffected."
          ),
        });
        return;
      }
      // `text()` decodes as UTF-8 and replaces any byte that is not — which is
      // the right failure for a preview. A strict decoder would refuse the whole
      // file over one damaged byte, when what the reader needs to know is that
      // the report exists and where the damage is; U+FFFD shows them exactly.
      text = await response.text();
    } catch {
      if (generation.current !== mine) return;
      setState({ kind: "failed", message: UNREACHABLE });
      return;
    }
    if (generation.current !== mine) return;

    const prepared = prepareReportPreview(text);
    if (prepared.markdown.trim() === "") {
      // `buildReport` throws rather than store a report that rendered to
      // nothing, so reaching this means the stored object is not what the run
      // wrote. Saying so beats laying out an empty page that reads like a
      // report with nothing in it.
      setState({
        kind: "failed",
        message: "There is no text in this version of the report. It can still be downloaded.",
      });
      return;
    }
    setState({ kind: "ready", ...prepared });
  }, [artifactId, version]);

  React.useEffect(() => {
    if (!open) {
      // Retires whatever is in flight, and drops the markdown with the state on
      // the next open. Nothing else is held: there is no archive here.
      generation.current += 1;
      return;
    }
    void load();
  }, [open, load]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Narrower than the site dialog on purpose. A site brings its own
        // layout and deserves the width; a report is prose, and prose set to
        // 64rem is a measure nobody can read a paragraph across. This one
        // scrolls, because there is no frame inside it to do the scrolling.
        className="h-[min(48rem,calc(100dvh-2rem))] max-w-3xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
      >
        <DialogHeader>
          {/* pr-10 so a long report title never runs under the close button. */}
          <DialogTitle className="pr-10">{title}</DialogTitle>
          <DialogDescription>
            {/* Deliberately says "in this report" rather than "this page",
                which is what the site previewer can say about its frame and
                this one cannot: the surrounding page is Juno's own and plainly
                runs script. The claim being made is about the FILE — nothing in
                it becomes markup, and nothing in it is fetched when this
                paints. See report-preview.ts for why both hold. */}
            Version {version} · <span className="font-mono">markdown</span> · nothing in this report
            is run, and nothing in it is loaded from the network.
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 overflow-y-auto overscroll-contain rounded-field border border-border/60 bg-card px-5 py-4">
          {state.kind === "loading" ? (
            <PreviewWait label="Reading the report…" />
          ) : state.kind === "failed" ? (
            <PreviewProblem message={state.message} onRetry={() => void load()} />
          ) : (
            <>
              {(state.imageRefs > 0 || state.truncated) && (
                <div className="mb-4 space-y-1 border-b border-border/60 pb-3">
                  {state.imageRefs > 0 && (
                    <p className="text-caption leading-relaxed text-muted-foreground">
                      {state.imageRefs === 1
                        ? "One image is shown as a link rather than loaded"
                        : `${state.imageRefs} images are shown as links rather than loaded`}
                      , so opening this preview tells nobody’s server that you did.
                    </p>
                  )}
                  {state.truncated && (
                    <p className="text-caption leading-relaxed text-muted-foreground">
                      Only the first {REPORT_PREVIEW_MAX_CHARS.toLocaleString("en-US")} characters
                      are laid out here. The download has the whole file.
                    </p>
                  )}
                </div>
              )}
              {/* No `sources`: the citation-chip contract belongs to deep
                  research, which hands the model a numbered corpus. A report's
                  own sources are prose written by `sourcesMarkdown`, and
                  resolving a bracket in one positionally into a list this
                  component does not have would attach a confident wrong source
                  to a claim. */}
              <Markdown content={state.markdown} />
            </>
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
