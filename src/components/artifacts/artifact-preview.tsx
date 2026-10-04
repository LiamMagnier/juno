"use client";

import * as React from "react";
import { Code2, FileCode2, FileText, GitBranch, Globe, Image as ImageIcon, Table2, Presentation } from "@/components/ui/icons";
import { AppIcons } from "@/lib/app-icons";
import { designPosterUrl } from "@/lib/design/poster-url";
import type { ArtifactType } from "@/lib/message-content";
import { cn } from "@/lib/utils";

/**
 * What an artifact looks like, at tile size.
 *
 * WHY NOT AN IFRAME. The obvious reading of "previews" is a live render, and
 * for a page that can hold two hundred artifacts it is the wrong one: two
 * hundred sandboxed frames, each booting a document and in the React case a
 * bundle, to fill a 200px box the reader will scroll past. It is also the one
 * form of preview that can behave differently from the thing it previews.
 *
 * So a tile shows the artifact's SOURCE, set in the type it is written in, with
 * two exceptions where the source is not what the reader thinks of as the
 * thing:
 *
 *   SVG renders. An SVG is a picture that happens to be text, and a thumbnail
 *   of a picture is the picture. It goes through an <img> with a data URL
 *   rather than being injected as markup, so the browser treats it as an image:
 *   no script execution, no network, no access to this page — the safety an
 *   iframe would have to be configured into, here by construction.
 *
 *   A DESIGN shows its poster. Its source is a DesignDocument, and the first
 *   twenty lines of that are `{"version":2,"pages":[{"id":…` — JSON nobody
 *   drew (X-20, L30). The server renders the design's first page as SVG
 *   (`/api/artifacts/{id}/poster`) and the tile loads it as an <img>, for the
 *   same no-script reason as above. A design never falls through to the source
 *   view: with no id to ask for a poster, or when the poster fails, it shows
 *   its glyph, which is true, rather than its JSON, which is a picture of
 *   nothing.
 *
 *   Everything else is its first twenty lines, monospaced and clipped under a
 *   fade. That reads as what it is — code, a document, a diagram definition —
 *   and it is honest about being an excerpt rather than pretending to be a
 *   screenshot.
 *
 * A tile with nothing to show falls back to the kind glyph, which is what the
 * list row has always used.
 */

const GLYPHS: Record<ArtifactType, typeof Code2> = {
  HTML: Globe,
  REACT: Code2,
  CODE: FileCode2,
  SVG: ImageIcon,
  MARKDOWN: FileText,
  MERMAID: GitBranch,
  DESIGN: AppIcons.design,
  SPREADSHEET: Table2,
  DOCUMENT: FileText,
  PRESENTATION: Presentation,
};

/** Lines of source a tile shows before the fade takes over. */
const PREVIEW_LINES = 20;

/**
 * An SVG source string, as an image the browser can load.
 *
 * `encodeURIComponent` rather than base64: smaller for markup, and it leaves
 * the payload legible in devtools. Anything that is not a complete SVG is
 * rejected rather than handed to the browser to interpret — the preview column
 * is truncated, so a large SVG arrives cut off mid-element and would render as
 * a broken image. That case falls through to the source view, which is a true
 * description of what we have.
 */
