"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import type { PDFDocumentProxy } from "unpdf/pdfjs";
import { Button } from "@/components/ui/button";
import { IconSwap } from "@/components/ui/icon-swap";
import { ChevronDown, ChevronUp, Crop, Maximize2, Minimize2, TextSearch } from "@/components/ui/icons";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MENU_W } from "@/components/ui/menu-recipe";
import { FilePreview, extensionOf } from "@/components/chat/file-preview";
import { ActionIcons } from "@/lib/app-icons";
import { formatLabelOf, joinSoftWraps, viewerKindOf, type ViewerKind } from "@/lib/documents/viewer-kind";
import { clampQuoteText, type DocumentQuoteLocation } from "@/lib/quote-context";
import { cn, formatBytes } from "@/lib/utils";
import type { ClientAttachment } from "@/types/chat";
import { DocumentLoadError, onOpenProgress, openPdf } from "./pdf-engine";
import { PdfView } from "./pdf-view";
import { ImageView } from "./image-view";
import { TextView } from "./text-view";
import { ReaderView } from "./reader-view";
import { clearFindHighlights, findRanges, paintFindHighlights, scrollRangeIntoView } from "./find";
import { SelectionActions, ViewerLoading, ViewerMessage, copyText } from "./viewer-ui";
import type { DocumentAsk, FindCommand, FindStatus, Tool } from "./types";
import { PRODUCT_NAME } from "@/lib/brand/names";

/* ─────────────────────────────────────────────────────────────────────────────
 * A FILE, OPENED BESIDE THE CONVERSATION ABOUT IT.
 *
 * An attachment used to be a link that downloaded the file — to the Downloads
 * folder, into another app, away from the conversation that was about it. So
 * the question "what does the chart on page 6 mean" started with leaving Juno
 * to find page 6. This panel is where the file is read instead: in the
 * canvas's column, at the canvas's width, beside the chat.
 *
 * And reading is where questions come from, so the panel's one real verb is
 * ASK. Select a passage — or, in a PDF or an image, draw a box around a figure
 * that has no text to select — and it lands in the composer as a quote: the
 * words (or a crop, magnified for a model to read), the page it came from, and
 * the file's name. The model is told exactly which part the person means,
 * which is the one thing "the chart on page 6" never reliably conveyed.
 *
 * Formats, each in the view that suits it:
 *   PDF      pages drawn by pdf.js, with its selectable text layer and links
 *   image    fitted and zoomable
 *   text     Markdown rendered, CSV as a table, source with line numbers
 *   office   Word, PowerPoint and Excel as a clean reading view of their
 *            structure (see lib/documents/reader.ts for why not a rendering)
 *   other    its name, and the download
 * ───────────────────────────────────────────────────────────────────────────── */

type PdfState =
  | { status: "loading"; progress: number | null }
  | { status: "ready"; doc: PDFDocumentProxy }
  | { status: "error"; reason: DocumentLoadError["reason"] };

