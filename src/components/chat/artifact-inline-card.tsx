"use client";

import * as React from "react";
import { Code2, FileCode2, FileText, GitBranch, Globe, Image as ImageIcon, PanelRightOpen, Terminal } from "lucide-react";
import { Markdown } from "@/components/chat/markdown";
import { CodeSurface } from "@/components/canvas/code-surface";
import { SandboxFrame, type ConsoleEntry, type RunStatus } from "@/components/canvas/sandbox-frame";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { runtimeFor } from "@/lib/artifact-runtime";
import { cn } from "@/lib/utils";
import type { ArtifactType } from "@/lib/message-content";

type ArtifactView = "code" | "console" | "preview";

const ICONS: Record<ArtifactType, typeof Code2> = {
  HTML: Globe,
  REACT: Code2,
  CODE: FileCode2,
  SVG: ImageIcon,
  MARKDOWN: FileText,
  MERMAID: GitBranch,
};

function ConsolePreview({ entries }: { entries: ConsoleEntry[] }) {
  return (
    <div className="flex h-full flex-col bg-[#0b0b0e] text-[#e7e7ea]">
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
        <Terminal className="size-3.5 text-white/40" aria-hidden />
        <span className="font-mono text-[10px] text-white/40">Console</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
        {entries.length === 0 ? (
          <p className="text-white/35">No console output yet.</p>
        ) : (
          entries.slice(-80).map((entry, index) => (
            <div
              key={index}
              className={cn(
                "whitespace-pre-wrap break-words py-0.5",
                entry.level === "error"
                  ? "text-[#f87171]"
                  : entry.level === "warn"
                    ? "text-[#fbbf24]"
                    : entry.level === "info"
                      ? "text-[#7dd3fc]"
                      : "text-[#e7e7ea]"
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
    <SandboxFrame
      type={type}
      content={content}
      language={language}
      runNonce={runNonce}
      mode={mode}
      onConsole={onConsole}
      onStatus={onStatus}
      className={cn("h-full w-full border-0", mode === "console" ? "bg-[#0b0b0e]" : "bg-white")}
    />
  );
}

/**
 * Honest segmented control — not Radix Tabs. The switched content lives outside
 * any tabs tree, so real tab semantics would announce panels that don't exist;
 * toggle buttons with aria-pressed describe exactly what this is.
 */
function SegmentButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-[10px] px-2.5 text-xs font-medium",
        "transition-all duration-base ease-out-soft active:scale-[0.97]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "bg-card text-foreground [box-shadow:inset_0_1px_0_hsl(var(--sheen)),var(--shadow-pop)]"
          : "text-muted-foreground hover:text-foreground"
      )}
    >
      {children}
    </button>
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
          "flex size-8 shrink-0 items-center justify-center rounded-[10px] border border-border/60 bg-muted/50",
          "transition-colors duration-base ease-out-soft",
          streaming ? "text-primary" : "text-muted-foreground",
          onOpen && "group-hover/art:border-primary/25 group-hover/art:text-primary"
        )}
      >
        <Icon className={cn("size-4", streaming && "motion-safe:animate-icon-breathe")} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium leading-5">{title || "Untitled artifact"}</span>
        <span className="flex min-w-0 items-center gap-1.5 pt-0.5 font-mono text-[10px] text-muted-foreground">
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
        "group/art my-5 w-full overflow-hidden rounded-[16px] border border-border/60 bg-card/40",
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
            className="-m-1.5 flex min-w-0 flex-1 items-center gap-2.5 rounded-[12px] p-1.5 text-left outline-none transition-colors duration-fast ease-out-soft hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {identity}
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2.5">{identity}</span>
        )}

        <div className="flex shrink-0 items-center gap-1 self-end sm:self-auto">
          {/* View switcher — hidden while streaming (the write-in IS the view). */}
          {!streaming && hasContent && (inlinePreview || hasConsole) && (
            <div role="group" aria-label="Artifact view" className="field-well flex h-8 items-center gap-0.5 rounded-[14px] bg-muted/70 p-0.5">
              {inlinePreview && (
                <SegmentButton active={view === "preview"} onClick={() => setView("preview")}>
                  {rt.mode === "console" ? "Output" : "Preview"}
                </SegmentButton>
              )}
              <SegmentButton active={view === "code"} onClick={() => setView("code")}>
                Code
              </SegmentButton>
              {/* Console earns its place once it has something to say. */}
              {hasConsole && (consoleEntries.length > 0 || view === "console") && (
                <SegmentButton active={view === "console"} onClick={() => setView("console")}>
                  Console
                  <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 font-mono text-[9px] tabular-nums text-muted-foreground">
                    {consoleEntries.length}
                  </span>
                </SegmentButton>
              )}
            </div>
          )}
          {onOpen && (
            <>
              <span aria-hidden className="mx-1 hidden h-4 w-px shrink-0 bg-border/70 sm:block" />
              <button
                type="button"
                onClick={onOpen}
                aria-label="Open in canvas"
                className={cn(
                  "pressable inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-[10px] text-muted-foreground",
                  "h-8 gap-1.5 px-2.5 text-xs font-medium coarse:h-10 coarse:px-3",
                  "hover:bg-accent hover:text-primary",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
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
            <div className={cn("h-full", isSandboxPreview ? "bg-white" : "bg-background/40")}>
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
        <div className="grid min-h-[180px] place-items-center bg-background/40 p-5">
          <div className="flex flex-col items-center gap-3 text-center">
            <ThinkingDots className="text-primary" />
            <div>
              <p className="font-serif text-heading">Writing artifact</p>
              <p className="pt-0.5 text-sm text-muted-foreground">The source will stream in here.</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid min-h-[140px] place-items-center bg-background/40 p-5 text-center">
          <div className="max-w-sm">
            <p className="text-sm font-medium">Source unavailable</p>
            <p className="pt-1 text-sm leading-6 text-muted-foreground">
              This artifact was referenced in the message but its content isn&apos;t available here yet.
            </p>
          </div>
        </div>
      )}
    </article>
  );
}
