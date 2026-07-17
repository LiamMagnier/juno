"use client";

import * as React from "react";
import {
  ArrowUpRight,
  Code2,
  Eye,
  FileCode2,
  FileText,
  GitBranch,
  Globe,
  Image as ImageIcon,
  PanelRightOpen,
  Terminal,
} from "lucide-react";
import { Markdown } from "@/components/chat/markdown";
import { SandboxFrame, type ConsoleEntry, type RunStatus } from "@/components/canvas/sandbox-frame";
import { ThinkingDots } from "@/components/signature/thinking-dots";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

function SourcePreview({ content, language, streaming, className }: { content: string; language: string; streaming?: boolean; className?: string }) {
  // Keep the complete source available in the inline preview. The previous
  // 160-line window made valid artifacts appear truncated and made searching
  // or copying code from the chat impossible.
  const lines = React.useMemo(() => content.replace(/\n$/, "").split("\n"), [content]);

  // Pin the scroll to the write cursor while streaming (the window itself
  // slides, so holding a scroll position would show shifting lines anyway).
  const listRef = React.useRef<HTMLOListElement>(null);
  React.useEffect(() => {
    if (!streaming) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [streaming, content]);

  return (
    <div className={cn("relative h-full min-h-0 overflow-hidden bg-background/50", className)}>
      <ol ref={listRef} className="h-full overflow-auto py-3 font-mono text-[11px] leading-5">
        <li className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-2 px-3 pb-2 text-muted-foreground">
          <span />
          <span className="flex items-center gap-2 text-[11px] uppercase">
            {language || "source"}
            <span className="normal-case tracking-normal text-muted-foreground/65">{lines.length} lines</span>
          </span>
        </li>
        {lines.map((line, index) => (
          <li key={index} className="flex min-w-max gap-2 px-3 pr-6 hover:bg-muted/35">
            <span className="w-[2.75rem] shrink-0 select-none text-right text-muted-foreground/45">{index + 1}</span>
            <code className="whitespace-pre text-foreground/80">{line || " "}</code>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ConsolePreview({ entries }: { entries: ConsoleEntry[] }) {
  return (
    <div className="flex h-full flex-col bg-[#0b0b0e] text-[#e7e7ea]">
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-2">
        <Terminal className="size-3.5 text-white/40" />
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-white/40">Console</span>
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
      <div className="h-full overflow-auto bg-background/70 p-4">
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

/** One geometry for every control in the header's segmented group. */
const SEGMENT_CLASS = "h-7 gap-1.5 rounded-[10px] px-2.5 text-xs font-medium active:scale-[0.97] [&_svg]:size-3.5";

export function ArtifactInlineCard({
  title,
  type,
  language,
  content,
  streaming,
  onOpen,
}: {
  title: string;
  type: ArtifactType;
  language?: string | null;
  content?: string;
  streaming?: boolean;
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
  const lineCount = React.useMemo(
    () => (hasContent ? resolvedContent.replace(/\n$/, "").split("\n").length : 0),
    [hasContent, resolvedContent]
  );

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

  // Identity block: icon tile + title + quiet metadata. When the canvas is
  // available the whole block is a button (a second, larger open target) and an
  // arrow hint rises in on hover as the open affordance.
  const identity = (
    <>
      <span
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-[12px] border border-primary/15 bg-primary/10 text-primary shadow-soft",
          "transition-transform duration-base ease-out-soft",
          onOpen && "group-hover/art:scale-105"
        )}
      >
        <Icon className={cn("size-4", streaming && "motion-safe:animate-icon-breathe")} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-semibold leading-5">{title || "Untitled artifact"}</span>
          {onOpen && (
            <ArrowUpRight
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-primary opacity-0 transition-all duration-base ease-out-soft",
                "translate-y-0.5 group-hover/art:translate-y-0 group-hover/art:opacity-100 group-focus-within/art:translate-y-0 group-focus-within/art:opacity-100"
              )}
            />
          )}
        </span>
        <span className="flex min-w-0 items-center gap-2 pt-0.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
          <span className="truncate">{rt.label}</span>
          {lineCount > 0 && (
            <>
              <span aria-hidden className="size-1 shrink-0 rounded-full bg-border" />
              <span className="shrink-0 normal-case tracking-normal tabular-nums">{lineCount} lines</span>
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
        "group/art my-5 w-full max-w-[820px] overflow-hidden rounded-[22px] border border-border/60 bg-card/55 shadow-soft",
        "transition-[border-color,box-shadow,transform] duration-base ease-out-soft",
        "hover:border-primary/30 hover:shadow-float motion-safe:hover:-translate-y-0.5",
        "motion-safe:animate-rise-in [animation-fill-mode:backwards]"
      )}
    >
      <header className="flex flex-col gap-3 bg-card/70 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between">
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            aria-label={`Open ${title || "artifact"} in canvas`}
            className="-m-1.5 flex min-w-0 flex-1 items-center gap-2.5 rounded-[14px] p-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          >
            {identity}
          </button>
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-2.5">{identity}</span>
        )}

        {/* Views + Open share one segmented group so every control has the same geometry. */}
        <div className="field-well flex shrink-0 items-center self-end rounded-[14px] bg-muted/60 p-1 sm:self-auto">
          <Tabs value={view} onValueChange={(value) => setView(value as ArtifactView)}>
            <TabsList className="h-7 gap-0.5 rounded-none bg-transparent p-0 shadow-none">
              {inlinePreview && (
                <TabsTrigger value="preview" className={SEGMENT_CLASS}>
                  <Eye aria-hidden />
                  Preview
                </TabsTrigger>
              )}
              {hasConsole && (
                <TabsTrigger value="console" className={SEGMENT_CLASS}>
                  <Terminal aria-hidden />
                  Console
                  {consoleEntries.length > 0 && (
                    <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 font-mono text-[9px] text-muted-foreground">
                      {consoleEntries.length}
                    </span>
                  )}
                </TabsTrigger>
              )}
              <TabsTrigger value="code" className={SEGMENT_CLASS}>
                <Code2 aria-hidden />
                Code
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border/70" />
          <button
            type="button"
            onClick={onOpen}
            disabled={!onOpen}
            aria-label="Open in canvas"
            className={cn(
              "pressable inline-flex shrink-0 items-center justify-center whitespace-nowrap text-muted-foreground",
              SEGMENT_CLASS,
              "hover:bg-card hover:text-primary hover:shadow-pop group-hover/art:text-primary",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
              "disabled:pointer-events-none disabled:opacity-40"
            )}
          >
            <PanelRightOpen aria-hidden />
            Open
          </button>
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
        showPreview ? (
          <div className="bg-[hsl(var(--muted)/0.3)] p-2.5 sm:p-3">
            {/* Live preview on a simple hairline-framed pane — the muted mat
                around it makes the white sandbox canvas read intentional. */}
            <div
              className={cn(
                "overflow-hidden rounded-[12px] border border-border/70 shadow-[0_2px_10px_-3px_hsl(var(--foreground)/0.14)]",
                isSandboxPreview ? "bg-white" : "bg-background/70"
              )}
            >
              <div className="h-[min(44vh,360px)] min-h-[240px] overflow-hidden">
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
          </div>
        ) : showConsole ? (
          <div className="h-[min(56vh,560px)] min-h-[280px] overflow-hidden">
            <ConsolePreview entries={consoleEntries} />
          </div>
        ) : (
          <div className="h-[min(44vh,380px)] min-h-[240px] overflow-hidden">
            <SourcePreview content={resolvedContent} language={sourceLanguage} streaming={streaming} />
          </div>
        )
      ) : streaming ? (
        <div className="grid min-h-[260px] place-items-center bg-[linear-gradient(135deg,hsl(var(--primary)/0.08),transparent_45%),hsl(var(--background)/0.42)] p-5">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="flex size-12 items-center justify-center rounded-[14px] border border-primary/25 bg-primary/10 text-primary shadow-soft">
              <ThinkingDots className="text-primary" />
            </span>
            <div>
              <p className="font-serif text-heading">Writing artifact</p>
              <p className="text-sm text-muted-foreground">Preparing source code...</p>
            </div>
          </div>
        </div>
      ) : (
        <div className="grid min-h-[180px] place-items-center bg-background/35 p-5 text-center">
          <div className="max-w-sm">
            <p className="font-serif text-heading">Artifact placeholder</p>
            <p className="pt-1 text-sm leading-6 text-muted-foreground">
              The source was referenced in the message but is not available locally yet.
            </p>
          </div>
        </div>
      )}
    </article>
  );
}