function usePdf(attachment: ClientAttachment, enabled: boolean): PdfState {
  const [state, setState] = React.useState<PdfState>({ status: "loading", progress: null });
  React.useEffect(() => {
    if (!enabled) return;
    let live = true;
    setState({ status: "loading", progress: null });
    const unsubscribe = onOpenProgress(attachment.id, (progress) => live && setState({ status: "loading", progress }));
    openPdf(attachment.id, attachment.url)
      .then((doc) => live && setState({ status: "ready", doc }))
      .catch((error: unknown) => {
        if (!live) return;
        setState({ status: "error", reason: error instanceof DocumentLoadError ? error.reason : "invalid" });
      });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [attachment.id, attachment.url, enabled]);
  return state;
}

const PDF_ERRORS: Record<DocumentLoadError["reason"], { title: string; body: string }> = {
  missing: { title: "This file is no longer available.", body: "It may have been deleted from your Library." },
  network: { title: "The file couldn’t be loaded.", body: "Check your connection and open it again." },
  password: { title: "This PDF is password-protected.", body: "Download it and open it with the password." },
  invalid: { title: "This PDF couldn’t be read.", body: "It may be damaged. Download it to try another reader." },
  engine: { title: "The PDF reader couldn’t load.", body: "Reload the page and try again." },
};

/* ─── Where a selection is ──────────────────────────────────────────────── */

interface PointLocation {
  page?: number;
  slide?: number;
  sheet?: string;
  line?: number;
}

function numberAttr(el: Element | null, name: string): number | undefined {
  const raw = el?.getAttribute(name);
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function pointLocation(node: Node, offset: number): PointLocation {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!el) return {};
  const page = el.closest("[data-page-number]");
  if (page) return { page: numberAttr(page, "data-page-number") };
  const located = el.closest("[data-loc-page],[data-loc-slide],[data-loc-sheet]");
  if (located) {
    return {
      page: numberAttr(located, "data-loc-page"),
      slide: numberAttr(located, "data-loc-slide"),
      sheet: located.getAttribute("data-loc-sheet") ?? undefined,
    };
  }
  const row = el.closest("[data-line]");
  if (row) return { line: numberAttr(row, "data-line") };
  const source = el.closest("[data-line-source]");
  if (source) {
    // The line is the number of line breaks before the point, plus one.
    const before = document.createRange();
    try {
      before.setStart(source, 0);
      before.setEnd(node, offset);
      return { line: before.toString().split("\n").length };
    } catch {
      return {};
    }
  }
  return {};
}

function rangeLocation(range: Range): DocumentQuoteLocation | undefined {
  const a = pointLocation(range.startContainer, range.startOffset);
  // An end at offset 0 of the next block is how a triple-click ends; it did not
  // select anything there, so it does not extend the location into it.
  const endsAtBoundary = range.endOffset === 0 && range.endContainer !== range.startContainer;
  const b = endsAtBoundary ? a : pointLocation(range.endContainer, range.endOffset);
  if (a.page != null) return { page: a.page, ...(b.page != null && b.page > a.page ? { pageEnd: b.page } : {}) };
  if (a.slide != null) return { slide: a.slide, ...(b.slide != null && b.slide > a.slide ? { slideEnd: b.slide } : {}) };
  if (a.sheet) return { sheet: a.sheet };
  if (a.line != null) return { lineStart: a.line, ...(b.line != null && b.line > a.line ? { lineEnd: b.line } : {}) };
  return undefined;
}

/* ─── The selection toolbar ─────────────────────────────────────────────── */

interface TextSelectionState {
  text: string;
  location?: DocumentQuoteLocation;
  range: Range;
}

function useTextSelection(root: React.RefObject<HTMLElement | null>, enabled: boolean) {
  const [selection, setSelection] = React.useState<TextSelectionState | null>(null);
  React.useEffect(() => {
    if (!enabled) {
      setSelection(null);
      return;
    }
    let timer: number | null = null;
    const read = () => {
      const sel = window.getSelection();
      const container = root.current;
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !container) return setSelection(null);
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return setSelection(null);
      const text = sel.toString().replace(/ /g, " ").trim();
      if (!text) return setSelection(null);
      setSelection({ text, location: rangeLocation(range), range: range.cloneRange() });
    };
    const onChange = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(read, 180);
    };
    document.addEventListener("selectionchange", onChange);
    return () => {
      document.removeEventListener("selectionchange", onChange);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [root, enabled]);
  return [selection, setSelection] as const;
}

function SelectionToolbar({
  selection,
  bounds,
  onAsk,
  onExplain,
  onCopy,
}: {
  selection: TextSelectionState;
  bounds: React.RefObject<HTMLElement | null>;
  onAsk: () => void;
  onExplain: () => void;
  onCopy: () => void;
}) {
  const barRef = React.useRef<HTMLDivElement>(null);
  const [, reposition] = React.useReducer((n: number) => n + 1, 0);
  const [size, setSize] = React.useState<{ w: number; h: number } | null>(null);

  // The bar rides with the selection while the document scrolls under it.
  React.useEffect(() => {
    const onMove = () => reposition();
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, []);
  React.useLayoutEffect(() => {
    const el = barRef.current;
    if (el) setSize({ w: el.offsetWidth, h: el.offsetHeight });
  }, [selection]);

  const rect = selection.range.getBoundingClientRect();
  const box = bounds.current?.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  const offscreen = box ? rect.bottom < box.top || rect.top > box.bottom : false;
  const w = size?.w ?? 220;
  const h = size?.h ?? 38;
  const margin = 8;
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - w / 2, (box?.left ?? 0) + margin),
    Math.max(margin, (box?.right ?? window.innerWidth) - w - margin),
  );
  let top = rect.top - h - margin;
  if (top < (box?.top ?? 0) + margin) top = rect.bottom + margin;

  return createPortal(
    <SelectionActions
      barRef={barRef}
      onAsk={onAsk}
      onExplain={onExplain}
      onCopy={onCopy}
      className="fixed"
      style={{ top, left, visibility: size && !offscreen ? "visible" : "hidden" }}
    />,
    document.body,
  );
}

