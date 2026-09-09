"use client";

import * as React from "react";
import { Code2, FileCode2, FileText, GitBranch, Globe, Image as ImageIcon, PenTool } from "lucide-react";
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
 * one exception where source and picture are the same object:
 *
 *   SVG renders. An SVG is a picture that happens to be text, and a thumbnail
 *   of a picture is the picture. It goes through an <img> with a data URL
 *   rather than being injected as markup, so the browser treats it as an image:
 *   no script execution, no network, no access to this page — the safety an
 *   iframe would have to be configured into, here by construction.
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
  DESIGN: PenTool,
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

export function ArtifactPreview({
  type,
  preview,
  title,
  className,
}: {
  type: ArtifactType;
  /** The head of the artifact's newest version, or null. */
  preview: string | null;
  title: string;
  className?: string;
}) {
  const Glyph = GLYPHS[type] ?? FileCode2;
  const svg = type === "SVG" && preview ? svgDataUrl(preview) : null;

  const lines = React.useMemo(() => {
    if (!preview || svg) return [];
    return preview.split("\n").slice(0, PREVIEW_LINES);
  }, [preview, svg]);

  return (
    <div className={cn("surface-inset relative isolate overflow-hidden rounded-field", className)}>
      {svg ? (
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
            className="pointer-events-none select-none overflow-hidden p-3 font-mono text-[0.5625rem] leading-[1.45] text-muted-foreground"
          >
            {lines.join("\n")}
          </pre>
          {/* The clip, said out loud. Without it the excerpt ends on a hard
              horizontal edge mid-glyph, which reads as a rendering fault rather
              than as "there is more of this". */}
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-muted to-transparent"
          />
        </>
      ) : (
        <span className="flex size-full items-center justify-center text-muted-foreground">
          <Glyph className="size-7" aria-hidden />
        </span>
      )}
    </div>
  );
}
