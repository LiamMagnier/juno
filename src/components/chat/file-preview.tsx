"use client";

import * as React from "react";
import Image from "next/image";
import { requiresViewerCredentials } from "@/lib/image-source";
import { cn } from "@/lib/utils";

/* ─────────────────────────────────────────────────────────────────────────────
 * ONE TILE FOR EVERYTHING IN THE LIBRARY.
 *
 * The Library and its picker showed images as thumbnails and everything else as
 * a coral-tinted `FileText` glyph beside a filename. So a grid of eight documents
 * was eight identical icons: the only thing distinguishing one from another was
 * the name, and the name is exactly what a person cannot remember about a file
 * they saved three weeks ago. Images got recognition, files got a label.
 *
 * A file gets the same treatment as an image now — a tile you can recognise:
 *
 *   PDF-ish   the first page, drawn. A document's cover is how it is
 *             recognised, the way an image is recognised by being itself.
 *   text-ish  the first lines of the file, set small, faded out at the bottom
 *             like a page continuing past the frame
 *   other     the extension, large, on the same paper surface
 *
 * The three are a ladder, not a switch, and they are drawn on top of each
 * other in that order: the excerpt (or the extension) paints first and the
 * page image covers it once it arrives. A file whose page cannot be rendered
 * therefore shows the tile it would have shown anyway, with no flash of an
 * empty frame in between, and `onError` puts it back if the render fails.
 *
 * Both come from `/api/attachments/<id>/preview`, one request per tile: a
 * bounded prefix read server-side, plus the address of the page rendering if
 * one is possible. Fetching whole objects to draw six lines would pull a
 * megabyte of CSV through the browser to render its header row.
 * ───────────────────────────────────────────────────────────────────────────── */

export interface PreviewableItem {
  id: string;
  kind: "IMAGE" | "FILE";
  fileName: string;
  mimeType: string;
  url: string;
}

/** The uppercase extension, or a short mime fallback for a name without one. */
export function extensionOf(item: { fileName: string; mimeType: string }): string {
  const dot = item.fileName.lastIndexOf(".");
  if (dot > 0 && dot < item.fileName.length - 1) {
    const raw = item.fileName.slice(dot + 1);
    if (raw.length <= 5 && /^[a-z0-9]+$/i.test(raw)) return raw.toUpperCase();
  }
  const subtype = item.mimeType.split("/")[1] ?? item.mimeType;
  return (subtype.split(/[.+;]/)[0] || "FILE").slice(0, 5).toUpperCase();
}

interface FilePreviewData {
  text: string | null;
  thumbnailUrl: string | null;
}

/**
 * Cached per attachment id for the life of the page.
 *
 * The picker and the Library render the same items, and the picker opens and
 * closes repeatedly over one session. Without this, every open refetches every
 * excerpt — the same bytes, for tiles that have not changed.
 */
const previewCache = new Map<string, FilePreviewData>();

const EMPTY: FilePreviewData = { text: null, thumbnailUrl: null };

function usePreview(item: PreviewableItem, enabled: boolean): FilePreviewData | undefined {
  const [preview, setPreview] = React.useState<FilePreviewData | undefined>(() =>
    previewCache.get(item.id),
  );

  React.useEffect(() => {
    if (!enabled || previewCache.has(item.id)) {
      setPreview(previewCache.get(item.id));
      return;
    }
    const controller = new AbortController();
    fetch(`/api/attachments/${item.id}/preview`, { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { text?: string | null; thumbnailUrl?: string | null } | null) => {
        const data: FilePreviewData = {
          text: typeof body?.text === "string" && body.text.trim() ? body.text : null,
          thumbnailUrl: typeof body?.thumbnailUrl === "string" ? body.thumbnailUrl : null,
        };
        previewCache.set(item.id, data);
        setPreview(data);
      })
      .catch(() => {
        // A failed preview is not an error state — the tile shows its extension,
        // which is what a PDF shows anyway. Cached so it is not retried on every
        // scroll.
        if (!controller.signal.aborted) {
          previewCache.set(item.id, EMPTY);
          setPreview(EMPTY);
        }
      });
    return () => controller.abort();
  }, [item.id, enabled]);

  return preview;
}

