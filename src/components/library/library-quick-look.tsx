"use client";

import * as React from "react";
import Link from "next/link";
import { AlertCircle, Download, MessageCircle } from "@/components/ui/icons";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useFilePreview } from "@/components/chat/file-preview";
import { libraryWhen, TypeGlyph } from "@/components/library/library-items";
import { kindLabel, type LibraryItem } from "@/components/library/library-types";
import { cn, formatBytes } from "@/lib/utils";

/*
 * A look at a file without saving it.
 *
 * WHY THIS EXISTS. Every upload that is not a picture is served as
 * `application/octet-stream` with `Content-Disposition: attachment` (a
 * security rule in src/lib/attachment-upload.ts, and it stays): opening one
 * in a new tab only ever downloaded it. The Library showed a miniature and
 * then had nothing between "glance" and "save a copy". This is that step,
 * the way a file manager's Quick Look is: the picture fitted, the words of a
 * text file, the first page of a document the server could render, and an
 * honest sentence for anything else, with Download one press away.
 *
 * A plain click opens it; Cmd/Ctrl/Shift or the middle button still follow
 * the link the old way (`previewOnClick` in library-items.tsx), so nothing
 * anyone relied on went away.
 *
 * TEXT IS READ, NOT RENDERED. The bytes go into a <pre> as a string, never
 * into HTML, so an uploaded .html or .svg shows its source and runs nothing.
 * Only the head of a big file is read (TEXT_LIMIT), and the page says so.
 */

/** How much of a text file the preview reads: enough for any note or script, bounded for a 200 MB CSV. */
const TEXT_LIMIT = 256 * 1024;

const PROSE_EXTENSIONS = new Set(["txt", "md", "markdown", "text", "log"]);
const TEXT_EXTENSIONS = new Set([
  ...PROSE_EXTENSIONS,
  "csv", "tsv", "json", "xml", "yaml", "yml", "toml", "ini", "env",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java", "kt", "swift", "c", "h", "cc",
  "cpp", "hpp", "cs", "php", "sh", "sql", "html", "css", "scss", "vue", "svelte", "lua", "r", "scala",
]);
const TEXT_MIME = /^(text\/|application\/(json|xml|x-yaml|yaml|toml|x-sh|javascript|typescript|sql))/;

function extension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "";
}

type PreviewKind = "image" | "text" | "page";

function previewKind(item: LibraryItem): PreviewKind {
  if (item.kind === "IMAGE") return "image";
  if (TEXT_MIME.test(item.mimeType) || TEXT_EXTENSIONS.has(extension(item.fileName))) return "text";
  return "page";
}

interface TextHead {
  text: string;
  /** The file goes on past what was read. */
  cut: boolean;
}

/** The first TEXT_LIMIT bytes of a file as text, ending on a whole line when it was cut. */
async function readTextHead(url: string, signal: AbortSignal): Promise<TextHead | null> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(String(response.status));
  const chunks: Uint8Array[] = [];
  let size = 0;
  let cut = false;
  if (response.body) {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
      if (size > TEXT_LIMIT) {
        cut = true;
        await reader.cancel().catch(() => {});
        break;
      }
    }
  } else {
    const whole = new Uint8Array(await response.arrayBuffer());
    chunks.push(whole);
    size = whole.byteLength;
    cut = size > TEXT_LIMIT;
  }
  const bytes = new Uint8Array(Math.min(size, TEXT_LIMIT));
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= bytes.length) break;
    const take = Math.min(chunk.byteLength, bytes.length - offset);
    bytes.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  let text = new TextDecoder("utf-8").decode(bytes);
  // A NUL in the opening bytes means this "text" file is really binary.
  if (text.slice(0, 2048).includes("\u0000")) return null;
  if (cut) {
    const lastLine = text.lastIndexOf("\n");
    if (lastLine > 0) text = text.slice(0, lastLine);
  }
  return { text, cut };
}

function useTextHead(item: LibraryItem, enabled: boolean) {
  const [state, setState] = React.useState<{ status: "loading" } | { status: "ready"; head: TextHead } | { status: "binary" } | { status: "failed" }>({
    status: "loading",
  });
  React.useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    readTextHead(item.url, controller.signal)
      .then((head) => setState(head ? { status: "ready", head } : { status: "binary" }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: "failed" });
      });
    return () => controller.abort();
  }, [item.url, enabled]);
  return state;
}

