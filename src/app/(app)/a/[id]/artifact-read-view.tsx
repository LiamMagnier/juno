"use client";

/**
 * An artifact in its own window, to look at rather than to edit.
 *
 * `/a/{id}` draws every type that has no editor of its own here, and a
 * design's older versions (the latest one is the design editor). It is the
 * first-light form of the full window (04-MERGE-PLAN.md §6): one header row
 * with the name, the version stepper, one view control and the way back into
 * the chat, then the thing itself across the whole stage. There is no second
 * editor in it on purpose — the canvas panel in the chat is where a page, a
 * doc or code is changed today, and "Open in chat" goes straight there.
 *
 * The header is cut to the design workspace's own geometry (the same row
 * height, gutter and back control), so a design and a page opened from the
 * same Artifacts grid land in the same place on the screen, and the one
 * loading skeleton in loading.tsx stands in for both.
 *
 * Nothing here is keyed by version. Stepping `‹ v3 ›` is a navigation to
 * another `?v=`, and Next keeps this component mounted across it: the view the
 * reader chose (Preview or Source) survives the step, and only the body
 * changes under it.
 */

import { AlevrLockup } from "@/components/brand/alevr-lockup";
import * as React from "react";
import Link from "next/link";
import { ArrowLeft, ChevronLeft, ChevronRight, MessagesSquare } from "@/components/ui/icons";
import { ArtifactLifecycleActions } from "@/components/artifacts/artifact-lifecycle-actions";
import { AppIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Markdown } from "@/components/chat/markdown";
import { CodeSurface } from "@/components/canvas/code-surface";
import { SandboxFrame } from "@/components/canvas/sandbox-frame";
import { DesignPoster } from "@/components/artifacts/artifact-preview";
import { runtimeFor } from "@/lib/artifact-runtime";
import type { ArtifactType } from "@/lib/message-content";
import { ARTIFACT_NOUN, ARTIFACTS_HOME, adjacentVersions, versionPath } from "@/lib/artifact-links";

type View = "preview" | "source";

export function ArtifactReadView({
  id,
  type,
  title,
  language,
  version,
  latest,
  versions,
  content,
  chatHref,
}: {
  id: string;
  type: ArtifactType;
  title: string;
  language: string | null;
  /** The version on screen. */
  version: number;
  /** The artifact's latest version, for the "Viewing an older version" bar. */
  latest: number;
  /** Every stored version number, ascending, for the stepper. */
  versions: number[];
  /** The body of `version`. Empty for a design, which is drawn from its
   *  poster: the document JSON never needs to reach this page. */
  content: string;
  /** The made-in conversation, with its canvas open on this artifact. */
  /** Null when the artifact has no chat to open. */
  chatHref: string | null;
}) {
  const rt = React.useMemo(() => runtimeFor(type, language), [type, language]);
  const isDesign = type === "DESIGN";
  const isMarkdown = type === "MARKDOWN";
  // The same rule as the public share page: a page, a component, an image or a
  // diagram draws in the sandbox, a doc reads as prose, and code that would
  // have to be RUN (JavaScript, Python) is shown rather than executed — running
  // it is the canvas's job, with its console beside it.
  const hasPreview = !isDesign && (isMarkdown || rt.mode === "web");
  const [view, setView] = React.useState<View>(hasPreview ? "preview" : "source");

  const noun = ARTIFACT_NOUN[type] ?? "Artifact";
  const older = version !== latest;
  const { previous, next } = adjacentVersions(versions, version);

  return (
    <div className="alevr-public alevr-owner-read flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {/* `@container/window`: the row collapses by its own width, not the
          window's (PREMIUM rule 11) — beside the app sidebar the header is
          what the sidebar leaves. Under 36rem "Open in chat" keeps its mark
          and its name stays in the accessible label and the tooltip, so the
          title keeps the room it needs to say what this is. */}
      <header className="@container/window flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button asChild variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground hover:text-foreground">
              <Link href={ARTIFACTS_HOME} aria-label="All artifacts">
                <ArrowLeft className="size-4" aria-hidden />
              </Link>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">All artifacts</TooltipContent>
        </Tooltip>

        <Link href="/" aria-label="Alevr home" className="hidden shrink-0 rounded-lg px-2 @[48rem]/window:inline-flex"><AlevrLockup height={22} decorative /></Link>

        {/* The type word first, in muted ink, then the title: "App · Pricing
            table". The noun is what tells a reader arriving from a link what
            kind of thing they are looking at; the title alone does not. */}
        <h1 className="min-w-0 truncate px-1.5 font-serif text-title font-medium" title={`${noun} · ${title}`}>
          <span className="text-muted-foreground">{noun} · </span>
          {title}
        </h1>

        <VersionStepper id={id} version={version} latest={latest} previous={previous} next={next} />

        <div className="flex-1" />
        <ArtifactLifecycleActions id={id} title={title} version={version} latest={latest} />

        {hasPreview && (
          <SegmentedControl
            value={view}
            onChange={setView}
            ariaLabel="View"
            size="sm"
            className="shrink-0"
            optionClassName="text-caption"
            options={[
              { value: "preview", label: "Preview" },
              { value: "source", label: "Source" },
            ]}
          />
        )}

        {/* The one way to change it, so it is the one labelled action on the
            row: the chat is where the canvas, Ask and the model are. */}
        {chatHref && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button asChild variant="ghost" size="sm" className="h-7 shrink-0 gap-1.5 rounded-control px-2 text-caption text-muted-foreground hover:text-foreground">
                <Link href={chatHref} aria-label="Open in chat">
                  <MessagesSquare className="size-3.5" aria-hidden />
                  <span className="hidden @[36rem]/window:inline">Open in chat</span>
                </Link>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Open in the conversation it was made in</TooltipContent>
          </Tooltip>
        )}
      </header>

      {older && (
        // The one bar this window can show today, in the plan's words
        // (Appendix C: "Viewing an older version"). It says which version is
        // on screen and how to leave it; it never offers to change anything,
        // because nothing on this page can. It takes the header's gutter, so
        // the two rows share an edge by construction (PREMIUM rule 8).
        <div className="flex shrink-0 items-center gap-2 border-b border-border/60 bg-card px-3 py-1.5 text-caption text-muted-foreground" role="status">
          <span className="min-w-0 flex-1 truncate">
            Viewing v{version}. The latest is v{latest}.
          </span>
          <Button asChild variant="link" className="h-auto shrink-0 p-0 text-caption">
            <Link href={versionPath(id, latest, latest)}>Back to latest</Link>
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {isDesign ? (
          <DesignPicture id={id} version={version} title={title} />
        ) : view === "preview" && hasPreview ? (
          isMarkdown ? (
            <div className="h-full overflow-auto px-6 py-8">
              {/* The product's reading measure (ui/app-page.tsx): a doc is
                  the one type a reader opens to read, and full-bleed across a
                  whole window it would set at twice the line the eye tracks. */}
              <div className="mx-auto w-full max-w-3xl">
                <Markdown content={content} />
              </div>
            </div>
          ) : (
            <SandboxFrame type={type} content={content} language={language} mode={rt.mode} />
          )
        ) : (
          <CodeSurface
            value={content}
            language={rt.lang || language}
            readOnly
            wrap={isMarkdown}
            ariaLabel={`${title} source, v${version}`}
          />
        )}
      </div>
    </div>
  );
}

