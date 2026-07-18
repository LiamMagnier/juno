"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  Check,
  Copy,
  Crosshair,
  Download,
  Eraser,
  FileSpreadsheet,
  FileText,
  GitCompare,
  History,
  Loader2,
  Maximize2,
  MessageCircleQuestion,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Play,
  Presentation,
  RotateCcw,
  RotateCw,
  Share2,
  Terminal,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Markdown } from "@/components/chat/markdown";
import { ShareDialog } from "@/components/share/share-dialog";
import { SandboxFrame, type SandboxElementSelection, type ConsoleEntry, type RunStatus } from "@/components/canvas/sandbox-frame";
import { CodeSurface, type CodeSelection } from "@/components/canvas/code-surface";
import { timeAgo } from "@/components/roadmap/roadmap-ui";
import { diffLines, unifiedDiff } from "@/lib/line-diff";
import { clampQuoteText, type ComposerQuote } from "@/lib/quote-context";
import { extensionForLanguage, runtimeFor } from "@/lib/artifact-runtime";
import { cn } from "@/lib/utils";
import type { ClientArtifact, ClientArtifactVersion } from "@/types/chat";

const EXTENSIONS: Record<string, string> = {
  HTML: "html",
  REACT: "tsx",
  SVG: "svg",
  MARKDOWN: "md",
  MERMAID: "mmd",
  CODE: "txt",
};

// Types whose sandbox carries the element inspector (MERMAID renders opaque SVG).
const INSPECTABLE_LANG = new Set(["html", "tsx", "jsx", "svg", "css"]);

type OfficeFormat = "docx" | "xlsx" | "pptx";

const OFFICE_FORMATS: Record<OfficeFormat, { label: string; icon: typeof Copy }> = {
  docx: { label: "Word document (.docx)", icon: FileText },
  xlsx: { label: "Excel workbook (.xlsx)", icon: FileSpreadsheet },
  pptx: { label: "PowerPoint deck (.pptx)", icon: Presentation },
};

function isOfficeFormat(v: unknown): v is OfficeFormat {
  return v === "docx" || v === "xlsx" || v === "pptx";
}

/** Fetching as a blob drops the server's filename, so read it back off the header. */
function fileNameFromDisposition(header: string | null): string | null {
  if (!header) return null;
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (utf8) {
    try {
      return decodeURIComponent(utf8[1]);
    } catch {
      // Malformed encoding — fall back to the ASCII name below.
    }
  }
  const ascii = /filename="([^"]+)"/i.exec(header);
  return ascii?.[1] ?? null;
}

/** "Generated" / "Edited" / "Restored" — how a version came to be. */
function originLabel(origin: ClientArtifactVersion["origin"]): string | null {
  switch (origin) {
    case "generated":
      return "Generated";
    case "edit":
      return "Edited";
    case "restore":
      return "Restored";
    default:
      return null;
  }
}

type SelectionBarState = {
  top: number;
  bottom: number;
  left: number;
  width: number;
  text: string;
  source: "preview" | "code";
  /** Exact 1-based lines, present for code-editor selections. */
  lineStart?: number;
  lineEnd?: number;
};

