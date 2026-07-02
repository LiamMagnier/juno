"use client";

import * as React from "react";
import {
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

function SourcePreview({ content, language, className }: { content: string; language: string; className?: string }) {
  const { lines, truncated } = React.useMemo(() => {
    const split = content.replace(/\n$/, "").split("\n");
    return { lines: split.slice(0, 160), truncated: split.length > 160 };
  }, [content]);

  return (
    <div className={cn("relative h-full min-h-0 overflow-hidden bg-background/50", className)}>
      <ol className="h-full overflow-auto px-0 py-3 font-mono text-[11px] leading-5">
        <li className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-2 px-3 pb-2 text-muted-foreground">
          <span />
          <span className="text-[11px] uppercase">{language || "source"}</span>
        </li>
        {lines.map((line, index) => (
          <li key={index} className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-2 px-3">
            <span className="select-none text-right text-muted-foreground/45">{index + 1}</span>
            <code className="min-w-0 overflow-hidden text-ellipsis whitespace-pre text-foreground/80">{line || " "}</code>
          </li>
        ))}
      </ol>
      {truncated && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-16 items-end justify-center bg-gradient-to-t from-background/95 to-transparent pb-2">
          <span className="rounded-[9px] border border-border/60 bg-card/90 px-2 py-1 text-[11px] text-muted-foreground shadow-soft">Open the full canvas to continue</span>
        </div>
      )}
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
  // Sandbox previews render on a white browser canvas → frame them as a window.
  const isSandboxPreview = type !== "MARKDOWN";
  const hasConsole = rt.mode === "web";
  const [view, setView] = React.useState<ArtifactView>(inlinePreview ? "preview" : "code");
  const [runNonce, setRunNonce] = React.useState(0);
  const [consoleEntries, setConsoleEntries] = React.useState<ConsoleEntry[]>([]);
  const [runStatus, setRunStatus] = React.useState<RunStatus>("idle");
  const statusTone =
    runStatus === "error"
      ? "text-destructive"
      : runStatus === "done"
        ? "text-success"
        : runStatus === "running" || runStatus === "loading"
          ? "text-source"
          : "text-muted-foreground";

  React.useEffect(() => {
    setRunStatus("idle");
    setRunNonce(0);
    setConsoleEntries([]);
    setView(inlinePreview ? "preview" : "code");
  }, [content, type, language, inlinePreview]);

  const showPreview = inlinePreview && view === "preview";
  const showConsole = hasConsole && view === "console";
  const sourceLanguage = rt.lang || language || type.toLowerCase();

  const handleConsole = React.useCallback((entry: ConsoleEntry) => {
    setConsoleEntries((prev) => (prev.length > 150 ? [...prev.slice(-120), entry] : [...prev, entry]));
  }, []);

  return (
    <article
      aria-busy={streaming || undefined}
      className={cn(
        "group/art my-4 w-full max-w-[760px] overflow-hidden rounded-[16px] border border-border/60 bg-card/35",
        "motion-safe:animate-rise-in [animation-fill-mode:backwards]"
      )}
    >
      <header className="flex flex-col gap-2 border-b border-border/60 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-[10px] bg-primary/10 text-primary">
            <Icon className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold leading-5">{title || "Untitled artifact"}</span>
            <span className="flex items-center gap-2 pt-0.5 text-[11px] text-muted-foreground">
              <span className="font-mono uppercase">{rt.label}</span>
              <span aria-hidden className="size-1 rounded-full bg-border" />
              <span className={cn("inline-flex items-center gap-1", statusTone)}>
                <span
                  aria-hidden
                  className={cn(
                    "size-1.5 rounded-full bg-current",
                    (runStatus === "running" || runStatus === "loading" || streaming) && "motion-safe:animate-pulse"
                  )}
                />
                {streaming ? "writing" : showPreview && runStatus !== "idle" ? runStatus : view}
              </span>
            </span>
          </span>
        </span>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-1.5 self-end sm:self-auto">
          <Tabs value={view} onValueChange={(value) => setView(value as ArtifactView)}>
            <TabsList className="h-10 rounded-[14px] bg-muted/60 p-1">
              {inlinePreview && (
                <TabsTrigger value="preview" className="h-8 gap-1.5 rounded-[14px] px-3 text-[13px]">
                  <Eye className="size-4" aria-hidden />
                  Preview
                </TabsTrigger>
              )}
              {hasConsole && (
                <TabsTrigger value="console" className="h-8 gap-1.5 rounded-[14px] px-3 text-[13px]">
                  <Terminal className="size-4" aria-hidden />
                  Console
                  {consoleEntries.length > 0 && (
                    <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 font-mono text-[9px] text-muted-foreground">
                      {consoleEntries.length}
                    </span>
                  )}
                </TabsTrigger>
              )}
              <TabsTrigger value="code" className="h-8 gap-1.5 rounded-[14px] px-3 text-[13px]">
                <Code2 className="size-4" aria-hidden />
                Code
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <button
            type="button"
            onClick={onOpen}
            disabled={!onOpen}
            aria-label="Open in canvas"
            className={cn(
              "group/open inline-flex h-10 items-center gap-1.5 rounded-[14px] border border-border/70 bg-card px-3.5 text-[13px] font-medium text-foreground/85 shadow-soft",
              "transition-all duration-base ease-out-soft hover:-translate-y-px hover:border-primary/40 hover:text-foreground hover:shadow-[0_4px_14px_-6px_hsl(var(--primary)/0.5)]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              "disabled:pointer-events-none disabled:opacity-40"
            )}
          >
            <PanelRightOpen
              className="size-4 text-muted-foreground transition-colors duration-base ease-out-soft group-hover/open:text-primary"
              aria-hidden
            />
            Open
          </button>
        </div>
      </header>

      {streaming ? (
        <div className="grid min-h-[260px] place-items-center bg-[linear-gradient(135deg,hsl(var(--primary)/0.08),transparent_45%),hsl(var(--background)/0.42)] p-5">
          <div className="flex flex-col items-center gap-3 text-center">
            <span className="flex size-12 items-center justify-center rounded-[14px] border border-primary/25 bg-primary/10 text-primary shadow-soft">
              <ThinkingDots className="text-primary" />
            </span>
            <div>
              <p className="font-serif text-heading">Writing artifact</p>
              <p className="text-sm text-muted-foreground">The preview will appear here when the source is ready.</p>
            </div>
          </div>
        </div>
      ) : hasContent ? (
        showPreview ? (
          <div className="bg-[hsl(var(--muted)/0.3)] p-2.5 sm:p-3">
            {/* Live preview framed as a window so the white canvas reads intentional. */}
            <div className="relative overflow-hidden rounded-[11px] border border-border/70 shadow-[0_2px_10px_-3px_hsl(var(--foreground)/0.14)]">
              {isSandboxPreview && (
                <div className="flex items-center gap-1.5 border-b border-black/[0.06] bg-[#f7f7f8] px-3 py-2">
                  <span className="size-2.5 rounded-full bg-[#ff5f57]" />
                  <span className="size-2.5 rounded-full bg-[#febc2e]" />
                  <span className="size-2.5 rounded-full bg-[#28c840]" />
                  <span className="ml-1.5 truncate font-mono text-[11px] tracking-tight text-black/40">{rt.label.toLowerCase()} preview</span>
                </div>
              )}
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
          <div className="h-[min(44vh,380px)] min-h-[240px] overflow-hidden">
            <ConsolePreview entries={consoleEntries} />
          </div>
        ) : (
          <div className="h-[min(44vh,380px)] min-h-[240px] overflow-hidden">
            <SourcePreview content={resolvedContent} language={sourceLanguage} />
          </div>
        )
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