/**
 * `‹ v3 ›`: the version on screen, with a step either side.
 *
 * Links rather than buttons, because each step is an address — it can be
 * opened in a new tab, copied, and reached again with Back. A step past either
 * end is drawn but inert, so the number does not slide sideways at the ends of
 * the history. One version needs no stepper at all, and gets just its number.
 */
function VersionStepper({
  id,
  version,
  latest,
  previous,
  next,
}: {
  id: string;
  version: number;
  latest: number;
  previous: number | null;
  next: number | null;
}) {
  const label = <span className="px-0.5 font-mono text-micro tabular-nums text-muted-foreground">v{version}</span>;
  if (previous === null && next === null) return <span className="shrink-0">{label}</span>;

  return (
    <nav aria-label="Versions" className="flex shrink-0 items-center">
      <StepLink href={previous === null ? null : versionPath(id, previous, latest)} label={previous === null ? "No earlier version" : `v${previous}`}>
        <ChevronLeft className="size-3.5" aria-hidden />
      </StepLink>
      {label}
      <StepLink href={next === null ? null : versionPath(id, next, latest)} label={next === null ? "No later version" : `v${next}`}>
        <ChevronRight className="size-3.5" aria-hidden />
      </StepLink>
    </nav>
  );
}

function StepLink({ href, label, children }: { href: string | null; label: string; children: React.ReactNode }) {
  const className = "size-11 shrink-0 text-muted-foreground hover:text-foreground";
  if (href === null) {
    return (
      <Button variant="ghost" size="icon-sm" className={className} disabled aria-label={label}>
        {children}
      </Button>
    );
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button asChild variant="ghost" size="icon-sm" className={className}>
          <Link href={href} aria-label={`Show ${label}`}>
            {children}
          </Link>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * An older version of a design, as the server draws it.
 *
 * The poster is the design's first page rendered by the same renderer the
 * exports use, and a superseded version's poster is cached as immutable, so
 * stepping back through a history re-uses every picture already fetched. It
 * sits on the canvas's own plane, contained rather than cropped: a phone frame
 * and a desktop frame are both shown whole. If it cannot be drawn — a document
 * this build cannot parse — the stage says so with the design's glyph rather
 * than a broken image.
 *
 * The picture is the shared `DesignPoster`, the one every Artifacts tile and
 * chat card draws, so its load and failure states — kept per URL, because this
 * component stays mounted while the stepper walks the history, and read from
 * the element itself when the page's HTML settled before hydration — are one
 * implementation, not two. Only the fallback is this page's: at the size of a
 * whole stage there is room to say why in words.
 */
function DesignPicture({ id, version, title }: { id: string; version: number; title: string }) {
  return (
    <div className="flex size-full items-center justify-center bg-muted/40 p-6">
      <DesignPoster
        artifactId={id}
        version={version}
        alt={`${title}, v${version}`}
        fallback={
          <div className="flex flex-col items-center gap-3 text-center text-muted-foreground" role="status">
            <AppIcons.design className="size-6" aria-hidden />
            <p className="max-w-xs text-caption">This version can’t be drawn here. Its document is unchanged.</p>
          </div>
        }
      />
    </div>
  );
}