function ConsoleView({ entries, onClear }: { entries: ConsoleEntry[]; onClear: () => void }) {
  const endRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [entries.length]);
  return (
    <div className="flex h-full flex-col bg-[#0b0b0e] text-[#e7e7ea]">
      <div className="flex items-center gap-2 border-b border-white/5 px-3 py-1.5">
        <Terminal className="h-3.5 w-3.5 text-white/40" aria-hidden />
        <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">Console</span>
        <span className="ml-auto" />
        <button
          type="button"
          onClick={onClear}
          className="pressable flex items-center gap-1 rounded-md px-1.5 py-1 font-mono text-[10px] uppercase tracking-wider text-white/40 transition-colors hover:bg-white/10 hover:text-white/80"
        >
          <Eraser className="h-3 w-3" aria-hidden /> Clear
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
  shareable,
}: {
  artifact: ClientArtifact;
  onClose: () => void;
  onArtifactUpdated: (a: ClientArtifact) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  onQuote?: (quote: ComposerQuote) => void;
  /** Show the Share action — off for incognito artifacts (nothing persisted to share). */
  shareable?: boolean;
}) {
  const rt = React.useMemo(() => runtimeFor(artifact.type, artifact.language), [artifact.type, artifact.language]);
  const isMarkdown = artifact.type === "MARKDOWN";
  // Incognito artifacts are never persisted, so there is no row for the route to export.
  const canExportOffice = isMarkdown && !!shareable;

  const [tab, setTab] = React.useState<"preview" | "console" | "code">("preview");
  const [selectedVersion, setSelectedVersion] = React.useState(artifact.currentVersion);
  const [copied, setCopied] = React.useState(false);
  // Editing is not a mode: the Code tab is always writable on the latest
  // version. `draft` is null while clean; the first keystroke stamps it (and
  // the base version the edit started from, for the stale-write guard).
  const [draft, setDraft] = React.useState<string | null>(null);
  const [editBaseVersion, setEditBaseVersion] = React.useState<number | null>(null);
  const [staleConflict, setStaleConflict] = React.useState<ClientArtifact | null>(null);
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
  const [shareOpen, setShareOpen] = React.useState(false);
  const [officeFormats, setOfficeFormats] = React.useState<OfficeFormat[]>([]);
  const [exportingFormat, setExportingFormat] = React.useState<OfficeFormat | null>(null);
  const previewScrollRef = React.useRef<HTMLDivElement>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);
  // Viewport breakpoints can't see the panel: a 500px canvas on a desktop
  // screen is still "sm:". Contextual-action labels key off the PANEL width.
  const [panelWide, setPanelWide] = React.useState(true);
  // Last version whose preview reached "done" — offered when a newer one fails.
  const lastGoodVersionRef = React.useRef<number | null>(null);

  const errorCount = React.useMemo(() => consoleEntries.filter((e) => e.level === "error").length, [consoleEntries]);

  // Full reset only when a DIFFERENT artifact opens. A new version of the same
  // artifact keeps the user's tab and scroll world stable and just advances the
  // selected version (content cross-fades via the version-keyed container).
  React.useEffect(() => {
    setTab("preview");
    setDraft(null);
    setStaleConflict(null);
    setHistoryOpen(false);
    setCompareTarget(null);
    setCompareBase(null);
    setInspecting(false);
    setSelectionBar(null);
    setConsoleEntries([]);
    setRunStatus("idle");
    setRunNonce(0);
    setShareOpen(false);
    lastGoodVersionRef.current = null;
  }, [artifact.id]);

  React.useEffect(() => {
    setSelectedVersion(artifact.currentVersion);
  }, [artifact.id, artifact.currentVersion]);

  // A version switch swaps the sandbox — the old version's logs and error
  // badge must not bleed into the one now on screen.
  React.useEffect(() => {
    setConsoleEntries([]);
    setRunStatus("idle");
  }, [artifact.id, selectedVersion]);

  // Inspect mode only makes sense on the live preview.
  React.useEffect(() => {
    if (tab !== "preview" || historyOpen) setInspecting(false);
  }, [tab, historyOpen]);

  // A same-identifier regeneration can flip the runtime (HTML → Python keeps
  // the artifact id). If the Console tab vanishes underneath us, fall back to
  // the primary view instead of stranding a blank workspace.
  React.useEffect(() => {
    if (tab === "console" && rt.mode !== "web") setTab("preview");
  }, [tab, rt.mode]);

  React.useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      setPanelWide(width >= 560);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Which Office files this markdown can become is decided server-side: the
  // converters are Node-only, so detection can't run in the browser.
  React.useEffect(() => {
    setOfficeFormats([]);
    if (!canExportOffice) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/artifacts/${artifact.id}/export`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data?.formats)) {
          setOfficeFormats(data.formats.filter(isOfficeFormat));
        }
      } catch {
        // Best-effort — no menu is better than a menu that can't deliver.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [artifact.id, artifact.currentVersion, canExportOffice]);

  const versionContent =
    artifact.versions.find((v) => v.version === selectedVersion)?.content ?? artifact.content;
  const isLatest = selectedVersion === artifact.currentVersion;
  const hasHistory = artifact.versions.length > 1;

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

  const openHistory = React.useCallback(() => {
    setCompareTarget(artifact.currentVersion);
    setCompareBase(versionBefore(artifact.currentVersion));
    setHistoryOpen(true);
  }, [artifact.currentVersion, versionBefore]);

  const toggleHistory = () => {
    if (historyOpen) setHistoryOpen(false);
    else openHistory();
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

  /** Append a version through the API, reporting stale conflicts honestly. */
  const appendVersion = React.useCallback(
    async (content: string, origin: "edit" | "restore", baseVersionForWrite: number | null) => {
      const res = await fetch(`/api/artifacts/${artifact.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          content,
          origin,
          ...(baseVersionForWrite != null ? { baseVersion: baseVersionForWrite } : {}),
        }),
      });
      if (res.status === 409) {
        const data = await res.json().catch(() => null);
        return { stale: true as const, latest: (data?.artifact ?? null) as ClientArtifact | null };
      }
      if (!res.ok) throw new Error("Save failed");
      const data = await res.json();
      return { stale: false as const, artifact: data.artifact as ClientArtifact };
    },
    [artifact.id]
  );

  const restore = async () => {
    setRestoring(true);
    try {
      const result = await appendVersion(targetContent, "restore", artifact.currentVersion);
      if (result.stale) {
        if (result.latest) onArtifactUpdated(result.latest);
        toast.error("The artifact changed since you opened history — review the new version first.");
        return;
      }
      onArtifactUpdated(result.artifact);
      setHistoryOpen(false);
      toast.success(`Restored v${targetVersion} as v${result.artifact.currentVersion}`);
    } catch {
      toast.error("Could not restore this version.");
    } finally {
      setRestoring(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(displayedContent).catch(() => {});
    setCopied(true);
    toast.success("Source copied");
    setTimeout(() => setCopied(false), 1500);
  };

  const download = () => {
    const ext = extensionForLanguage(artifact.language) || EXTENSIONS[artifact.type] || "txt";
    const blob = new Blob([displayedContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${artifact.identifier}.${ext}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const downloadOffice = async (format: OfficeFormat) => {
    setExportingFormat(format);
    try {
      const res = await fetch(`/api/artifacts/${artifact.id}/export?format=${format}`);
      if (!res.ok) {
        const msg = await res
          .json()
          .then((d) => (typeof d?.error === "string" ? d.error : null))
          .catch(() => null);
        throw new Error(msg ?? "Export failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        fileNameFromDisposition(res.headers.get("Content-Disposition")) ??
        `${artifact.identifier}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not build that file.");
    } finally {
      setExportingFormat(null);
    }
  };

  const handleDraftChange = React.useCallback(
    (next: string) => {
      if (selectedVersion !== artifact.currentVersion) return; // read-only view
      // First keystroke of a clean editor stamps the base version the edit
      // started from — the stale-write guard compares against it on save.
      if (draft == null) setEditBaseVersion(artifact.currentVersion);
      setDraft(next);
    },
    [artifact.currentVersion, selectedVersion, draft]
  );

  const discardDraft = React.useCallback(() => {
    setDraft(null);
    setStaleConflict(null);
  }, []);

  // The draft belongs to the LATEST version only. While an older version is on
  // screen the saved content always wins — a read-only view must never render
  // (or save, or copy) the draft it claims not to show.
  const displayedContent = isLatest && draft != null ? draft : versionContent;
  const dirty = isLatest && draft != null && draft !== versionContent;

  const saveEdit = async (force = false) => {
    if (draft == null || saving) return;
    setSaving(true);
    try {
      const result = await appendVersion(draft, "edit", force ? null : editBaseVersion);
      if (result.stale) {
        if (result.latest) setStaleConflict(result.latest);
        else toast.error("Could not save — the artifact may have been deleted.");
        return;
      }
      onArtifactUpdated(result.artifact);
      setDraft(null);
      setStaleConflict(null);
      toast.success(`Saved as v${result.artifact.currentVersion}`);
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

  const handleRunStatus = React.useCallback(
    (status: RunStatus) => {
      setRunStatus(status);
      if (status === "done") lastGoodVersionRef.current = selectedVersion;
    },
    [selectedVersion]
  );

  // ——— Text selection → floating Modify/Ask bar ———

  const captureSelection = React.useCallback(() => {
    if (!onQuote) return;
    // Selections inside the code editor's textarea are reported by CodeSurface
    // (a textarea selection has no DOM Range) — leave its bar alone. Only OUR
    // editor though: focusing the chat composer (also a textarea) must still
    // clear a stale preview bar.
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement && active.dataset.codeSurface != null) return;
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
    const source: "preview" | null = previewScrollRef.current?.contains(el) ? "preview" : null;
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

  const handleCodeSelect = React.useCallback(
    (sel: CodeSelection | null) => {
      if (!onQuote) return;
      if (!sel) {
        setSelectionBar((prev) => (prev?.source === "code" ? null : prev));
        return;
      }
      setSelectionBar({
        top: sel.rect.top,
        bottom: sel.rect.bottom,
        left: sel.rect.left,
        width: sel.rect.width,
        text: sel.text,
        source: "code",
        lineStart: sel.lineStart,
        lineEnd: sel.lineEnd,
      });
    },
    [onQuote]
  );

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
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
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
      const lineStart = selectionBar.source === "code" ? selectionBar.lineStart : undefined;
      const lineEnd = selectionBar.source === "code" ? selectionBar.lineEnd : undefined;
      onQuote({
        artifactId: artifact.id,
        identifier: artifact.identifier,
        title: artifact.title,
        baseVersion: selectedVersion,
        kind: "text",
        text: clampQuoteText(selectionBar.text),
        lineStart,
        lineEnd,
        mode,
      });
      window.getSelection()?.removeAllRanges();
      setSelectionBar(null);
    },
    [artifact.id, artifact.identifier, artifact.title, onQuote, selectedVersion, selectionBar]
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
        baseVersion: selectedVersion,
        kind: "element",
        text: clampQuoteText(sel.snippet || sel.text),
        selector: sel.selector,
        mode: "modify",
      });
      toast.success(`Selected <${sel.tag || "element"}> — describe the change`);
    },
    [artifact.id, artifact.identifier, artifact.title, onQuote, selectedVersion]
  );

  const exitInspect = React.useCallback(() => setInspecting(false), []);

  React.useEffect(() => {
    if (!inspecting) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        setInspecting(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [inspecting]);

  // Fullscreen behaves like the app's other overlays: Escape exits — but only
  // when no nearer layer (selection bar, inspect, a Radix menu) claimed it.
  React.useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) {
        e.preventDefault();
        onToggleFullscreen();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [fullscreen, onToggleFullscreen]);

  // One quiet status word in the header — real state only.
  const status: { label: string; tone: string; live?: boolean } | null = saving
    ? { label: "Saving", tone: "text-source", live: true }
    : runStatus === "error"
      ? { label: "Error", tone: "text-destructive" }
      : runStatus === "running" || runStatus === "loading"
        ? { label: runStatus === "running" ? "Running" : "Loading", tone: "text-source", live: true }
        : runStatus === "done"
          ? { label: rt.mode === "console" ? "Done" : "Live", tone: "text-success" }
          : null;

  const previewFailed = runStatus === "error" && isLatest && !historyOpen;
  // Prefer the last version we actually saw render; on a fresh open of a broken
  // latest, fall back to the previous version so the reader is never stranded.
  const lastGood = lastGoodVersionRef.current ?? (hasHistory ? versionBefore(selectedVersion) : null);
  const canOfferLastGood = previewFailed && lastGood != null && lastGood !== selectedVersion;

  const contextButton =
    "h-7 gap-1.5 rounded-[10px] px-2 text-xs font-medium text-muted-foreground hover:text-foreground coarse:h-9 coarse:px-2.5";

  return (
    <div
      ref={rootRef}
      role={fullscreen ? "dialog" : undefined}
      aria-modal={fullscreen || undefined}
      aria-label={fullscreen ? artifact.title : undefined}
      className={cn("flex h-full flex-col bg-background", fullscreen && "fixed inset-0 z-50 motion-safe:animate-fade-in")}
    >
      {/* ——— Header: identity + one primary action + overflow + window controls ——— */}
      <header className="flex items-center gap-2 border-b border-border/60 bg-card/50 py-2 pl-4 pr-2 backdrop-blur-md">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold leading-tight">{artifact.title}</h2>
          <div className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
            <span className="truncate">{rt.label}</span>
            {hasHistory && (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={toggleHistory}
                  aria-pressed={historyOpen}
                  aria-label="Version history"
                  className={cn(
                    "pressable -mx-1 inline-flex items-center gap-1 rounded-[6px] px-1 py-px coarse:min-h-9 coarse:px-2",
                    historyOpen ? "text-primary" : "hover:bg-accent hover:text-foreground"
                  )}
                >
                  <History className="h-3 w-3" aria-hidden />
                  v{artifact.currentVersion}
                </button>
              </>
            )}
            {status && (
              <>
                <span aria-hidden>·</span>
                <span key={status.label} className={cn("inline-flex items-center gap-1 motion-safe:animate-fade-in", status.tone)}>
                  <span aria-hidden className={cn("size-1.5 rounded-full bg-current", status.live && "motion-safe:animate-pulse")} />
                  {status.label}
                </span>
              </>
            )}
          </div>
        </div>

        {shareable && (
          <Button variant="ghost" size="sm" onClick={() => setShareOpen(true)} className="h-8 gap-1.5 px-2.5 text-muted-foreground hover:text-foreground">
            <Share2 className="h-3.5 w-3.5" aria-hidden />
            Share
          </Button>
        )}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions" className="text-muted-foreground hover:text-foreground">
              {exportingFormat ? <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden /> : <MoreHorizontal className="h-4 w-4" aria-hidden />}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onSelect={copy}>
              <Copy className="h-4 w-4" aria-hidden /> Copy source
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={download}>
              <Download className="h-4 w-4" aria-hidden /> Download source
            </DropdownMenuItem>
            {/* Office export always renders the latest version — don't offer it while an
                older one is on screen, or the file wouldn't match what you're reading. */}
            {officeFormats.length > 0 && isLatest && (
              <>
                <DropdownMenuSeparator />
                {officeFormats.map((f) => {
                  const { label, icon: FormatIcon } = OFFICE_FORMATS[f];
                  const Icon = exportingFormat === f ? Loader2 : FormatIcon;
                  return (
                    <DropdownMenuItem key={f} disabled={exportingFormat !== null} onSelect={() => downloadOffice(f)}>
                      <Icon className={cn("h-4 w-4", exportingFormat === f && "motion-safe:animate-spin")} aria-hidden />
                      {label}
                    </DropdownMenuItem>
                  );
                })}
              </>
            )}
            {hasHistory && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={toggleHistory}>
                  <History className="h-4 w-4" aria-hidden /> {historyOpen ? "Close history" : "Version history"}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        <span aria-hidden className="mx-0.5 h-5 w-px shrink-0 bg-border/60" />

        {/* Fullscreen only matters where the canvas shares the row with chat. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleFullscreen}
              aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              className="hidden text-muted-foreground hover:text-foreground lg:inline-flex"
            >
              {fullscreen ? <Minimize2 className="h-4 w-4" aria-hidden /> : <Maximize2 className="h-4 w-4" aria-hidden />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{fullscreen ? "Exit fullscreen" : "Fullscreen"}</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close canvas" className="text-muted-foreground hover:text-foreground">
          <X className="h-4 w-4" aria-hidden />
        </Button>
      </header>

      {/* ——— History: version rail + diff ——— */}
      {historyOpen ? (
        <div className="flex min-h-0 flex-1 motion-safe:animate-fade-in">
          <div className="flex w-48 shrink-0 flex-col overflow-y-auto border-r border-border/60">
            <p className="px-4 pb-1.5 pt-3 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
              Versions
            </p>
            <div className="space-y-px px-2 pb-2">
              {[...artifact.versions].reverse().map((v) => {
                const isTarget = v.version === targetVersion;
                const isBase = v.version === baseVersion;
                const isCurrent = v.version === artifact.currentVersion;
                const origin = originLabel(v.origin ?? null);
                return (
                  <div
                    key={v.version}
                    className={cn(
                      "group flex items-center rounded-[10px] pr-1.5 transition-colors duration-fast ease-out-soft",
                      isTarget ? "bg-primary/10" : "hover:bg-muted/60"
                    )}
                  >
                    <button type="button" onClick={() => selectTarget(v.version)} className="min-w-0 flex-1 px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary/40 rounded-[8px]">
                      <span className="flex items-baseline gap-1.5">
                        <span className={cn("font-mono text-xs font-medium", isTarget ? "text-primary" : "text-foreground")}>v{v.version}</span>
                        {isCurrent && <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">current</span>}
                      </span>
                      <span className="block pt-px text-caption text-muted-foreground">
                        {origin ? `${origin} · ` : ""}
                        {timeAgo(v.createdAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setCompareBase(v.version)}
                      aria-label={`Compare from v${v.version}`}
                      aria-pressed={isBase}
                      className={cn(
                        "shrink-0 rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.14em] transition-opacity duration-fast ease-out-soft coarse:min-h-9 coarse:px-2.5 coarse:text-[10px]",
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
            <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
              <GitCompare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                v{baseVersion} → v{targetVersion}
              </span>
              {hasChanges && (
                <>
                  <span className="font-mono text-[10px] tabular-nums text-success">+{addedCount}</span>
                  <span className="font-mono text-[10px] tabular-nums text-destructive">−{removedCount}</span>
                </>
              )}
              <div className="flex-1" />
              <Button variant="ghost" size="sm" onClick={copyDiff} className={contextButton}>
                {diffCopied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                Copy diff
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => setHistoryOpen(false)} aria-label="Close history" className="text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </div>

            <div
              key={`${baseVersion}-${targetVersion}`}
              tabIndex={0}
              role="region"
              aria-label={`Changes from v${baseVersion} to v${targetVersion}`}
              className="min-h-0 flex-1 overflow-auto outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 motion-safe:animate-fade-in"
            >
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
                <div className="flex h-full items-center justify-center p-6 text-center">
                  <div>
                    <p className="font-serif text-heading">No changes</p>
                    <p className="pt-1 text-sm text-muted-foreground">v{baseVersion} and v{targetVersion} are identical.</p>
                  </div>
                </div>
              )}
            </div>

            {targetVersion !== artifact.currentVersion && (
              <div className="flex items-center justify-between gap-3 border-t border-border/60 px-3 py-2">
                <span className="text-caption text-muted-foreground">Restoring keeps history — v{targetVersion} becomes a new version.</span>
                <Button size="sm" onClick={restore} disabled={restoring}>
                  <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                  {restoring ? "Restoring…" : `Restore v${targetVersion}`}
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : (
        <Tabs value={tab} onValueChange={(v) => setTab(v as "preview" | "console" | "code")} className="flex min-h-0 flex-1 flex-col">
          {/* Workspace tab row — view switcher left, view-contextual actions right. */}
          <div className="flex items-center gap-2 border-b border-border/60 px-3 py-1.5">
            <TabsList className="h-8">
              <TabsTrigger value="preview" className="gap-1.5">
                {rt.mode === "console" ? <Terminal className="h-3.5 w-3.5" aria-hidden /> : null}
                {rt.mode === "console" ? "Output" : "Preview"}
              </TabsTrigger>
              <TabsTrigger value="code" className="gap-1.5">
                Code
              </TabsTrigger>
              {/* Console appears once it has something to say. */}
              {rt.mode === "web" && (consoleEntries.length > 0 || tab === "console") && (
                <TabsTrigger value="console" className="gap-1.5">
                  Console
                  <span
                    className={cn(
                      "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-[9px] tabular-nums",
                      errorCount ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"
                    )}
                  >
                    {consoleEntries.length}
                  </span>
                </TabsTrigger>
              )}
            </TabsList>

            {!isLatest && (
              <button
                type="button"
                onClick={() => setSelectedVersion(artifact.currentVersion)}
                aria-label={`Viewing v${selectedVersion} — back to latest`}
                className="pressable inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-warning/40 bg-warning/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] text-warning-foreground hover:bg-warning/20"
              >
                v{selectedVersion}
                {panelWide && <span className="normal-case tracking-normal">· back to latest</span>}
              </button>
            )}

            <div className="flex-1" />

            {/* Contextual actions for the active view only. Markdown renders
                natively (no sandbox), so run controls would be decorative. */}
            {tab === "preview" && rt.mode !== "none" && !isMarkdown && (
              <>
                {canInspect && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setInspecting((v) => !v)}
                        aria-label={inspecting ? "Exit element selection" : "Select an element"}
                        aria-pressed={inspecting}
                        className={cn(contextButton, inspecting && "bg-primary/10 text-primary hover:text-primary")}
                      >
                        <Crosshair className="h-3.5 w-3.5" aria-hidden />
                        {panelWide && <span>{inspecting ? "Selecting…" : "Select"}</span>}
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>{inspecting ? "Click an element in the preview · Esc to cancel" : "Pick an element to ask about or modify"}</TooltipContent>
                  </Tooltip>
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="ghost" size="sm" onClick={rerun} aria-label={rt.runVerb === "Run" ? "Run again" : "Reload preview"} className={contextButton}>
                      {rt.mode === "console" ? <Play className="h-3.5 w-3.5" aria-hidden /> : <RotateCw className="h-3.5 w-3.5" aria-hidden />}
                      {panelWide && <span>{rt.mode === "console" ? "Run" : "Reload"}</span>}
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>{rt.mode === "console" ? "Run the program again" : "Reload the preview"}</TooltipContent>
                </Tooltip>
              </>
            )}
            {tab === "code" && (
              <Button variant="ghost" size="sm" onClick={copy} aria-label="Copy source" className={contextButton}>
                {copied ? <Check className="h-3.5 w-3.5 text-success" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
                {panelWide && <span>Copy</span>}
              </Button>
            )}
          </div>

          <TabsContent value="preview" className="min-h-0 flex-1 overflow-hidden">
            {/* A failed newer version never takes the last working preview with it. */}
            {canOfferLastGood && (
              <div className="flex items-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-xs text-destructive motion-safe:animate-fade-in">
                <span className="min-w-0 flex-1 truncate">This version failed to render.</span>
                {rt.mode === "web" && (
                  <Button variant="ghost" size="sm" onClick={() => setTab("console")} className="h-6 px-2 text-xs text-destructive hover:text-destructive">
                    Console
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={() => setSelectedVersion(lastGood!)} className="h-6 px-2 text-xs text-destructive hover:text-destructive">
                  View v{lastGood}
                </Button>
              </div>
            )}
            {isMarkdown ? (
              <div
                key={selectedVersion}
                ref={previewScrollRef}
                onMouseUp={captureSelection}
                onKeyUp={captureSelection}
                className="h-full overflow-auto p-6 motion-safe:animate-fade-in"
              >
                <Markdown content={versionContent} />
              </div>
            ) : (
              <div key={selectedVersion} className="h-full motion-safe:animate-fade-in">
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
                  onStatus={handleRunStatus}
                />
              </div>
            )}
          </TabsContent>

          {rt.mode === "web" && (
            <TabsContent value="console" className="min-h-0 flex-1 overflow-hidden">
              <ConsoleView entries={consoleEntries} onClear={() => setConsoleEntries([])} />
            </TabsContent>
          )}

          <TabsContent value="code" className="min-h-0 flex-1 overflow-hidden">
            <div className="flex h-full flex-col">
              {staleConflict && (
                <div className="flex flex-wrap items-center gap-2 border-b border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning-foreground motion-safe:animate-fade-in">
                  <span className="min-w-0 flex-1">
                    Saved elsewhere as v{staleConflict.currentVersion} while you were editing.
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      onArtifactUpdated(staleConflict);
                      discardDraft();
                    }}
                    className="h-6 px-2 text-xs"
                  >
                    Discard my draft
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => saveEdit(true)} disabled={saving} className="h-6 px-2 text-xs">
                    Save anyway
                  </Button>
                </div>
              )}
              {/* Keyed by artifact only: a save bumps the version, and a
                  version-keyed remount would eject focus, caret, and scroll
                  mid-edit. Content swaps in place through the controlled value. */}
              <div key={artifact.id} className="min-h-0 flex-1">
                <CodeSurface
                  value={displayedContent}
                  language={rt.lang || artifact.language}
                  readOnly={!isLatest}
                  onChange={handleDraftChange}
                  onSave={isLatest ? () => saveEdit() : undefined}
                  onSelect={onQuote && isLatest && !dirty ? handleCodeSelect : undefined}
                  wrap={isMarkdown}
                  ariaLabel={`${artifact.title} source${isLatest ? "" : ` (v${selectedVersion}, read-only)`}`}
                />
              </div>
              {/* Save bar — rises in only once there is something to save. */}
              {dirty && (
                <div className="flex items-center gap-2 border-t border-border/60 bg-card/50 px-3 py-2 motion-safe:animate-rise-in">
                  <span className="min-w-0 truncate font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                    Unsaved changes · saves as v{artifact.currentVersion + 1}
                  </span>
                  <div className="flex-1" />
                  <Button variant="ghost" size="sm" onClick={discardDraft} disabled={saving}>
                    Discard
                  </Button>
                  <Button size="sm" onClick={() => saveEdit()} disabled={saving}>
                    {saving ? "Saving…" : "Save version"}
                  </Button>
                </div>
              )}
            </div>
          </TabsContent>
        </Tabs>
      )}

      {shareable && (
        <ShareDialog kind="ARTIFACT" artifactId={artifact.id} open={shareOpen} onOpenChange={setShareOpen} />
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
            className="fixed z-[70] flex items-center gap-0.5 rounded-[14px] border border-border/60 bg-popover/80 p-1 glass-raised backdrop-blur-xl motion-safe:animate-pop-in"
          >
            <Button type="button" variant="ghost" size="sm" onClick={() => quoteSelection("ask")} className="h-7 gap-1.5 rounded-[10px] px-2.5 coarse:h-10 coarse:px-3.5">
              <MessageCircleQuestion className="h-3.5 w-3.5 text-primary" aria-hidden />
              Ask
            </Button>
            <span aria-hidden className="h-4 w-px bg-border/70" />
            <Button type="button" variant="ghost" size="sm" onClick={() => quoteSelection("modify")} className="h-7 gap-1.5 rounded-[10px] px-2.5 coarse:h-10 coarse:px-3.5">
              <Pencil className="h-3.5 w-3.5 text-primary" aria-hidden />
              Modify
            </Button>
          </div>,
          document.body
        )}
    </div>
  );
}