export function FilePreview({
  item,
  className,
  sizes = "200px",
  /** Skip the network entirely — for a dense list where tiles are 32px. */
  excerpt: wantsExcerpt = true,
}: {
  item: PreviewableItem;
  className?: string;
  sizes?: string;
  excerpt?: boolean;
}) {
  const [imageFailed, setImageFailed] = React.useState(false);
  const [pageFailed, setPageFailed] = React.useState(false);
  const isImage = item.kind === "IMAGE" && !imageFailed;
  const preview = usePreview(item, wantsExcerpt && !isImage);
  const text = preview?.text;
  const pageUrl = pageFailed ? null : (preview?.thumbnailUrl ?? null);

  if (isImage) {
    return (
      <div className={cn("relative overflow-hidden bg-muted", className)}>
        <Image
          src={item.url}
          unoptimized={requiresViewerCredentials(item.url)}
          alt={item.fileName}
          fill
          sizes={sizes}
          onError={() => setImageFailed(true)}
          className="object-cover"
        />
      </div>
    );
  }

  return (
    <div className={cn("relative overflow-hidden bg-card", className)}>
      {/* The paper the excerpt sits on: a page, not a card. The hairline at the
          top edge is the only chrome, so the content is the thing being seen. */}
      <div className="absolute inset-0 border-t border-border/40" aria-hidden="true" />
      {text ? (
        <pre
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words px-2.5 pt-2.5",
            "font-mono text-micro leading-[1.55] text-foreground/60",
            // The excerpt is a fragment of a longer file, so it dissolves rather
            // than stopping — a hard bottom edge reads as "this is the whole
            // file", which for anything worth previewing it is not.
            "[mask-image:linear-gradient(to_bottom,#000_45%,transparent_100%)]",
          )}
        >
          {text}
        </pre>
      ) : (
        <div className="absolute inset-0 grid place-items-center">
          {/* `text-caption` (the rung this 0.6875rem already was, spelled off-ladder so
    the lint rule could not see it) and no 0.08em: that is CAPS tracking, and
    rule 13 of PREMIUM_AUDIT keeps it for uppercase. The rung carries its own. */}
          <span className="font-mono text-caption font-medium text-muted-foreground/70">
            {extensionOf(item)}
          </span>
        </div>
      )}
      {pageUrl && (
        /*
         * The rendered page, over whatever was drawn above.
         *
         * `object-top`, not `object-cover`'s centred default: a page is read
         * from the top, and a tile that is squarer than A4 must keep the
         * masthead and the title rather than a band from the middle of the
         * body text. A plain <img> rather than next/image — the bytes are
         * already a bounded JPEG from our own route, and putting the optimizer
         * in front of them would re-encode a thumbnail into a thumbnail.
         */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={pageUrl}
          alt=""
          aria-hidden="true"
          loading="lazy"
          decoding="async"
          onError={() => setPageFailed(true)}
          className="absolute inset-0 size-full bg-card object-cover object-top"
        />
      )}
      {/* The extension stays legible over an excerpt: it is how you tell a .ts
          from a .py at a glance, and both look like grey lines from a metre.
          Over a rendered page it does the same job for a second reason — the
          page itself never says what format it is. */}
      {(text || pageUrl) && (
        <span className="absolute bottom-1.5 right-1.5 rounded-xs bg-secondary px-1.5 py-0.5 font-mono text-micro font-medium tracking-[0.06em] text-muted-foreground">
          {/* `bg-secondary`, opaque, at the `xs` rung. The chip was
              `bg-background/85` — the page colour — which lands within a point
              of the --card tile it sits on in BOTH themes, so the one mark that
              tells a .ts from a .py had no plate under it and read straight
              through the excerpt behind it. `rounded-sm` (4px) is off the ladder;
              6px is the rung named for tiny badges. */}
          {extensionOf(item)}
        </span>
      )}
    </div>
  );
}