/* ─── Find bar ──────────────────────────────────────────────────────────── */

function FindBar({
  status,
  onQuery,
  onStep,
  onClose,
}: {
  status: FindStatus;
  onQuery: (q: string) => void;
  onStep: (dir: 1 | -1) => void;
  onClose: () => void;
}) {
  const [value, setValue] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);
  React.useEffect(() => {
    const t = window.setTimeout(() => onQuery(value), 160);
    return () => window.clearTimeout(t);
  }, [value, onQuery]);

  const label = !value.trim()
    ? ""
    : status.count === 0
      ? status.pending
        ? "Searching…"
        : "No matches"
      : `${status.active + 1} of ${status.count}${status.pending ? "+" : ""}`;

  return (
    <div className="flex items-center gap-1.5 border-b border-border/60 bg-card px-3 py-1.5 motion-safe:animate-fade-in" role="search">
      <TextSearch className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onStep(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose();
          }
        }}
        placeholder="Find in document"
        aria-label="Find in document"
        className="h-8 min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-muted-foreground"
      />
      <span aria-live="polite" className="shrink-0 font-mono text-caption tabular-nums text-muted-foreground">
        {label}
      </span>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Previous match" disabled={status.count === 0} onClick={() => onStep(-1)}>
        <ChevronUp className="size-4" aria-hidden />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Next match" disabled={status.count === 0} onClick={() => onStep(1)}>
        <ChevronDown className="size-4" aria-hidden />
      </Button>
      <Button type="button" variant="ghost" size="icon-sm" aria-label="Close find" onClick={onClose}>
        <ActionIcons.dismiss className="size-4" aria-hidden />
      </Button>
    </div>
  );
}

/**
 * Find over a DOM view (text, reading view): the ranges are the matches, so
 * counting and painting are one pass.
 */
function useDomFind(root: React.RefObject<HTMLElement | null>, find: FindCommand | null, ready: boolean, onStatus: (s: FindStatus) => void) {
  const query = find?.query.trim() ?? "";
  React.useEffect(() => {
    const container = root.current;
    if (!query || !container || !ready) {
      clearFindHighlights();
      onStatus({ count: 0, active: -1, pending: false });
      return;
    }
    const ranges = findRanges(container, query);
    const active = ranges.length ? (((find?.index ?? 0) % ranges.length) + ranges.length) % ranges.length : -1;
    paintFindHighlights(ranges, active >= 0 ? ranges[active] : null);
    onStatus({ count: ranges.length, active, pending: false });
    const scroller = container.querySelector<HTMLElement>("[data-document-scroller]") ?? container;
    if (active >= 0) scrollRangeIntoView(scroller, ranges[active]);
    // `find.nonce` is what makes stepping to the same index twice re-scroll.
  }, [root, query, find?.index, find?.nonce, ready, onStatus]);
  React.useEffect(() => () => clearFindHighlights(), []);
}

/* ─── The panel ─────────────────────────────────────────────────────────── */

