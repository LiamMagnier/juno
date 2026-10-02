"use client";

import * as React from "react";
import { useParams } from "next/navigation";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Markdown } from "@/components/chat/markdown";
import { CodeSurface } from "@/components/canvas/code-surface";
import { SandboxFrame, rendersStatically } from "@/components/canvas/sandbox-frame";
import { useSandboxProfile } from "@/components/canvas/sandbox-document-frame";
import { AppIcons } from "@/lib/app-icons";
import { runtimeFor } from "@/lib/artifact-runtime";
import { sharedDesignPosterUrl } from "@/lib/design/poster-url";
import type { ArtifactType } from "@/lib/message-content";
import { cn } from "@/lib/utils";

/*
 * Read-only artifact viewer for the public share page. Reuses the canvas
 * sandbox for live HTML/React/SVG/Mermaid previews (opaque-origin iframe, so
 * shared code can't touch the app) plus a Code tab. No editing, no history,
 * no console — the share shows one frozen version.
 *
 * A design is the exception, and has no tabs: it is a picture, not source. Its
 * stored form is a DesignDocument, and a Code tab of that JSON — every inline
 * image a wall of base64 — was the whole of what a visitor used to get (X-20).
 * It shows the server's drawing of its first page instead.
 */

// The framing card: the same `surface-raised-lg` panel every centred card in
// the unauthenticated product is cut from. The recipe carries its own
// hairline and per-theme throw, so nothing is hand-written for dark.
const PANEL = "surface-raised-lg min-h-0 flex-1 overflow-hidden rounded-panel";

export function SharedArtifactViewer({
  type,
  language,
  content,
  version,
  posterUrl,
}: {
  type: ArtifactType;
  language?: string | null;
  content: string;
  version: number;
  /**
   * Where a shared design's picture is. The share page may pass it; when it
   * does not, it is the poster beside the page this viewer is mounted on,
   * `/share/{token}/poster`, read from the route's own token.
   */
  posterUrl?: string;
}) {
  const rt = React.useMemo(() => runtimeFor(type, language), [type, language]);
  // Typed as the share route has it; read defensively, because a viewer
  // mounted anywhere else has no token and should say so, not throw.
  const params = useParams<{ token: string }>();
  const isMarkdown = type === "MARKDOWN";
  // While scripted public previews are off (the `static` profile, the default —
  // see publicShareProfile), only what renders without a script gets a Preview:
  // HTML, SVG and CSS as markup. React and Mermaid are shown as their source.
  const isStatic = useSandboxProfile() === "static";
  const previewOff = !isMarkdown && isStatic && rt.mode === "web" && !rendersStatically(type, language);
  // Console runtimes (JS/Python) aren't executed on public pages — code only.
  const hasPreview = isMarkdown || (rt.mode === "web" && !previewOff);
  const [tab, setTab] = React.useState<"preview" | "code">(hasPreview ? "preview" : "code");

  if (type === "DESIGN") {
    const token = typeof params?.token === "string" ? params.token : null;
    return (
      <SharedDesignPoster src={posterUrl ?? (token ? sharedDesignPosterUrl(token) : null)} label={rt.label} version={version} />
    );
  }

  return (
    <Tabs value={tab} onValueChange={(v) => setTab(v as "preview" | "code")} className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 pb-3">
        {/* No `h-8` override. TabsList is h-9 with p-1, and its triggers are
            `py-1` around a 20px line — 28px of content that needs a 36px shell.
            Forcing the track to 32px left 24px of slot, so both triggers hung
            2px past the top and bottom of the well they are supposed to sit in,
            on the one tab row a visitor sees before signing up. It also put this
            row at a height no other TabsList in the product uses. */}
        <TabsList>
          {hasPreview && <TabsTrigger value="preview">Preview</TabsTrigger>}
          <TabsTrigger value="code">Code</TabsTrigger>
        </TabsList>
        {previewOff && (
          <span className="min-w-0 truncate text-caption text-muted-foreground">
            Live previews are off on shared links for now.
          </span>
        )}
        <KindLabel label={rt.label} version={version} />
      </div>

      {hasPreview && (
        <TabsContent value="preview" className={PANEL}>
          {isMarkdown ? (
            <div className="h-full overflow-auto px-6 py-8">
              {/* The product's reading measure (ui/app-page.tsx). A shared
                  document is the one artifact a visitor arrives to READ, and
                  full-bleed it set at whatever the window happened to be. */}
              <div className="mx-auto w-full max-w-3xl">
                <Markdown content={content} />
              </div>
            </div>
          ) : (
            <SandboxFrame type={type} content={content} language={language} mode={rt.mode} />
          )}
        </TabsContent>
      )}

      <TabsContent value="code" className={PANEL}>
        <CodeSurface value={content} language={rt.lang || language} readOnly wrap={isMarkdown} ariaLabel="Artifact source" />
      </TabsContent>
    </Tabs>
  );
}

/** The kind and, past the first, the version: "React · v3". */
function KindLabel({ label, version }: { label: string; version: number }) {
  return (
    <span className="ml-auto shrink-0 font-mono text-caption tabular-nums text-muted-foreground">
      {label}
      {version > 1 ? ` · v${version}` : ""}
    </span>
  );
}

/**
 * A shared design, as its poster.
 *
 * The row above the card keeps the tab row's height (`h-12` less its `pb-3` is
 * the 36px TabsList), so a design's card starts where every other shared
 * artifact's does and a visitor moving between two links sees the frame hold
 * still.
 *
 * `object-contain` on the card's own surface, never cover: a phone screen is
 * tall and the card is wide, and cropping a design to fill it would show a
 * slice as though it were the whole. The picture loads eagerly and first — it
 * is the page, not a tile in a grid, and the lazy loading a tile wants would
 * only hold back the one thing the visitor came for.
 *
 * No fade. The tiles fade their posters in; this one is in the server's HTML,
 * and a picture held at zero opacity until hydration would leave the page blank
 * for anyone whose script is slow, or never arrives. An SVG appears whole once
 * decoded, so there is no painting-down for a fade to hide either.
 *
 * With no poster to be had it shows the design glyph and says so — the one
 * place a type glyph stands in for a picture. Because the image is in the
 * server's HTML it can fail before React is listening for `onError`, so the
 * effect reads the element's own state once mounted as well.
 */
function SharedDesignPoster({ src, label, version }: { src: string | null; label: string; version: number }) {
  const ref = React.useRef<HTMLImageElement>(null);
  // Keyed by URL rather than held as a flag: a failure says nothing about a
  // different picture.
  const [failed, setFailed] = React.useState<string | null>(null);

  React.useEffect(() => {
    const img = ref.current;
    // Complete with no width is a load that already failed. The poster always
    // has an intrinsic size, so a real one never reads as zero here.
    if (img && src && img.complete && img.naturalWidth === 0) setFailed(src);
  }, [src]);

  const Glyph = AppIcons.design;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-12 items-center gap-2 pb-3">
        <KindLabel label={label} version={version} />
      </div>
      <div className={cn(PANEL, "flex items-center justify-center p-4 sm:p-6")}>
        {!src || failed === src ? (
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Glyph className="size-7" aria-hidden />
            <p className="text-caption">Preview unavailable</p>
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- an SVG drawn per request, which the optimiser would only re-encode; image mode is the no-script, no-network sandbox it needs
          <img
            ref={ref}
            src={src}
            alt={`The shared ${label.toLowerCase()}, first page`}
            loading="eager"
            fetchPriority="high"
            decoding="async"
            onError={() => setFailed(src)}
            className="size-full object-contain"
          />
        )}
      </div>
    </div>
  );
}
