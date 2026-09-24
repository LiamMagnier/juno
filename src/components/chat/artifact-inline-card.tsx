"use client";

import * as React from "react";
import nextDynamic from "next/dynamic";
import { toast } from "sonner";
import { Code2, FileCode2, GitBranch, Globe, Image as ImageIcon, PanelRightOpen, Terminal } from "@/components/ui/icons";
import { ActionIcons, AppIcons, CodeIcons, StatusIcons } from "@/lib/app-icons";
import { Markdown } from "@/components/chat/markdown";
import type { ConsoleEntry, RunStatus } from "@/components/canvas/sandbox-frame";

/**
 * Both split, because this card is in the chat bundle and neither of them
 * renders until a message actually carries an artifact.
 *
 * `CodeSurface` is the expensive one: it registers about twenty highlight.js
 * grammars at module scope, so a static import here meant every chat screen
 * downloaded a syntax highlighter for Swift, Kotlin, Rust and the rest before
 * showing its first word. `SandboxFrame` follows it rather than staying behind
 * on its own account — they are the two halves of one card and splitting only
 * one leaves the chunk in place.
 *
 * `ssr: false` on both: the sandbox is an iframe with a srcdoc and the code
 * surface highlights in an effect, so neither contributes anything to the
 * server render, and the types above are imported as types so nothing at
 * runtime follows them.
 */
const CodeSurface = nextDynamic(
  () => import("@/components/canvas/code-surface").then((m) => m.CodeSurface),
  { ssr: false },
);
const SandboxFrame = nextDynamic(
  () => import("@/components/canvas/sandbox-frame").then((m) => m.SandboxFrame),
  { ssr: false },
);
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { runtimeFor } from "@/lib/artifact-runtime";
import { DesignPoster } from "@/components/artifacts/artifact-preview";
import { SuggestionBar } from "@/components/artifacts/suggestion-bar";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { artifactRestoreUrl, placeholderNote, restoredArtifact } from "@/lib/artifact-card-state";
import { cn } from "@/lib/utils";
import type { ArtifactType } from "@/lib/message-content";
import type { ClientArtifact, ClientArtifactSuggestion } from "@/types/chat";

type ArtifactView = "code" | "console" | "preview";

// Three of these stay raw on purpose: they are drawings of an artifact's
// RUNTIME, and the registry's nearest entries mean something else. `Globe` here
// is a web page, not `ComposerIcons.web` (the web-search tool); `GitBranch` is
// the node graph a Mermaid chart draws, not `CodeIcons.branch` (a repository
// ref); and `Code2` pairs with the `FileCode2` below it rather than pointing at
// the Juno Code destination.
const ICONS: Record<ArtifactType, typeof Code2> = {
  HTML: Globe,
  REACT: Code2,
  CODE: FileCode2,
  SVG: ImageIcon,
  MARKDOWN: CodeIcons.file,
  MERMAID: GitBranch,
  DESIGN: AppIcons.design,
};

/**
 * The console readout for an inline artifact. It used to be a private palette —
 * an off-theme shell with `white/40` labels and a `white/5` divider — which put
 * the labels under 4:1 on their own fill, made the divider invisible, and set a
 * cool blue-black against the hue-48 neutral ladder the rest of the transcript
 * runs on. Everything here is now a theme token, so it tracks both themes and
 * inherits the contrast tuning the ladder already passed.
 */