function svgDataUrl(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed.startsWith("<svg") && !trimmed.startsWith("<?xml")) return null;
  if (!/<\/svg>\s*$/.test(trimmed)) return null;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(trimmed)}`;
}

/**
 * A design's poster: the server's drawing of its first page, or its glyph.
 *
 * Exported for every surface that shows a design outside its editor — the
 * Artifacts list row's 36px tile, the chat card, the full window's older
 * versions. The caller owns the box — its size, its radius, the recessed
 * surface — and this fills it.
 *
 * `object-contain`, never cover: a phone frame is tall and a tile is wide, and
 * cropping a design to fit would show a slice of it as though it were the
 * whole. The letterbox is the tile's own neutral well.
 *
 * THE FALLBACK IS KEYED BY URL, not held as a plain boolean. A poster that
 * failed for v3 says nothing about v4, and a flag that stayed true would keep a
 * design on its glyph after the version that tripped the renderer was replaced.
 *
 * The picture fades in once it has decoded, on the base rung, rather than
 * painting down the tile as bytes arrive. Under reduced motion it appears.
 *
 * A POSTER IN THE SERVER'S HTML CAN SETTLE BEFORE REACT IS LISTENING. The chat
 * card and the full window are server-rendered, and a cached poster can finish
 * loading — or fail — before hydration attaches `onLoad` and `onError`. Held at
 * zero opacity for an event that has already fired, it would stay invisible
 * for good. So the element's own state is read once it is mounted, as well as
 * listened to. A poster always has an intrinsic size, so a finished image with
 * no width is a failed one.
 */
export function DesignPoster({
  artifactId,
  version,
  alt,
  className,
  glyphClassName = "size-7",
  fallback,
}: {
  artifactId: string;
  /**
   * The version to draw. A version a later one has superseded is cached as
   * immutable; the current one revalidates on every load (a 304 when nothing
   * changed), because edits fold into the current version in place until
   * sealed versions land (see the poster route).
   */
  version?: number;
  /** `""` where a title beside the picture already names it. */
  alt: string;
  className?: string;
  /** The fallback glyph's size: `size-7` in a tile, smaller in a row. */
  glyphClassName?: string;
  /** What stands in when the poster cannot be drawn, in place of the glyph —
   *  for a surface big enough to say why in words. */
  fallback?: React.ReactNode;
}) {
  const src = designPosterUrl(artifactId, version);
  const ref = React.useRef<HTMLImageElement>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState<string | null>(null);

  React.useEffect(() => {
    const img = ref.current;
    if (!img || !img.complete) return;
    if (img.naturalWidth > 0) setLoaded(src);
    else setFailed(src);
  }, [src]);

  if (failed === src) {
    return (
      fallback ?? (
        // `lift`, as on the other fallback glyph below: a host marked
        // `data-icon-trigger` (the Artifacts tile and row) lifts it on hover.
        <span className="flex size-full items-center justify-center text-muted-foreground">
          <GLYPHS.DESIGN className={glyphClassName} motion="lift" aria-hidden />
        </span>
      )
    );
  }

  return (
    // eslint-disable-next-line @next/next/no-img-element -- a same-origin SVG
    // the server draws per version; the optimiser would only re-encode a
    // vector as a bitmap, and image mode is the no-script sandbox it needs.
    <img
      ref={ref}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onLoad={() => setLoaded(src)}
      onError={() => setFailed(src)}
      className={cn(
        "size-full object-contain transition-opacity duration-base ease-out-soft motion-reduce:transition-none",
        loaded === src ? "opacity-100" : "opacity-0",
        className
      )}
    />
  );
}

export function ArtifactPreview({
  type,
  preview,
  title,
  artifactId,
  version,
  className,
}: {
  type: ArtifactType;
  /** The head of the artifact's newest version, or null. Never shown for a design. */
  preview: string | null;
  title: string;
  /**
   * The artifact's id, which a design's poster is fetched by. Without it a
   * design shows its glyph — never its source.
   */
  artifactId?: string;
  /** The version being previewed; pins the poster's URL so it caches. */
  version?: number;
  className?: string;
}) {
  const Glyph = GLYPHS[type] ?? FileCode2;
  const design = type === "DESIGN";
  const svg = type === "SVG" && preview ? svgDataUrl(preview) : null;

  const lines = React.useMemo(() => {
    if (!preview || svg || design) return [];
    // A workbook, document or deck body is model JSON: the glyph, never the source.
    if (type === "SPREADSHEET" || type === "DOCUMENT" || type === "PRESENTATION") return [];
    return preview.split("\n").slice(0, PREVIEW_LINES);
  }, [preview, svg, design, type]);

  return (
    <div className={cn("surface-inset relative isolate overflow-hidden rounded-field", className)}>
      {design && artifactId ? (
        <DesignPoster
          artifactId={artifactId}
          version={version}
          alt={`Preview of ${title || "the design"}`}
          // The SVG branch's inset, so a picture never touches the well's edge
          // and the two kinds of picture sit alike in one grid.
          className="p-3"
        />
      ) : svg ? (
        // eslint-disable-next-line @next/next/no-img-element -- a data: URL of
        // the artifact's own source. There is no remote asset for next/image to
        // optimise, and routing it through the loader would only re-encode it.
        <img
          src={svg}
          alt={`Preview of ${title || "the artifact"}`}
          loading="lazy"
          decoding="async"
          className="size-full object-contain p-3"
        />
      ) : lines.length > 0 ? (
        <>
          <pre
            aria-hidden
            /* `text-micro`, not an arbitrary 9px. Written in rem it slipped past
               `design-system/no-arbitrary-text`, which reads px — and 9px muted
               mono is precisely the size the micro rung was RAISED to 10.5px to
               get away from. `leading-[1.45]` goes with it: the rung sets it. */
            className="pointer-events-none select-none overflow-hidden p-3 font-mono text-micro text-muted-foreground"
          >
            {lines.join("\n")}
          </pre>
          {/* The clip, said out loud. Without it the excerpt ends on a hard
              horizontal edge mid-glyph, which reads as a rendering fault rather
              than as "there is more of this". It fades into `--background`,
              the well's own fill (`.surface-inset`): fading into `--muted`
              laid a darker band along the foot of the tile, a shadow the flat
              recess does not have. */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background to-transparent"
          />
        </>
      ) : (
        // `lift` rather than the glyph's own gesture (most kinds carry none):
        // a host that marks itself `data-icon-trigger` — the Artifacts grid
        // tile — lifts this mark under the pointer instead of lifting the card.
        // A design with no id lands here too, on its glyph rather than its JSON.
        <span className="flex size-full items-center justify-center text-muted-foreground">
          <Glyph className="size-7" motion="lift" aria-hidden />
        </span>
      )}
    </div>
  );
}
