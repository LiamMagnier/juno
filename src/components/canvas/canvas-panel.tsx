"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  Check,
  Code2,
  Copy,
  Crosshair,
  Download,
  Eraser,
  Eye,
  FileCode2,
  FileText,
  GitBranch,
  GitCompare,
  Globe,
  History,
  Image as ImageIcon,
  Maximize2,
  MessageCircleQuestion,
  Minimize2,
  Pencil,
  Play,
  RotateCcw,
  RotateCw,
  Terminal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { Markdown } from "@/components/chat/markdown";
import { SandboxFrame, type SandboxElementSelection, type ConsoleEntry, type RunStatus } from "@/components/canvas/sandbox-frame";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { diffLines, unifiedDiff } from "@/lib/line-diff";
import { clampQuoteText, findLineRange, type ComposerQuote } from "@/lib/quote-context";
import { runtimeFor } from "@/lib/artifact-runtime";
import { cn } from "@/lib/utils";
import type { ArtifactType } from "@/lib/message-content";
import type { ClientArtifact } from "@/types/chat";

const EXTENSIONS: Record<string, string> = {
  HTML: "html",
  REACT: "tsx",
  SVG: "svg",
  MARKDOWN: "md",
  MERMAID: "mmd",
  CODE: "txt",
};

const TYPE_ICON: Record<ArtifactType, typeof Code2> = {
  HTML: Globe,
  REACT: Code2,
  CODE: FileCode2,
  SVG: ImageIcon,
  MARKDOWN: FileText,
  MERMAID: GitBranch,
};

// Types whose sandbox carries the element inspector (MERMAID renders opaque SVG).
const INSPECTABLE_LANG = new Set(["html", "tsx", "jsx", "svg", "css"]);

type SelectionBarState = {
  top: number;
  bottom: number;
  left: number;
  width: number;
  text: string;
  source: "preview" | "code";
};