function ConsolePreview({ entries }: { entries: ConsoleEntry[] }) {
  return (
    <div className="flex h-full flex-col bg-card text-card-foreground">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <Terminal className="size-3.5 text-muted-foreground" aria-hidden />
        {/* text-micro carries its own 0.02em tracking — the hand-written 0.08em
            it replaces was above the rung's documented ceiling, where mono caps
            stop grouping into a word. */}
        <span className="font-mono text-micro text-muted-foreground">Console</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-micro leading-relaxed">
        {entries.length === 0 ? (
          <p role="status" className="text-muted-foreground">
            No console output yet.
          </p>
        ) : (
          entries.slice(-80).map((entry, index) => (
            <div
              key={index}
              className={cn(
                "whitespace-pre-wrap break-words py-0.5",
                entry.level === "error"
                  ? "text-destructive"
                  : entry.level === "warn"
                    ? "text-warning"
                    : entry.level === "info"
                      ? "text-source"
                      : "text-foreground"
              )}
            >
              {entry.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function RuntimePreview({
  type,
  content,
  language,
  runNonce,
  mode,
  onStatus,
  onConsole,
}: {
  type: ArtifactType;
  content: string;
  language?: string | null;
  runNonce: number;
  mode: ReturnType<typeof runtimeFor>["mode"];
  onStatus: (status: RunStatus) => void;
  onConsole?: (entry: ConsoleEntry) => void;
}) {
  if (type === "MARKDOWN") {
    return (
      <div className="h-full overflow-auto p-5">
        <Markdown content={content} />
      </div>
    );
  }

  return (
    // No className: the frame's ground belongs to SandboxFrame, whose default
    // is paired with the srcdoc palette it also authors — the fixed dark
    // terminal shell for console runs, the white browser canvas otherwise.
    // Neither is a theme surface, and restating the pairing here is how the
    // same off-theme value ended up hardcoded in two files.
    <SandboxFrame
      type={type}
      content={content}
      language={language}
      runNonce={runNonce}
      mode={mode}
      onConsole={onConsole}
      onStatus={onStatus}
    />
  );
}

/**
 * What the body of a DESIGN card shows (X-20).
 *
 * A design is data, not a program: there is nothing for a sandbox to run, and
 * the old path ran it anyway, so the card's "Preview" was the document's JSON
 * in a `<pre>` with a green "Live" beside it. The picture of a design is the
 * server's render of its first page, which needs the artifact's id and
 * nothing else, so the face follows from what has arrived so far:
 *
 *   "making"   the model is still writing it. The source arriving is JSON and
 *              the row has no version yet (an update's row still holds the
 *              OLD one, whose picture would be a confident preview of what is
 *              being replaced), so the glyph stands in until the turn lands.
 *   "poster"   there is a row: show its picture.
 *   "unsaved"  the block has closed but no row has arrived. Artifacts reach
 *              the client with the finished turn, so this is usually the
 *              moment between the tag closing and the reply ending; it says
 *              what is true in that moment and stays true if no row ever comes.
 *   "missing"  no row and no source: the same failure every other type shows.
 */
export type DesignCardFace = "making" | "poster" | "unsaved" | "missing";

export function designCardFace({
  streaming,
  artifactId,
  hasContent,
}: {
  streaming?: boolean;
  artifactId?: string | null;
  hasContent: boolean;
}): DesignCardFace {
  if (streaming) return "making";
  if (artifactId) return "poster";
  return hasContent ? "unsaved" : "missing";
}

/** The glyph and one line, for every face of a design card that is not its
 *  picture. Static: the header's breathing mark and the hairline's sweep
 *  already say "still writing", and a second moving thing would only compete
 *  with them. */
function DesignNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2.5 px-5 text-center">
      <AppIcons.design className="size-6 text-muted-foreground" motion="none" aria-hidden />
      <p className="text-ui text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * The body of a card whose artifact is in Recently deleted.
 *
 * No preview under it. The canvas will not open a trashed artifact (every
 * route behind it answers 404), so a live sandbox here would be a preview of
 * something the reader cannot reach, running code for nothing. What the card
 * owes the transcript is where the thing went and the way back — the same two
 * facts Artifacts' Recently deleted row gives — at the size of a notice, so a
 * long chat that made something since deleted does not keep a 360px hole for
 * it. The header above still names it.
 */
function TrashedNote({ onRestore, restoring }: { onRestore?: () => void; restoring: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 px-3.5 py-2.5 text-ui text-muted-foreground motion-safe:animate-fade-in">
      <ActionIcons.delete className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">In Recently deleted</span>
      {onRestore && (
        <Button
          variant="outline"
          size="sm"
          onClick={onRestore}
          loading={restoring}
          className="h-7 px-2.5 text-caption"
        >
          <ActionIcons.restore className="size-3.5" aria-hidden />
          Restore
        </Button>
      )}
    </div>
  );
}

/**
 * An artifact living inline in the transcript: live preview first (a website
 * runs, a document reads, a program's output streams, a design shows its
 * picture), with Code and Console a view-switch away for the types that have
 * them, and one labeled action that hands off to the Canvas.
 * The chrome stays quiet — hairline frame, flat header, mono metadata — so the
 * artifact's own content is the visual event, not the card.
 *
 * Three R1 states ride on it, each a strip rather than a second card:
 *   a waiting suggestion, under the header (suggestion-bar.tsx);
 *   Recently deleted, in place of the body;
 *   pictures that became placeholders, as a footnote under the body.
 */
export function ArtifactInlineCard({
  artifactId,
  title,
  type,
  language,
  content,
  streaming,
  updated,
  version,
  onOpen,
  suggestion,
  trashed,
  placeholderCount = 0,
  onArtifactChanged,
}: {
  /** The stored row's id. Absent while the block is still being written, and
   *  until the finished turn delivers its artifacts. A design needs it for its
   *  picture; every other type previews its own source. */
  artifactId?: string | null;
  title: string;
  type: ArtifactType;
  language?: string | null;
  content?: string;
  streaming?: boolean;
  /** True when this message revised an artifact created in an earlier turn. */
  updated?: boolean;
  /** Current version number — shown once the artifact has history (v2+). */
  version?: number;
  onOpen?: () => void;
  /**
   * Juno's held re-emit, when THIS message made it (`cardSuggestion`). The
   * preview keeps showing the current version; the bar says the newer one is
   * waiting and lets the person take it or leave it.
   */
  suggestion?: ClientArtifactSuggestion | null;
  /** The artifact is in Recently deleted: the body becomes the way back. */
  trashed?: boolean;
  /** Pictures verification turned into placeholders in this turn. */
  placeholderCount?: number;
  /**
   * A route changed the artifact from this card (a restore, a suggestion
   * applied or dismissed). Absent where the card cannot report back — a dev
   * gallery — which hides the controls that would need it rather than letting
   * them change the server behind a card that never updates.
   */
  onArtifactChanged?: (artifact: ClientArtifact) => void;
}) {
  const Icon = ICONS[type] ?? FileCode2;
  const rt = runtimeFor(type, language);
  const resolvedContent = content ?? "";
  const hasContent = resolvedContent.trim().length > 0;
  // A design has one view, its picture: no sandbox run, so no "Live", and no
  // Code tab, because its source is JSON, which belongs to the editor and not
  // to the transcript (04-MERGE-PLAN.md §1.2, "JSON never appears by default").
  const isDesign = rt.mode === "design";
  const designFace = isDesign ? designCardFace({ streaming, artifactId, hasContent }) : null;
  const inlinePreview = hasContent && (rt.mode !== "none" || type === "MARKDOWN");
  // Sandbox previews render on a white browser canvas; markdown stays on ours.
  const isSandboxPreview = type !== "MARKDOWN";
  const hasConsole = rt.mode === "web";
  const [view, setView] = React.useState<ArtifactView>(inlinePreview ? "preview" : "code");
  const [runNonce, setRunNonce] = React.useState(0);
  const [consoleEntries, setConsoleEntries] = React.useState<ConsoleEntry[]>([]);
  const [runStatus, setRunStatus] = React.useState<RunStatus>("idle");

  React.useEffect(() => {
    setRunStatus("idle");
    setRunNonce(0);
    setConsoleEntries([]);
  }, [type, language, streaming]);

  React.useEffect(() => {
    if (streaming) {
      setView("code");
    } else {
      setView(inlinePreview ? "preview" : "code");
    }
  }, [streaming, inlinePreview]);

  const showPreview = inlinePreview && view === "preview";
  const showConsole = hasConsole && view === "console";
  const sourceLanguage = rt.lang || language || type.toLowerCase();

  const viewOptions: SegmentedOption<ArtifactView>[] = [
    ...(inlinePreview
      ? [{ value: "preview" as const, label: rt.mode === "console" ? "Output" : "Preview" }]
      : []),
    { value: "code" as const, label: "Code" },
    // Console earns its place once it has something to say.
    ...(hasConsole && (consoleEntries.length > 0 || view === "console")
      ? [
          {
            value: "console" as const,
            label: "Console",
            icon: (
              <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 font-mono text-micro tabular-nums text-muted-foreground">
                {consoleEntries.length}
              </span>
            ),
          },
        ]
      : []),
  ];

  // One quiet status word, cross-faded on change (the span re-mounts via key).
  // "Writing" while the model streams; then whatever the sandbox reports.
  const status: { label: string; tone: string; live?: boolean } | null = streaming
    ? { label: "Writing", tone: "text-primary", live: true }
    : runStatus === "error"
      ? { label: "Error", tone: "text-destructive" }
      : runStatus === "running" || runStatus === "loading"
        ? { label: runStatus === "running" ? "Running" : "Loading", tone: "text-source", live: true }
        : runStatus === "done"
          ? { label: rt.mode === "console" ? "Done" : "Live", tone: "text-success" }
          : null;

  const handleConsole = React.useCallback((entry: ConsoleEntry) => {
    setConsoleEntries((prev) => (prev.length > 150 ? [...prev.slice(-120), entry] : [...prev, entry]));
  }, []);

  // Recently deleted → back. The card turns back into itself when the
  // restored row lands in the chat's list; the toast is for the reader who
  // was not looking at the card when it did (and for a screen reader, which
  // hears nothing from a card changing shape).
  const [restoring, setRestoring] = React.useState(false);
  const canRestore = !!(trashed && artifactId && onArtifactChanged);
  const restore = async () => {
    if (!artifactId || !onArtifactChanged || restoring) return;
    setRestoring(true);
    try {
      const res = await fetch(artifactRestoreUrl(artifactId), { method: "POST" });
      const restored = restoredArtifact(res.status, await res.json().catch(() => null));
      if (!restored) throw new Error("restore failed");
      onArtifactChanged(restored);
      toast.success(`Restored “${title || "artifact"}”.`);
    } catch {
      toast.error("Couldn’t restore this artifact.");
    } finally {
      setRestoring(false);
    }
  };

  // Everything the bar needs, or null: it only shows on a saved, settled,
  // live card that can report the outcome back.
  const waiting =
    suggestion && artifactId && version != null && onArtifactChanged && !streaming && !trashed
      ? { suggestion, artifactId, version, onArtifactChanged }
      : null;
  const placeholders = streaming || trashed ? null : placeholderNote(placeholderCount);

  // Identity block — doubles as a second, larger open target when the canvas
  // is available.
  const identity = (
    <>
      <span
        className={cn(
          // `bg-secondary` is the rung above --card, which is what this tile is
          // meant to be. `bg-muted/50` over the card resolved to ~8% against a
          // 6.5% card — a step and a half, i.e. a tile with no edge but its own.
          // `rounded-field`, not `control`: field is the ladder's icon-tile
          // rung, and control is scoped to buttons and rows.
          "flex size-8 shrink-0 items-center justify-center rounded-field border border-border/60 bg-secondary",
          "transition-colors duration-fast ease-out-soft",
          // Coral only while the source is being WRITTEN — live state. On hover
          // the glyph takes the card's ink like every chrome glyph does; a tile
          // turning accent under the pointer spent the one accent on furniture.
          streaming ? "text-primary" : "text-muted-foreground",
          onOpen && !streaming && "group-hover/art:border-border group-hover/art:text-foreground"
        )}
      >
        <Icon className={cn("size-4", streaming && "motion-safe:animate-icon-breathe")} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate text-ui font-medium leading-5", trashed && "text-muted-foreground")}>
          {title || "Untitled artifact"}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 pt-0.5 font-mono text-micro text-muted-foreground">
          <span className="truncate">{rt.label}</span>
          {!streaming && version != null && version > 1 && (
            <>
              <span aria-hidden className="size-1 shrink-0 rounded-full bg-border" />
              <span className="shrink-0">v{version}</span>
            </>
          )}
          {!streaming && updated && (
            <>
              <span aria-hidden className="size-1 shrink-0 rounded-full bg-border" />
              <span className="shrink-0 text-foreground/60">Updated</span>
            </>
          )}
          {status && (
            <>
              <span aria-hidden className="size-1 shrink-0 rounded-full bg-border" />
              <span
                key={status.label}
                className={cn("inline-flex shrink-0 items-center gap-1 motion-safe:animate-fade-in", status.tone)}
              >
                <span aria-hidden className={cn("size-1.5 rounded-full bg-current", status.live && "motion-safe:animate-pulse")} />
                {status.label}
              </span>
            </>
          )}
        </span>
      </span>
    </>
  );

  return (
    <article
      aria-busy={streaming || undefined}
      className={cn(
        // `bg-card`, not `bg-card/40`. The card sits directly on the transcript
        // ground — true black in dark — so 40% of a 6.5% fill resolved to
        // ~2.6%: an artifact card that was, in dark, a border around the page.
        // `@container`: the header below lays out by the card's own width — it
        // sits in a transcript that can be 412px wide beside a canvas at any
        // window width, and `sm:` was asking the window.
        "@container group/art my-5 w-full overflow-hidden rounded-card border border-border/60 bg-card",
        "transition-colors duration-fast ease-out-soft hover:border-border",
        "motion-safe:animate-rise-in [animation-fill-mode:backwards]"
      )}
    >
      <header className="flex flex-col gap-2.5 px-3.5 py-2.5 @[24rem]:flex-row @[24rem]:items-center @[24rem]:justify-between">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open ${title || "artifact"} in canvas`}
            // No local focus ring: globals.css `:focus-visible` is authoritative,
            // and this header alone used to fork it two ways (ring-ring on the
            // segments, ring-primary/40 here and on Open).
            className="-m-1.5 flex min-w-0 flex-1 items-center gap-2.5 rounded-field p-1.5 text-left transition-colors duration-fast ease-out-soft hover:bg-accent/40"
          >
            {identity}
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2.5">{identity}</span>
        )}

        <div className="flex shrink-0 items-center gap-1 self-end @[24rem]:self-auto">
          {/* View switcher — hidden while streaming (the write-in IS the view). */}
          {!isDesign && !streaming && !trashed && hasContent && viewOptions.length > 1 && (
            <SegmentedControl
              value={view}
              onChange={setView}
              options={viewOptions}
              ariaLabel="Artifact view"
              className="shrink-0"
              // Keeps the card header's 32px control height; everything else —
              // material, radii, the gliding thumb — is the primitive's.
              optionClassName="h-6 gap-1 px-2.5 text-caption"
            />
          )}
          {onOpen && (
            <>
              <span aria-hidden className="mx-1 hidden h-4 w-px shrink-0 bg-border/70 @[24rem]:block" />
              <button
                type="button"
                onClick={onOpen}
                aria-label="Open in canvas"
                className={cn(
                  "pressable inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-control text-muted-foreground",
                  "h-8 gap-1.5 px-2.5 text-caption font-medium coarse:h-10 coarse:px-3",
                  "hover:bg-accent hover:text-foreground"
                )}
              >
                <PanelRightOpen aria-hidden className="size-3.5" />
                Open
              </button>
            </>
          )}
        </div>
      </header>

      {/* Hairline divider doubles as the progress track: a soft primary band
          sweeps across it while the source streams in. */}
      <div aria-hidden className="relative h-px overflow-hidden bg-border/60">
        {streaming && (
          <span className="absolute inset-y-0 left-0 hidden w-1/3 bg-gradient-to-r from-transparent via-primary to-transparent motion-safe:block motion-safe:animate-gen-sweep" />
        )}
      </div>

      {waiting && (
        <SuggestionBar
          variant="card"
          artifactId={waiting.artifactId}
          type={type}
          currentVersion={waiting.version}
          suggestion={waiting.suggestion}
          onResolved={waiting.onArtifactChanged}
        />
      )}

      {trashed ? (
        <TrashedNote onRestore={canRestore ? () => void restore() : undefined} restoring={restoring} />
      ) : designFace && designFace !== "missing" ? (
        /* The same stable height and the same mat as a sandbox preview, so a
           design card does not change size when its picture replaces the
           glyph, and sits in the transcript at the size every other card does.
           The mat is `--background`, the neutral ground a poster is drawn on
           wherever it appears (the Artifacts tiles' well is the same fill);
           there is no white sheet under it, because the poster carries its own
           page fill. The poster is the one the Artifacts grid draws, so a
           design is the same picture, from the same cached URL, in both
           places, and falls back to the same glyph when it will not load.

           The picture is a second, larger way in for a pointer. The header's
           two buttons stay the keyboard's ways in, so this adds no third tab
           stop for the same action. */
        <div
          className={cn(
            "h-[min(44vh,360px)] min-h-[240px] overflow-hidden bg-background p-2",
            designFace === "poster" && onOpen && "cursor-pointer"
          )}
          onClick={designFace === "poster" ? onOpen : undefined}
        >
          {designFace === "poster" && artifactId ? (
            <DesignPoster
              artifactId={artifactId}
              version={version}
              alt={`${title || "Design"}, first page`}
              glyphClassName="size-6"
            />
          ) : designFace === "making" ? (
            <DesignNote>{updated ? "Updating the design" : "Making a design"}</DesignNote>
          ) : (
            <DesignNote>The preview appears once the design is saved.</DesignNote>
          )}
        </div>
      ) : hasContent ? (
        // One stable height across views + a fast cross-fade on switch: the
        // card never jumps, the content quietly trades places.
        <div key={view} className="h-[min(44vh,360px)] min-h-[240px] overflow-hidden motion-safe:animate-fade-in">
          {showPreview ? (
            // The sandbox document still needs a light canvas — it ships its
            // own near-black ink and most artifacts never set a background — but a
            // raw full-bleed white 360px block flashing inside a pure-black
            // transcript is the brightest event on the page. Insetting it turns
            // that bleed into a framed sheet: the transcript's own ground runs
            // to the card edge, and the white is bounded by a hairline.
            //
            // The markdown branch had `bg-background/40` — the page colour, at
            // an opacity that resolves to ~3.9% on black, painted INSIDE a 6.5%
            // card. It read as a hole, and it was pretending to be a surface
            // that does not exist on the ladder. Markdown just reads on the
            // card; only the sandbox keeps its deliberate dark mat above.
            <div className={cn("h-full", isSandboxPreview && "bg-background p-2")}>
              <div
                className={cn(
                  "h-full",
                  // Concentric with the card: `rounded-card` (16) minus the 8px
                  // mat is 8, the `md` rung. This comment used to say "14px
                  // outer minus the 8px mat is 6" and land on `xs` — wrong
                  // twice, since the card is 16 and 16 − 8 is 8. The sheet was
                  // 2px too square against the card's own bottom corners.
                  isSandboxPreview && "overflow-hidden rounded-md bg-white ring-1 ring-inset ring-border/70"
                )}
              >
                <RuntimePreview
                  type={type}
                  content={resolvedContent}
                  language={language}
                  runNonce={runNonce}
                  mode={rt.mode}
                  onStatus={setRunStatus}
                  onConsole={handleConsole}
                />
              </div>
            </div>
          ) : showConsole ? (
            <ConsolePreview entries={consoleEntries} />
          ) : (
            <CodeSurface
              value={resolvedContent}
              language={sourceLanguage}
              readOnly
              streaming={streaming}
              wrap={type === "MARKDOWN"}
              ariaLabel={`${title || "Artifact"} source`}
            />
          )}
        </div>
      ) : streaming ? (
        <div className="grid min-h-[180px] place-items-center p-5">
          <div className="flex flex-col items-center gap-3 text-center">
            <ThinkingDots className="text-primary" />
            <div>
              <p className="font-sans text-heading">Writing artifact</p>
              <p className="pt-0.5 text-ui text-muted-foreground">The source will stream in here.</p>
            </div>
          </div>
        </div>
      ) : (
        /* A failure, not a placeholder. This was the same centred block on the
           same background as the streaming state directly above it, so "the
           source is missing" and "the source is still arriving" were visually
           identical. tone="error" is what makes them different — and it carries
           role="status", which the hand-rolled block never had. */
        <EmptyState
          tone="error"
          size="panel"
          icon={StatusIcons.error}
          title="Source unavailable"
          description="This artifact was referenced in the message but its content isn’t available here yet."
          // Inset rather than full-bleed: the solid destructive border IS the
          // tonal signal, and a full-bleed block would clip it against the card.
          className="m-3 min-h-[140px]"
        />
      )}

      {/* What verification changed without refusing anything: a photo the
          model asked for became a grey box. Said once, under the picture it
          is about, in the footnote register — information, not an error; the
          design saved and is exactly what the card shows. The layer names the
          notes quote stay in the activity log (they are the owner's words);
          the card only needs the count. */}
      {placeholders && (
        <p className="flex items-center gap-1.5 border-t border-border/60 px-3.5 py-2 text-caption text-muted-foreground">
          <StatusIcons.info className="size-3.5 shrink-0" aria-hidden />
          {placeholders}
        </p>
      )}
    </article>
  );
}