/** The centred sentence the well shows when there is nothing to draw. */
function WellMessage({ item, title, detail, tone = "empty" }: { item: LibraryItem; title: string; detail: string; tone?: "empty" | "error" }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      {tone === "error" ? (
        <AlertCircle className="size-6 text-muted-foreground" aria-hidden="true" />
      ) : (
        <TypeGlyph type={kindLabel(item)} className="size-6" />
      )}
      <div className="max-w-[44ch] space-y-1">
        <p className="text-ui font-medium text-foreground">{title}</p>
        <p className="text-ui text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

function TextSkeleton() {
  return (
    <div className="space-y-3 p-5" role="status" aria-label="Loading the preview">
      {["w-3/4", "w-full", "w-5/6", "w-2/3", "w-full", "w-1/2"].map((width, index) => (
        <Skeleton key={index} className={cn("h-3 rounded-xs", width)} />
      ))}
    </div>
  );
}

function ImageWell({ item }: { item: LibraryItem }) {
  const [failed, setFailed] = React.useState(false);
  if (failed) {
    return <WellMessage item={item} tone="error" title="This picture couldn’t be shown." detail="Download it to open it on your device." />;
  }
  return (
    <div className="grid h-full place-items-center p-4">
      {/* eslint-disable-next-line @next/next/no-img-element -- the file itself, from our own credentialed route, fitted to the well */}
      <img src={item.url} alt={item.fileName} decoding="async" onError={() => setFailed(true)} className="max-h-full max-w-full rounded-control object-contain" />
    </div>
  );
}

function TextWell({ item, onCut }: { item: LibraryItem; onCut: (cut: boolean) => void }) {
  const state = useTextHead(item, true);
  const cut = state.status === "ready" && state.head.cut;
  React.useEffect(() => onCut(cut), [cut, onCut]);
  if (state.status === "loading") return <TextSkeleton />;
  if (state.status === "failed") {
    return <WellMessage item={item} tone="error" title="The preview didn’t load." detail="The file is still in your Library. Download it to open it." />;
  }
  if (state.status === "binary" || !state.head.text.trim()) {
    return <WellMessage item={item} title="There’s no text to show in this file." detail="Download it to open it in the app it was made in." />;
  }
  const prose = PROSE_EXTENSIONS.has(extension(item.fileName)) || /^text\/(plain|markdown)/.test(item.mimeType);
  return (
    // Focusable, so a keyboard can scroll a long file (axe: scrollable-region-focusable).
    <pre
      tabIndex={0}
      aria-label={`Contents of ${item.fileName}`}
      className={cn(
        "h-full overflow-auto p-5 text-foreground outline-none kbd-focus:shadow-[inset_0_0_0_2px_hsl(var(--ring)/0.55)]",
        prose ? "whitespace-pre-wrap break-words font-sans text-body" : "whitespace-pre font-mono text-ui leading-6",
      )}
    >
      {state.head.text}
    </pre>
  );
}

function PageWell({ item }: { item: LibraryItem }) {
  const preview = useFilePreview(item, true);
  const [failed, setFailed] = React.useState(false);
  if (preview === undefined) return <TextSkeleton />;
  if (preview.thumbnailUrl && !failed) {
    return (
      <figure className="flex h-full flex-col items-center justify-center gap-2 p-4">
        {/* eslint-disable-next-line @next/next/no-img-element -- a bounded JPEG of the first page, from our own route */}
        <img
          src={preview.thumbnailUrl}
          alt={`First page of ${item.fileName}`}
          decoding="async"
          onError={() => setFailed(true)}
          className="min-h-0 max-w-full flex-1 rounded-xs bg-white object-contain shadow-[0_0_0_1px_hsl(var(--foreground)/0.08)]"
        />
        <figcaption className="text-caption text-muted-foreground">First page</figcaption>
      </figure>
    );
  }
  return <WellMessage item={item} title="No preview for this kind of file." detail="Download it to open it in the app it was made in." />;
}

function QuickLookBody({ item }: { item: LibraryItem }) {
  const kind = previewKind(item);
  const [cut, setCut] = React.useState(false);
  const when = libraryWhen(item.createdAt);
  return (
    <>
      {/* pr-14: the dialog's close button sits in this corner. */}
      <div className="px-5 pb-4 pr-14 pt-5 sm:px-6 sm:pr-16 sm:pt-6">
        <DialogTitle className="text-pretty [overflow-wrap:anywhere]" translate="no">
          {item.fileName}
        </DialogTitle>
        <DialogDescription className="mt-1 text-ui tabular-nums">
          {[kindLabel(item), formatBytes(item.size), when].filter(Boolean).join(" · ")}
        </DialogDescription>
      </div>
      <div className="surface-inset relative mx-5 h-[min(56dvh,32rem)] overflow-hidden rounded-card sm:mx-6">
        {kind === "image" ? <ImageWell item={item} /> : kind === "text" ? <TextWell item={item} onCut={setCut} /> : <PageWell item={item} />}
      </div>
      {cut ? (
        <p className="mx-5 mt-2 text-caption text-muted-foreground sm:mx-6">Showing the first {formatBytes(TEXT_LIMIT, 0)}. Download the file to read all of it.</p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2 px-5 pb-5 pt-4 sm:px-6 sm:pb-6">
        {item.conversationId ? (
          <Button variant="ghost" size="sm" asChild className="text-muted-foreground">
            <Link href={`/chat/${encodeURIComponent(item.conversationId)}`}>
              <MessageCircle className="size-4" aria-hidden="true" />
              Open the chat
            </Link>
          </Button>
        ) : null}
        <Button size="sm" asChild>
          <a href={item.url} download={item.fileName}>
            <Download className="size-4" aria-hidden="true" />
            Download
          </a>
        </Button>
      </div>
    </>
  );
}

/**
 * The preview dialog. `item` null is closed; the last item stays drawn while
 * the dialog plays its exit, so the panel never empties as it leaves.
 */
export function LibraryQuickLook({ item, onOpenChange }: { item: LibraryItem | null; onOpenChange: (open: boolean) => void }) {
  const [last, setLast] = React.useState<LibraryItem | null>(item);
  React.useEffect(() => {
    if (item) setLast(item);
  }, [item]);
  const shown = item ?? last;
  return (
    <Dialog open={item !== null} onOpenChange={onOpenChange}>
      {shown ? (
        <DialogContent bare className="max-w-3xl gap-0">
          <QuickLookBody key={shown.id} item={shown} />
        </DialogContent>
      ) : null}
    </Dialog>
  );
}