export interface DocumentViewerProps {
  attachment: ClientAttachment;
  /** Every file in the conversation, for the switcher. The open one included. */
  files?: ClientAttachment[];
  onSelectFile?: (attachment: ClientAttachment) => void;
  onClose: () => void;
  /** Absent where there is no composer to ask in — the viewer still reads. */
  onAsk?: (attachment: ClientAttachment, ask: DocumentAsk) => void;
  fullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

export function DocumentViewer({
  attachment,
  files = [],
  onSelectFile,
  onClose,
  onAsk,
  fullscreen = false,
  onToggleFullscreen,
}: DocumentViewerProps) {
  const kind: ViewerKind = viewerKindOf(attachment);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const bodyRef = React.useRef<HTMLDivElement>(null);
  const pdf = usePdf(attachment, kind === "pdf");
  const [pageMeta, setPageMeta] = React.useState<string | null>(null);
  const [tool, setTool] = React.useState<Tool>(kind === "image" ? "area" : "text");
  const [findOpen, setFindOpen] = React.useState(false);
  const [find, setFind] = React.useState<FindCommand | null>(null);
  const [findStatus, setFindStatus] = React.useState<FindStatus>({ count: 0, active: -1, pending: false });

  // A different file is a fresh view: its own tool, no stale find or meta.
  React.useEffect(() => {
    setTool(kind === "image" ? "area" : "text");
    setPageMeta(null);
    setFind(null);
    setFindOpen(false);
  }, [attachment.id, kind]);

  const canFind = kind === "pdf" || kind === "text" || kind === "document";
  const canDrawArea = !!onAsk && (kind === "pdf" || kind === "image");
  const [selection, setSelection] = useTextSelection(bodyRef, !!onAsk && tool === "text");

  // Entering area mode says what to do, once, then gets out of the way — a
  // standing banner over the top of the page would cover the masthead the
  // reader may want to box.
  const [hint, setHint] = React.useState(false);
  React.useEffect(() => {
    if (tool !== "area" || !canDrawArea) {
      setHint(false);
      return;
    }
    setHint(true);
    const t = window.setTimeout(() => setHint(false), 4000);
    return () => window.clearTimeout(t);
  }, [tool, canDrawArea, attachment.id]);

  const onPageCount = React.useCallback((pages: number) => setPageMeta(`${pages} ${pages === 1 ? "page" : "pages"}`), []);
  const onQuery = React.useCallback((query: string) => {
    setFind((prev) => (prev?.query === query ? prev : { query, index: 0, nonce: Date.now() }));
  }, []);
  // From the last REQUESTED index, not the last reported one: Enter held down
  // steps faster than a view can report back, and every press must count.
  // Views wrap the index into range themselves.
  const step = (dir: 1 | -1) => {
    if (!findStatus.count) return;
    setFind((prev) => (prev ? { ...prev, index: prev.index + dir, nonce: prev.nonce + 1 } : prev));
  };
  const closeFind = React.useCallback(() => {
    setFindOpen(false);
    setFind(null);
    clearFindHighlights();
    bodyRef.current?.querySelector<HTMLElement>("[data-document-scroller]")?.focus({ preventScroll: true });
  }, []);

  const domViewReady = kind === "text" || kind === "document";
  useDomFind(bodyRef, domViewReady ? find : null, domViewReady, setFindStatus);

  // Focus the document when it opens, so the keyboard (and Esc) work at once.
  React.useEffect(() => {
    const t = window.setTimeout(() => {
      bodyRef.current?.querySelector<HTMLElement>("[data-document-scroller]")?.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(t);
  }, [attachment.id, pdf.status]);

  const ask = React.useCallback(
    (a: DocumentAsk) => {
      if (!onAsk) return;
      const text = kind === "pdf" ? joinSoftWraps(a.text) : a.text;
      onAsk(attachment, a.kind === "text" ? { ...a, text: clampQuoteText(text) } : { ...a, text });
      window.getSelection()?.removeAllRanges();
      setSelection(null);
    },
    [attachment, kind, onAsk, setSelection],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.key.toLowerCase() === "f" && canFind) {
      e.preventDefault();
      if (findOpen) rootRef.current?.querySelector<HTMLInputElement>('input[aria-label="Find in document"]')?.select();
      else setFindOpen(true);
      return;
    }
    if (e.key === "Escape" && !e.defaultPrevented) {
      if (selection) {
        e.preventDefault();
        window.getSelection()?.removeAllRanges();
        setSelection(null);
      } else if (findOpen) {
        e.preventDefault();
        closeFind();
      } else if (tool === "area" && kind === "pdf") {
        e.preventDefault();
        setTool("text");
      } else if (fullscreen && onToggleFullscreen) {
        e.preventDefault();
        onToggleFullscreen();
      } else {
        e.preventDefault();
        onClose();
      }
    }
  };

  const others = files.filter((f, i, all) => all.findIndex((g) => g.id === f.id) === i);
  const meta = [formatLabelOf(attachment), pageMeta, attachment.size ? formatBytes(attachment.size) : null].filter(Boolean).join(" · ");

  let body: React.ReactNode;
  if (kind === "pdf") {
    body =
      pdf.status === "ready" ? (
        <PdfView
          key={attachment.id}
          doc={pdf.doc}
          tool={tool}
          find={find}
          onFindStatus={setFindStatus}
          onAsk={ask}
          onPageCount={onPageCount}
        />
      ) : pdf.status === "error" ? (
        <ViewerMessage tone="warning" title={PDF_ERRORS[pdf.reason].title} body={PDF_ERRORS[pdf.reason].body} action={<DownloadButton attachment={attachment} />} />
      ) : (
        <ViewerLoading label="Opening the PDF…" progress={pdf.progress} />
      );
  } else if (kind === "image") {
    body = <ImageView key={attachment.id} src={attachment.url} alt={attachment.fileName} tool={canDrawArea ? tool : "text"} onAsk={ask} />;
  } else if (kind === "text") {
    body = <TextView key={attachment.id} url={attachment.url} fileName={attachment.fileName} />;
  } else if (kind === "document") {
    body = <ReaderView key={attachment.id} attachmentId={attachment.id} fileName={attachment.fileName} onMeta={setPageMeta} />;
  } else if (kind === "video") {
    body = (
      <div className="grid min-h-0 flex-1 place-items-center bg-secondary p-6">
        <video src={attachment.url} controls playsInline preload="metadata" className="max-h-full max-w-full rounded-field bg-black shadow-raised" />
      </div>
    );
  } else if (kind === "audio") {
    body = (
      <div className="grid min-h-0 flex-1 place-items-center bg-secondary p-6">
        <audio src={attachment.url} controls preload="metadata" className="w-full max-w-md" />
      </div>
    );
  } else {
    body = (
      <ViewerMessage
        title="There’s no preview for this kind of file."
        body={`${PRODUCT_NAME} can still read it — ask about it in the chat — or download it to open it on your device.`}
        action={<DownloadButton attachment={attachment} />}
      />
    );
  }

  return (
    <div
      ref={rootRef}
      data-document-viewer
      role={fullscreen ? "dialog" : "complementary"}
      aria-modal={fullscreen || undefined}
      aria-label={`${attachment.fileName} — viewer`}
      onKeyDown={onKeyDown}
      className={cn("flex h-full min-h-0 flex-col bg-background", fullscreen && "fixed inset-0 z-modal motion-safe:animate-fade-in")}
    >
      <header className="flex items-center gap-2 border-b border-border/60 bg-card py-2 pl-3 pr-2">
        <FilePreview
          item={{ id: attachment.id, kind: attachment.kind, fileName: attachment.fileName, mimeType: attachment.mimeType, url: attachment.url }}
          className="size-9 shrink-0 rounded-control border border-border/60"
          sizes="36px"
          badge={false}
        />
        <div className="min-w-0 flex-1">
          {others.length > 1 && onSelectFile ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  className="pressable -mx-1 flex max-w-full items-center gap-1 rounded-control px-1 text-left hover:bg-accent data-[state=open]:bg-accent"
                  aria-label={`${attachment.fileName} — switch file`}
                >
                  <h2 className="truncate text-ui font-semibold leading-tight">{attachment.fileName}</h2>
                  <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className={cn(MENU_W, "max-h-[min(22rem,60vh)]")}>
                <DropdownMenuLabel className="font-mono text-caption">Files in this chat</DropdownMenuLabel>
                {others.map((file) => (
                  <DropdownMenuItem key={file.id} onSelect={() => onSelectFile(file)} className="gap-2.5">
                    <span className="grid h-5 min-w-8 shrink-0 place-items-center rounded-xs bg-secondary px-1 font-mono text-micro text-muted-foreground">
                      {extensionOf(file)}
                    </span>
                    <span className={cn("min-w-0 flex-1 truncate", file.id === attachment.id && "font-medium")}>{file.fileName}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <h2 className="truncate text-ui font-semibold leading-tight">{attachment.fileName}</h2>
          )}
          <p className="truncate font-mono text-caption text-muted-foreground">{meta}</p>
        </div>

        {canFind && (
          <HeaderButton label="Find in document" shortcut="⌘F" pressed={findOpen} onClick={() => (findOpen ? closeFind() : setFindOpen(true))}>
            <TextSearch className="size-4" aria-hidden />
          </HeaderButton>
        )}
        {canDrawArea && kind === "pdf" && (
          <HeaderButton
            label={tool === "area" ? "Back to selecting text" : "Select an area — a figure, chart or table"}
            pressed={tool === "area"}
            onClick={() => setTool((t) => (t === "area" ? "text" : "area"))}
          >
            <Crop className="size-4" aria-hidden />
          </HeaderButton>
        )}
        <DownloadButton attachment={attachment} icon />

        <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border/60" />
        {onToggleFullscreen && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onToggleFullscreen}
                aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
                className="hidden text-muted-foreground hover:text-foreground @[50rem]/split:inline-flex"
              >
                <IconSwap swapped={fullscreen} from={<Maximize2 className="size-4" />} to={<Minimize2 className="size-4" />} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</TooltipContent>
          </Tooltip>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close file" className="text-muted-foreground hover:text-foreground">
              <ActionIcons.dismiss className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close</TooltipContent>
        </Tooltip>
      </header>

      {findOpen && canFind && <FindBar status={findStatus} onQuery={onQuery} onStep={step} onClose={closeFind} />}

      {/* The document, verbatim: the interface's auto-translation swaps exact
          catalog strings, and a line of someone's file that happens to read
          "Summary" is not the product's word to translate. */}
      <div ref={bodyRef} data-no-auto-translate className="relative flex min-h-0 flex-1 flex-col">
        {body}
        {hint && (kind === "image" || pdf.status === "ready") && (
          <div className="pointer-events-none absolute inset-x-0 top-3 z-popper flex justify-center px-4" aria-live="polite">
            <p className="surface-float rounded-full px-3 py-1.5 text-caption text-muted-foreground motion-safe:animate-rise-in">
              Drag a box around the part you want to ask about
            </p>
          </div>
        )}
      </div>

      {selection && onAsk && (
        <SelectionToolbar
          selection={selection}
          bounds={bodyRef}
          onAsk={() => ask({ kind: "text", intent: "ask", text: selection.text, location: selection.location })}
          onExplain={() => ask({ kind: "text", intent: "explain", text: selection.text, location: selection.location })}
          onCopy={() => void copyText(selection.text)}
        />
      )}
    </div>
  );
}

function HeaderButton({
  label,
  shortcut,
  pressed,
  onClick,
  children,
}: {
  label: string;
  shortcut?: string;
  pressed?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClick}
          aria-label={label}
          aria-pressed={pressed}
          className={cn("text-muted-foreground hover:text-foreground", pressed && "bg-selected text-foreground")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {shortcut && <span className="ml-2 font-mono text-muted-foreground">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function DownloadButton({ attachment, icon }: { attachment: ClientAttachment; icon?: boolean }) {
  // Same-origin, so `download` names the file — the route's own disposition
  // carries no filename, and the storage key's uuid prefix is not a name.
  if (icon) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild variant="ghost" size="icon-sm" className="text-muted-foreground hover:text-foreground">
            <a href={attachment.url} download={attachment.fileName} aria-label={`Download ${attachment.fileName}`}>
              <ActionIcons.download className="size-4" aria-hidden />
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent>Download</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <Button asChild variant="outline" size="sm" className="gap-1.5">
      <a href={attachment.url} download={attachment.fileName}>
        <ActionIcons.download className="size-3.5" aria-hidden />
        Download
      </a>
    </Button>
  );
}
