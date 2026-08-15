"use client";

import * as React from "react";
import { Code2, FileCode2, GitBranch, Globe, Image as ImageIcon, PanelRightOpen, Terminal } from "lucide-react";
import { AppIcons, CodeIcons, StatusIcons } from "@/lib/app-icons";
import { Markdown } from "@/components/chat/markdown";
import { CodeSurface } from "@/components/canvas/code-surface";
import { SandboxFrame, type ConsoleEntry, type RunStatus } from "@/components/canvas/sandbox-frame";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { runtimeFor } from "@/lib/artifact-runtime";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import type { ArtifactType } from "@/lib/message-content";

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
        <span className="font-mono text-micro uppercase text-muted-foreground">Console</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
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
 * An artifact living inline in the transcript: live preview first (a website
 * runs, a document reads, a program's output streams), with Code and Console a
 * view-switch away, and one labeled action that hands off to the Canvas.
 * The chrome stays quiet — hairline frame, flat header, mono metadata — so the
 * artifact's own content is the visual event, not the card.
 */
export function ArtifactInlineCard({
  title,
  type,
  language,
  content,
  streaming,
  updated,
  version,
  onOpen,
}: {
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
}) {
  const Icon = ICONS[type] ?? FileCode2;
  const rt = runtimeFor(type, language);
  const resolvedContent = content ?? "";
  const hasContent = resolvedContent.trim().length > 0;
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
          "transition-colors duration-base ease-out-soft",
          streaming ? "text-primary" : "text-muted-foreground",
          onOpen && "group-hover/art:border-primary/25 group-hover/art:text-primary"
        )}
      >
        <Icon className={cn("size-4", streaming && "motion-safe:animate-icon-breathe")} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-5">{title || "Untitled artifact"}</span>
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
        "group/art my-5 w-full overflow-hidden rounded-card border border-border/60 bg-card",
        "transition-colors duration-base ease-out-soft hover:border-border",
        "motion-safe:animate-rise-in [animation-fill-mode:backwards]"
      )}
    >
      <header className="flex flex-col gap-2.5 px-3.5 py-2.5 sm:flex-row sm:items-center sm:justify-between">
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

        <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
          {/* View switcher — hidden while streaming (the write-in IS the view). */}
          {!streaming && hasContent && viewOptions.length > 1 && (
            <SegmentedControl
              value={view}
              onChange={setView}
              options={viewOptions}
              ariaLabel="Artifact view"
              className="shrink-0"
              // Keeps the card header's 32px control height; everything else —
              // material, radii, the gliding thumb — is the primitive's.
              optionClassName="h-6 gap-1 px-2.5 text-xs"
            />
          )}
          {onOpen && (
            <>
              <span aria-hidden className="mx-1 hidden h-4 w-px shrink-0 bg-border/70 sm:block" />
              <button
                type="button"
                onClick={onOpen}
                aria-label="Open in canvas"
                className={cn(
                  "pressable inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-control text-muted-foreground",
                  "h-8 gap-1.5 px-2.5 text-xs font-medium coarse:h-10 coarse:px-3",
                  "hover:bg-accent hover:text-primary"
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

      {hasContent ? (
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
                  // Concentric with the card: 14px outer minus the 8px mat is 6,
                  // the `xs` rung. At `field` (10) the white sheet's corners were
                  // cutting outside the card's own bottom corners.
                  isSandboxPreview && "overflow-hidden rounded-xs bg-white ring-1 ring-inset ring-border/70"
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
              <p className="font-serif text-heading">Writing artifact</p>
              <p className="pt-0.5 text-sm text-muted-foreground">The source will stream in here.</p>
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
    </article>
  );
}