function ConsoleView({ entries, onClear }: { entries: ConsoleEntry[]; onClear: () => void }) {
  const endRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);
  return (
    <div className="flex h-full flex-col bg-[#0b0b0e] text-[#e7e7ea]">
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1.5">
        <Terminal className="h-3.5 w-3.5 text-white/40" />
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">Console</span>
        <span className="ml-auto" />
        <button
          type="button"
          onClick={onClear}
          className="pressable flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] uppercase tracking-wider text-white/40 transition-colors hover:bg-white/10 hover:text-white/80"
        >
          <Eraser className="h-3 w-3" /> Clear
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed">
        {entries.length === 0 ? (
          <p className="text-white/35">No console output yet.</p>
        ) : (
          entries.map((e, i) => (
            <div
              key={i}
              className={cn(
                "whitespace-pre-wrap break-words py-0.5",
                e.level === "error" ? "text-[#f87171]" : e.level === "warn" ? "text-[#fbbf24]" : e.level === "info" ? "text-[#7dd3fc]" : "text-[#e7e7ea]"
              )}
            >
              {e.text}
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

export function CanvasPanel({
  artifact,
  onClose,
  onArtifactUpdated,
  fullscreen,
  onToggleFullscreen,
  onQuote,
}: {
  artifact: ClientArtifact;
  onClose: () => void;
  onArtifactUpdated: (a: ClientArtifact) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onQuote?: (quote: ComposerQuote) => void;
}) {
  const rt = React.useMemo(() => runtimeFor(artifact.type, artifact.language), [artifact.type, artifact.language]);
  const isMarkdown = artifact.type === "MARKDOWN";
  const hasPreview = rt.mode === "web" || rt.mode === "console" || isMarkdown;

  const [tab, setTab] = React.useState<"preview" | "console" | "code">(hasPreview ? "preview" : "code");
  const [selectedVersion, setSelectedVersion] = React.useState(artifact.currentVersion);
  const [copied, setCopied] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [compareTarget, setCompareTarget] = React.useState<number | null>(null);
  const [compareBase, setCompareBase] = React.useState<number | null>(null);
  const [diffCopied, setDiffCopied] = React.useState(false);
  const [restoring, setRestoring] = React.useState(false);
  const [inspecting, setInspecting] = React.useState(false);
  const [selectionBar, setSelectionBar] = React.useState<SelectionBarState | null>(null);
  const [runNonce, setRunNonce] = React.useState(0);
  const [consoleEntries, setConsoleEntries] = React.useState<ConsoleEntry[]>([]);
  const [runStatus, setRunStatus] = React.useState<RunStatus>("idle");
  const previewScrollRef = React.useRef<HTMLDivElement>(null);
  const codeScrollRef = React.useRef<HTMLDivElement>(null);

  const TypeIcon = TYPE_ICON[artifact.type] ?? FileCode2;
  const errorCount = React.useMemo(() => consoleEntries.filter((e) => e.level === "error").length, [consoleEntries]);

  // Reset when a different artifact (or new version) is shown.
  React.useEffect(() => {
    setSelectedVersion(artifact.currentVersion);
    setEditing(false);
    setTab(hasPreview ? "preview" : "code");
    setHistoryOpen(false);
    setCompareTarget(null);
    setCompareBase(null);
    setInspecting(false);
    setSelectionBar(null);
    setConsoleEntries([]);
    setRunStatus("idle");
    setRunNonce(0);
  }, [artifact.id, artifact.currentVersion, artifact.type, hasPreview]);

  // Inspect mode only makes sense on the live preview.
  React.useEffect(() => {
    if (tab !== "preview" || historyOpen) setInspecting(false);
  }, [tab, historyOpen]);

  const versionContent =
    artifact.versions.find((v) => v.version === selectedVersion)?.content ?? artifact.content;
  const isLatest = selectedVersion === artifact.currentVersion;

  const versionBefore = React.useCallback(
    (version: number) => {
      const idx = artifact.versions.findIndex((v) => v.version === version);
      return idx > 0 ? artifact.versions[idx - 1].version : version;
    },
    [artifact.versions]
  );

  const targetVersion = compareTarget ?? artifact.currentVersion;
  const baseVersion = compareBase ?? versionBefore(targetVersion);
  const targetEntry = artifact.versions.find((v) => v.version === targetVersion);
  const targetContent = targetEntry?.content ?? artifact.content;
  const baseContent = artifact.versions.find((v) => v.version === baseVersion)?.content ?? "";

  const diff = React.useMemo(
    () => (historyOpen ? diffLines(baseContent, targetContent) : []),
    [historyOpen, baseContent, targetContent]
  );
  const addedCount = React.useMemo(() => diff.filter((l) => l.type === "added").length, [diff]);
  const removedCount = React.useMemo(() => diff.filter((l) => l.type === "removed").length, [diff]);
  const hasChanges = addedCount > 0 || removedCount > 0;

  const toggleHistory = () => {
    if (historyOpen) {
      setHistoryOpen(false);
      return;
    }
    setCompareTarget(artifact.currentVersion);
    setCompareBase(versionBefore(artifact.currentVersion));
    setHistoryOpen(true);
  };

  const selectTarget = (version: number) => {
    setCompareTarget(version);
    setCompareBase(versionBefore(version));
  };

  const copyDiff = async () => {
    const text = unifiedDiff(baseContent, targetContent, `v${baseVersion}`, `v${targetVersion}`);
    await navigator.clipboard.writeText(text).catch(() => {});
    setDiffCopied(true);
    toast.success("Diff copied");
    setTimeout(() => setDiffCopied(false), 1500);
  };

  const restore = async () => {
    setRestoring(true);
    try {
      const res = await fetch(`/api/artifacts/${artifact.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: targetContent }),
      });
      if (!res.ok) throw new Error("Restore failed");
      const data = await res.json();
      onArtifactUpdated(data.artifact);
      toast.success(`Restored as v${data.artifact.currentVersion}`);
    } catch {
      toast.error("Could not restore this version.");
    } finally {
      setRestoring(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(versionContent).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    const ext = artifact.language || EXTENSIONS[artifact.type] || "txt";
    const blob = new Blob([versionContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${artifact.identifier}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const startEdit = () => {
    setDraft(versionContent);
    setEditing(true);
    setTab("code");
    setHistoryOpen(false);
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/artifacts/${artifact.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: draft }),
      });
      if (!res.ok) throw new Error("Save failed");
      const data = await res.json();
      onArtifactUpdated(data.artifact);
      setEditing(false);
      toast.success("Saved as a new version");
    } catch {
      toast.error("Could not save the artifact.");
    } finally {
      setSaving(false);
    }
  };

  // Re-run / reload the sandbox (console re-executes; web reloads).
  const rerun = React.useCallback(() => {
    setConsoleEntries([]);
    setRunStatus(rt.mode === "console" ? "running" : "idle");
    setRunNonce((n) => n + 1);
    if (rt.mode === "web" && tab === "console") setTab("preview");
  }, [rt.mode, tab]);

  const onConsole = React.useCallback((entry: ConsoleEntry) => {
    setConsoleEntries((prev) => (prev.length > 500 ? [...prev.slice(-400), entry] : [...prev, entry]));
  }, []);

  // ——— Text selection → floating Modify/Ask bar ———

  const captureSelection = React.useCallback(() => {
    if (!onQuote) return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      setSelectionBar(null);
      return;
    }
    const text = sel.toString();
    if (!text.trim()) {
      setSelectionBar(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const anchor = range.commonAncestorContainer;
    const el = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement;
    const source: "preview" | "code" | null = previewScrollRef.current?.contains(el)
      ? "preview"
      : codeScrollRef.current?.contains(el)
        ? "code"
        : null;
    if (!source) {
      setSelectionBar(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) {
      setSelectionBar(null);
      return;
    }
    setSelectionBar({ top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width, text, source });
  }, [onQuote]);

  React.useEffect(() => {
    if (!onQuote) return;
    let timer: number | null = null;
    const onSelectionChange = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(captureSelection, 250);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("selectionchange", onSelectionChange);
      if (timer != null) window.clearTimeout(timer);
    };
  }, [captureSelection, onQuote]);

  React.useEffect(() => {
    if (!selectionBar) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        window.getSelection()?.removeAllRanges();
        setSelectionBar(null);
      }
    };
    const onScroll = () => setSelectionBar(null);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [selectionBar]);

  const quoteSelection = React.useCallback(
    (mode: ComposerQuote["mode"]) => {
      if (!selectionBar || !onQuote) return;
      let lineStart: number | undefined;
      let lineEnd: number | undefined;
      if (selectionBar.source === "code") {
        const lines = findLineRange(versionContent, selectionBar.text);
        if (lines) {
          lineStart = lines.start;
          lineEnd = lines.end;
        }
      }
      onQuote({
        artifactId: artifact.id,
        identifier: artifact.identifier,
        title: artifact.title,
        kind: "text",
        text: clampQuoteText(selectionBar.text),
        lineStart,
        lineEnd,
        mode,
      });
      window.getSelection()?.removeAllRanges();
      setSelectionBar(null);
    },
    [artifact.id, artifact.identifier, artifact.title, onQuote, selectionBar, versionContent]
  );

  const barRef = React.useRef<HTMLDivElement>(null);
  const [barSize, setBarSize] = React.useState<{ w: number; h: number } | null>(null);
  React.useLayoutEffect(() => {
    if (!selectionBar) {
      setBarSize(null);
      return;
    }
    const el = barRef.current;
    if (el) setBarSize({ w: el.offsetWidth, h: el.offsetHeight });
  }, [selectionBar]);

  let barStyle: React.CSSProperties | undefined;
  if (selectionBar && typeof window !== "undefined") {
    const margin = 8;
    const w = barSize?.w ?? 172;
    const h = barSize?.h ?? 38;
    const centerX = selectionBar.left + selectionBar.width / 2;
    const left = Math.min(Math.max(centerX - w / 2, margin), Math.max(margin, window.innerWidth - w - margin));
    let top = selectionBar.top - h - margin;
    if (top < margin) top = selectionBar.bottom + margin;
    top = Math.min(top, Math.max(margin, window.innerHeight - h - margin));
    barStyle = { top, left, visibility: barSize ? "visible" : "hidden" };
  }

  // ——— Element inspector (HTML/REACT/SVG/CSS previews) ———

  const canInspect = !!onQuote && rt.mode === "web" && INSPECTABLE_LANG.has(rt.lang) && tab === "preview" && !historyOpen;

  const handleElementSelected = React.useCallback(
    (sel: SandboxElementSelection) => {
      setInspecting(false);
      if (!onQuote || !sel.selector) return;
      onQuote({
        artifactId: artifact.id,
        identifier: artifact.identifier,
        title: artifact.title,
        kind: "element",
        text: clampQuoteText(sel.snippet || sel.text),
        selector: sel.selector,
        mode: "modify",
      });
      toast.success(`Selected <${sel.tag || "element"}> — describe the change`);
    },
    [artifact.id, artifact.identifier, artifact.title, onQuote]
  );

  const exitInspect = React.useCallback(() => setInspecting(false), []);

  React.useEffect(() => {
    if (!inspecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setInspecting(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inspecting]);

  const statusTone =
    runStatus === "error" ? "text-destructive" : runStatus === "done" ? "text-success" : runStatus === "running" || runStatus === "loading" ? "text-source" : "text-muted-foreground";
  const statusLabel =
    runStatus === "error" ? "Error" : runStatus === "done" ? "Done" : runStatus === "running" ? "Running" : runStatus === "loading" ? "Loading" : "";

  const iconBtn = "text-muted-foreground hover:text-foreground";

  return (
    <div
      className={cn(
        "flex h-full flex-col bg-background motion-safe:animate-fade-in",
        fullscreen && "fixed inset-0 z-50 motion-safe:animate-[fade-in-up_220ms_var(--ease-out-soft)_both]"
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/60 bg-card/50 px-3 py-2 backdrop-blur-md">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary shadow-soft ring-1 ring-primary/10">
          <TypeIcon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold leading-tight">{artifact.title}</h2>
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            <span>{rt.label}</span>
            {artifact.versions.length > 1 && (
              <>
                <span aria-hidden>·</span>
                <span>v{artifact.currentVersion}</span>
              </>
            )}
            {rt.mode !== "none" && statusLabel && (
              <>
                <span aria-hidden>·</span>
                <span className={cn("inline-flex items-center gap-1", statusTone)}>
                  <span className={cn("size-1.5 rounded-full bg-current", (runStatus === "running" || runStatus === "loading") && "motion-safe:animate-pulse")} />
                  {statusLabel}
                </span>
              </>
            )}
          </div>
        </div>

        {artifact.versions.length > 1 && (
          <Select value={String(selectedVersion)} onValueChange={(v) => setSelectedVersion(Number(v))}>
            <SelectTrigger className="h-8 w-[120px]" aria-label="Version">
              <span className="truncate">
                Version {selectedVersion}
                {selectedVersion === artifact.currentVersion ? " (latest)" : ""}
              </span>
            </SelectTrigger>
            <SelectContent>
              {[...artifact.versions].reverse().map((v) => (
                <SelectItem key={v.version} value={String(v.version)}>
                  <span className="flex w-full items-baseline justify-between gap-3">
                    <span>
                      Version {v.version}
                      {v.version === artifact.currentVersion ? " (latest)" : ""}
                    </span>
                    <span className="font-mono text-[10px] text-muted-foreground">
                      {timeAgo(v.createdAt)}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <div className="flex items-center gap-0.5">
          {/* Run / Reload */}
          {rt.mode !== "none" && !historyOpen && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={rerun}
                  aria-label={rt.mode === "console" ? "Run" : "Reload preview"}
                  className={cn(iconBtn, "text-primary hover:text-primary")}
                >
                  {rt.mode === "console" ? <Play className="h-4 w-4" /> : <RotateCw className="h-4 w-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent>{rt.mode === "console" ? "Run" : "Reload preview"}</TooltipContent>
            </Tooltip>
          )}
          {canInspect && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setInspecting((v) => !v)}
                  aria-label="Inspect elements"
                  aria-pressed={inspecting}
                  className={cn(iconBtn, "transition-shadow duration-fast ease-out-soft", inspecting && "bg-primary/10 text-primary ring-2 ring-primary/30")}
                >
                  <Crosshair className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{inspecting ? "Exit inspect (Esc)" : "Select an element"}</TooltipContent>
            </Tooltip>
          )}
          {artifact.versions.length > 1 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={toggleHistory}
                  aria-label="Version history"
                  aria-pressed={historyOpen}
                  className={cn(iconBtn, historyOpen && "text-primary")}
                >
                  <History className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{historyOpen ? "Exit history" : "Version history"}</TooltipContent>
            </Tooltip>
          )}
          <span aria-hidden className="mx-0.5 hidden h-5 w-px bg-border/60 sm:block" />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={copy} aria-label="Copy" className={iconBtn}>
                {copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Copy code</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={download} aria-label="Download" className={iconBtn}>
                <Download className="h-4 w-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Download</TooltipContent>
          </Tooltip>
          {isLatest && !editing && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={startEdit} aria-label="Edit" className={iconBtn}>
                  <Pencil className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Edit</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={onToggleFullscreen} aria-label="Fullscreen" className={iconBtn}>
                {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
              </Button>
            </TooltipTrigger>
            <TooltipContent>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</TooltipContent>
          </Tooltip>
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close canvas" className={iconBtn}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* History mode: version rail + diff view */}
      {historyOpen ? (
        <div className="flex min-h-0 flex-1 motion-safe:animate-fade-in">
          <div className="w-44 shrink-0 overflow-y-auto border-r border-border/60 p-2">
            <p className="px-2 pb-2 pt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Versions
            </p>
            <div className="space-y-1">
              {[...artifact.versions].reverse().map((v, i) => {
                const isTarget = v.version === targetVersion;
                const isBase = v.version === baseVersion;
                const isCurrent = v.version === artifact.currentVersion;
                return (
                  <div
                    key={v.version}
                    className={cn(
                      "group flex items-center rounded-md pr-1.5 transition-colors duration-fast ease-out-soft motion-safe:animate-rise-in [animation-fill-mode:backwards]",
                      isTarget ? "bg-primary/10" : "hover:bg-muted/60"
                    )}
                    style={{ animationDelay: `${Math.min(i, 10) * 40}ms` }}
                  >
                    <button type="button" onClick={() => selectTarget(v.version)} className="min-w-0 flex-1 px-2 py-1.5 text-left">
                      <span className="flex items-center gap-1.5">
                        <span className={cn("font-mono text-xs font-medium", isTarget ? "text-primary" : "text-foreground")}>v{v.version}</span>
                        {isCurrent && (
                          <span className="inline-flex items-center rounded-full border border-border/60 bg-background/60 px-1.5 py-px font-mono text-[9px] uppercase tracking-[0.14em] text-muted-foreground">
                            current
                          </span>
                        )}
                      </span>
                      <span className="block text-caption text-muted-foreground">{timeAgo(v.createdAt)}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setCompareBase(v.version)}
                      aria-label={`Compare from v${v.version}`}
                      className={cn(
                        "shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] transition-opacity duration-fast ease-out-soft",
                        isBase
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border/60 text-muted-foreground opacity-0 focus-visible:opacity-100 group-hover:opacity-100 coarse:opacity-100"
                      )}
                    >
                      base
                    </button>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-center gap-2 border-b border-border/60 bg-card/45 px-3 py-2 backdrop-blur-md">
              <GitCompare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">v{baseVersion} -&gt; v{targetVersion}</span>
              <span className="font-mono text-[10px] text-success">+{addedCount}</span>
              <span className="font-mono text-[10px] text-destructive">-{removedCount}</span>
              <div className="flex-1" />
              <Button variant="ghost" size="icon-sm" onClick={() => setHistoryOpen(false)} aria-label="Close history" className={iconBtn}>
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto">
              {hasChanges ? (
                <div className="min-w-max py-2 font-mono text-xs leading-relaxed">
                  {diff.map((line, idx) => (
                    <div
                      key={idx}
                      className={cn(
                        "flex border-l-2",
                        line.type === "added" ? "border-success bg-success/10" : line.type === "removed" ? "border-destructive/70 bg-destructive/10 opacity-80" : "border-transparent"
                      )}
                    >
                      <span className="w-9 shrink-0 select-none pr-1 text-right font-mono text-[10px] leading-relaxed text-muted-foreground/50">{line.aLine ?? ""}</span>
                      <span className="w-9 shrink-0 select-none pr-2 text-right font-mono text-[10px] leading-relaxed text-muted-foreground/50">{line.bLine ?? ""}</span>
                      <span className="whitespace-pre pr-4">{line.text || " "}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center p-6">
                  <div className="field-well rounded-[16px] border border-dashed border-border/50 bg-muted/10 px-10 py-8 text-center motion-safe:animate-rise-in">
                    <GitCompare className="mx-auto h-5 w-5 text-muted-foreground/50" />
                    <p className="mt-3 font-serif text-heading">No changes</p>
                    <p className="mt-1 text-sm text-muted-foreground">v{baseVersion} and v{targetVersion} are identical.</p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-end justify-between gap-2 border-t border-border/60 px-3 py-2">
              <Button variant="ghost" size="sm" onClick={copyDiff}>
                {diffCopied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                Copy diff
              </Button>
              <div className="flex flex-col items-end gap-0.5">
                <Button size="sm" onClick={restore} disabled={restoring || targetVersion === artifact.currentVersion}>
                  <RotateCcw className="h-3.5 w-3.5" />
                  {restoring ? "Restoring…" : `Restore v${targetVersion}`}
                </Button>
                <span className="text-caption text-muted-foreground">Restoring creates a new version</span>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as "preview" | "console" | "code")} className="flex min-h-0 flex-1 flex-col motion-safe:animate-fade-in">
          <div className="flex items-center gap-2 border-b px-3 py-2">
            <TabsList>
              {hasPreview && (
                <TabsTrigger value="preview" className="gap-1.5">
                  {rt.mode === "console" ? <Terminal className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  {rt.mode === "console" ? "Output" : "Preview"}
                </TabsTrigger>
              )}
              {rt.mode === "web" && (
                <TabsTrigger value="console" className="gap-1.5">
                  <Terminal className="h-3.5 w-3.5" />
                  Console
                  {consoleEntries.length > 0 && (
                    <span className={cn("ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[9px]", errorCount ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground")}>
                      {consoleEntries.length}
                    </span>
                  )}
                </TabsTrigger>
              )}
              <TabsTrigger value="code" className="gap-1.5">
                <Code2 className="h-3.5 w-3.5" />
                Code
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="preview" className="min-h-0 flex-1 overflow-hidden">
            {isMarkdown ? (
              <div ref={previewScrollRef} onMouseUp={captureSelection} onKeyUp={captureSelection} className="h-full overflow-auto p-6">
                <Markdown content={versionContent} />
              </div>
            ) : rt.mode === "none" ? (
              <div className="flex h-full items-center justify-center p-8">
                <div className="field-well max-w-sm rounded-panel border border-dashed border-border/50 bg-muted/10 p-8 text-center motion-safe:animate-rise-in">
                  <span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-primary/10 text-primary">
                    <TypeIcon className="h-6 w-6" />
                  </span>
                  <p className="mt-4 font-serif text-heading">{rt.label} preview</p>
                  <p className="mt-1.5 text-sm text-muted-foreground">
                    Running {rt.label} in the browser isn&apos;t supported yet. The full source is on the Code tab — copy or download to run it locally.
                  </p>
                  <div className="mt-4 flex justify-center gap-2">
                    <Button variant="outline" size="sm" onClick={copy}>
                      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />} Copy
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setTab("code")}>
                      <Code2 className="h-3.5 w-3.5" /> View code
                    </Button>
                  </div>
                </div>
              </div>
            ) : (
              <SandboxFrame
                type={artifact.type}
                content={versionContent}
                language={artifact.language}
                runNonce={runNonce}
                mode={rt.mode}
                inspectEnabled={canInspect && inspecting}
                onElementSelected={handleElementSelected}
                onInspectExit={exitInspect}
                onConsole={onConsole}
                onStatus={(s) => setRunStatus(s)}
              />
            )}
          </TabsContent>

          {rt.mode === "web" && (
            <TabsContent value="console" className="min-h-0 flex-1 overflow-hidden">
              <ConsoleView entries={consoleEntries} onClear={() => setConsoleEntries([])} />
            </TabsContent>
          )}

          <TabsContent value="code" className="min-h-0 flex-1 overflow-hidden">
            {editing ? (
              <div className="flex h-full flex-col">
                <textarea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  spellCheck={false}
                  className="field-well flex-1 resize-none bg-muted/40 p-4 font-mono text-xs outline-none"
                />
                <div className="flex justify-end gap-2 border-t p-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                  <Button size="sm" onClick={saveEdit} disabled={saving}>
                    {saving ? "Saving…" : "Save version"}
                  </Button>
                </div>
              </div>
            ) : (
              <div ref={codeScrollRef} onMouseUp={captureSelection} onKeyUp={captureSelection} className="h-full overflow-auto">
                <Markdown content={`\`\`\`${artifact.language ?? ""}\n${versionContent}\n\`\`\``} className="p-4" />
              </div>
            )}
          </TabsContent>
        </Tabs>
      )}

      {/* Floating Modify/Ask bar */}
      {selectionBar &&
        onQuote &&
        createPortal(
          <div
            ref={barRef}
            role="toolbar"
            aria-label="Selection actions"
            style={barStyle}
            onPointerDown={(e) => e.preventDefault()}
            className="fixed z-[70] flex items-center gap-0.5 rounded-[14px] border border-border/70 bg-popover/95 p-1 shadow-float backdrop-blur motion-safe:animate-pop-in"
          >
            <Button type="button" variant="ghost" size="sm" onClick={() => quoteSelection("modify")} className="h-7 gap-1.5 rounded-[10px] px-2.5 coarse:h-10 coarse:px-3.5">
              <Pencil className="h-3.5 w-3.5 text-primary" />
              Modify
            </Button>
            <span aria-hidden className="h-4 w-px bg-border/70" />
            <Button type="button" variant="ghost" size="sm" onClick={() => quoteSelection("ask")} className="h-7 gap-1.5 rounded-[10px] px-2.5 coarse:h-10 coarse:px-3.5">
              <MessageCircleQuestion className="h-3.5 w-3.5 text-primary" />
              Ask
            </Button>
          </div>,
          document.body
        )}
    </div>
  );
}
