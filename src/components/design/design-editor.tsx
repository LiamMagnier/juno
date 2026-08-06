"use client";

/**
 * The design editor shell: toolbar, canvas, layers, inspector, history, and the
 * review card for a pending Juno transaction.
 *
 * The shell owns keyboard shortcuts and the panel layout; it owns no document
 * state of its own — everything goes through `useDesignDocument`, so what the
 * canvas draws, what the inspector edits and what the history panel lists are
 * one document, not three copies that can drift.
 */

import * as React from "react";
import { toast } from "sonner";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  Check,
  Circle,
  Frame,
  History,
  Image as ImageIcon,
  Layers,
  Minus,
  MousePointer2,
  Redo2,
  Share2,
  Slash,
  Square,
  Type,
  Undo2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { DesignCanvas, type CanvasTool } from "@/components/design/design-canvas";
import { InspectorPanel } from "@/components/design/inspector-panel";
import { LayersPanel } from "@/components/design/layers-panel";
import {
  useDesignDocument,
  type DesignEditorState,
  type DesignTransport,
  type PendingProposal,
} from "@/components/design/use-design-document";
import { layoutPage } from "@/lib/design/layout";
import { buildSelectionContext } from "@/lib/design/selection-context";
import { isContainer, type DesignDocument, type NodeId } from "@/lib/design/types";
import type { DesignOperation } from "@/lib/design/operations";
import { cn } from "@/lib/utils";

/** What the Export menu offers. `png` is rasterised in the browser from the
 *  SVG the server returns — see `src/lib/design/export.ts` on why the server
 *  does not do it. */
const EXPORTS = [
  { format: "svg", label: "SVG" },
  { format: "png", label: "PNG (2×)" },
  { format: "pdf", label: "PDF" },
  { format: "html", label: "HTML prototype" },
  { format: "react", label: "React component" },
  { format: "swiftui", label: "SwiftUI view" },
  { format: "tokens", label: "Design tokens (JSON)" },
  { format: "json", label: "Design document (JSON)" },
] as const;

type ExportFormat = (typeof EXPORTS)[number]["format"] | "handoff";

const NUDGE_SMALL = 1;
const NUDGE_LARGE = 10;

const TOOLS: { tool: CanvasTool; icon: typeof Square; label: string; key: string }[] = [
  { tool: "select", icon: MousePointer2, label: "Select", key: "V" },
  { tool: "frame", icon: Frame, label: "Frame", key: "F" },
  { tool: "rectangle", icon: Square, label: "Rectangle", key: "R" },
  { tool: "ellipse", icon: Circle, label: "Ellipse", key: "O" },
  { tool: "line", icon: Slash, label: "Line", key: "L" },
  { tool: "text", icon: Type, label: "Text", key: "T" },
  { tool: "image", icon: ImageIcon, label: "Image", key: "I" },
];

/**
 * The editor's imperative surface for chrome that lives outside it.
 *
 * Everything here is something a host needs in order to *drive* the editor
 * without owning a second copy of its state: the Ask Juno bar on the full-window
 * route reads the selection, hands back a proposal, and its adjustment controls
 * write ordinary transactions. Nothing on this handle bypasses the operation
 * layer — `proposeTransaction` only previews, and `apply` is the same call the
 * inspector makes.
 */
export interface DesignEditorHandle {
  /** Structured context for "Ask Juno about this selection". */
  selectionContext: () => ReturnType<typeof buildSelectionContext> | null;
  /** Layer names for the current selection — what chrome can afford to read on
   *  every selection change, where the full context (which renders an image)
   *  cannot. */
  selectionNames: () => string[];
  /** The page the canvas is showing, which the selection context belongs to. */
  pageId: () => string;
  /** The committed document — read at the moment an operation is built, never
   *  held, so chrome outside the editor cannot act on a stale scene. */
  document: () => DesignDocument | null;
  /** The live document's revision, so a request can name the scene it saw. */
  revision: () => number | null;
  /** Draw a proposal on the canvas without committing it. */
  proposeTransaction: (proposal: PendingProposal) => void;
  /** Run operations as an ordinary user transaction. */
  apply: (operations: DesignOperation[], summary: string) => void;
}

export function DesignEditor({
  artifactId,
  content,
  transport,
  readOnly,
  surface = "embedded",
  onCommitted,
  onAskJuno,
  onSelectionChange,
  onProposalResolved,
  canvasDock,
  editorRef,
}: {
  artifactId: string;
  content: string;
  /** Where committed transactions go. Defaults to the website's HTTP transport;
   *  the Mac host supplies the design bridge instead. */
  transport?: DesignTransport;
  readOnly?: boolean;
  /**
   * How much of the screen the editor has, which is the only thing the layers
   * and inspector rails need to know.
   *
   * "embedded" (the default, and what the chat canvas panel and the Mac host
   * get) collapses both rails on narrow viewports, because there a transcript
   * is competing for the same few hundred pixels. That rule is also why a
   * design opened from the chat panel showed a canvas with no layers and no
   * inspector at all — so on "window", where the editor *is* the page, the
   * rails simply stay.
   */
  surface?: "embedded" | "window";
  onCommitted?: (version: number) => void;
  /** Hand the selection to the conversation. Absent in read-only surfaces. */
  onAskJuno?: (context: ReturnType<typeof buildSelectionContext>) => void;
  /** Selection changed. The Mac host forwards this so native chrome can act on
   *  it without the editor owning any native UI. */
  onSelectionChange?: (revision: number, nodeIds: NodeId[]) => void;
  /** A pending Juno proposal was accepted or discarded. */
  onProposalResolved?: (outcome: "applied" | "rejected") => void;
  /** Chrome docked to the bottom of the canvas, below the proposal review —
   *  the Ask Juno bar and its adjustment controls. */
  canvasDock?: React.ReactNode;
  editorRef?: React.MutableRefObject<DesignEditorHandle | null>;
}) {
  const state = useDesignDocument({ artifactId, initialContent: content, transport, readOnly, onCommitted });
  const [tool, setTool] = React.useState<CanvasTool>("select");
  const [panel, setPanel] = React.useState<"layers" | "history">("layers");
  const rootRef = React.useRef<HTMLDivElement>(null);

  const { document: doc, visibleDocument, pageId, selection, selectNodes, apply } = state;

  const selectionContext = React.useCallback(() => {
    if (!doc || selection.length === 0) return null;
    return buildSelectionContext(doc, pageId, selection);
  }, [doc, pageId, selection]);

  React.useEffect(() => {
    if (!editorRef) return;
    editorRef.current = {
      selectionContext,
      selectionNames: () => (doc ? selection.flatMap((id) => (doc.nodes[id] ? [doc.nodes[id].name] : [])) : []),
      pageId: () => pageId,
      document: () => doc,
      revision: () => doc?.revision ?? null,
      proposeTransaction: state.proposeTransaction,
      apply: (operations, summary) => {
        apply(operations, summary);
      },
    };
  }, [apply, doc, editorRef, pageId, selection, selectionContext, state.proposeTransaction]);

  React.useEffect(() => {
    if (doc) onSelectionChange?.(doc.revision, selection);
  }, [doc, onSelectionChange, selection]);

  /** Fetch an export and hand it to the browser as a download. */
  const exportAs = React.useCallback(
    async (format: ExportFormat) => {
      try {
        const query = new URLSearchParams({ format, pageId });
        // A single selected frame exports on its own; otherwise the page does.
        if (selection.length === 1 && format !== "handoff") query.set("nodeId", selection[0]);
        const res = await fetch(`/api/design/${artifactId}/export?${query}`);
        if (!res.ok) {
          const message = await res.json().then((d) => d?.error).catch(() => null);
          throw new Error(message ?? "Export failed.");
        }

        if (format === "png") {
          const { rasterize } = (await res.json()) as { rasterize: { svg: string; width: number; height: number; scale: number; fileName: string } };
          await downloadRasterized(rasterize);
          return;
        }
        if (format === "react" || format === "swiftui" || format === "tokens" || format === "handoff") {
          const payload = await res.json();
          const name =
            format === "handoff"
              ? `${doc?.name ?? "design"}.juno-handoff.json`
              : format === "tokens"
                ? `${doc?.name ?? "design"}.tokens.json`
                : (payload.file as string);
          const body = format === "react" || format === "swiftui" ? (payload.content as string) : JSON.stringify(payload, null, 2);
          saveBlob(new Blob([body], { type: "text/plain" }), name);
          const notes: string[] = payload.unsupported ?? [];
          if (notes.length) toast.info(`Exported. ${notes[0]}`);
          return;
        }

        const blob = await res.blob();
        const disposition = res.headers.get("Content-Disposition") ?? "";
        const named = /filename="([^"]+)"/.exec(disposition)?.[1];
        saveBlob(blob, named ?? `${doc?.name ?? "design"}.${format}`);

        const notes = res.headers.get("X-Juno-Export-Notes");
        if (notes) {
          const parsed = JSON.parse(notes) as string[];
          if (parsed.length) toast.info(`Exported. ${parsed[0]}`);
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Could not export this design.");
      }
    },
    [artifactId, doc?.name, pageId, selection]
  );

  // ------------------------------------------------------------- shortcuts

  const nudge = React.useCallback(
    (dx: number, dy: number) => {
      if (!doc || selection.length === 0) return;
      const operations = selection.flatMap<DesignOperation>((id) => {
        const node = doc.nodes[id];
        if (!node || node.locked) return [];
        return [{ op: "updateNode", nodeId: id, patch: { x: node.x + dx, y: node.y + dy } }];
      });
      if (operations.length) apply(operations, "Nudge");
    },
    [apply, doc, selection]
  );

  const align = React.useCallback(
    (axis: "left" | "center-x" | "right" | "top" | "center-y" | "bottom" | "distribute-x" | "distribute-y") => {
      if (!doc || selection.length < 2) return;
      const boxes = layoutPage(doc, pageId);
      const entries = selection
        .map((id) => ({ id, node: doc.nodes[id], box: boxes.get(id) }))
        .filter((e): e is { id: NodeId; node: NonNullable<typeof e.node>; box: NonNullable<typeof e.box> } => !!e.node && !!e.box && !e.node.locked);
      if (entries.length < 2) return;

      const minX = Math.min(...entries.map((e) => e.box.x));
      const maxX = Math.max(...entries.map((e) => e.box.x + e.box.width));
      const minY = Math.min(...entries.map((e) => e.box.y));
      const maxY = Math.max(...entries.map((e) => e.box.y + e.box.height));

      const operations: DesignOperation[] = [];
      if (axis === "distribute-x" || axis === "distribute-y") {
        const horizontal = axis === "distribute-x";
        const sorted = [...entries].sort((a, b) => (horizontal ? a.box.x - b.box.x : a.box.y - b.box.y));
        const total = horizontal ? maxX - minX : maxY - minY;
        const used = sorted.reduce((sum, e) => sum + (horizontal ? e.box.width : e.box.height), 0);
        const gap = (total - used) / (sorted.length - 1);
        let cursor = horizontal ? minX : minY;
        for (const entry of sorted) {
          const delta = cursor - (horizontal ? entry.box.x : entry.box.y);
          operations.push({
            op: "updateNode",
            nodeId: entry.id,
            patch: horizontal ? { x: round(entry.node.x + delta) } : { y: round(entry.node.y + delta) },
          });
          cursor += (horizontal ? entry.box.width : entry.box.height) + gap;
        }
      } else {
        for (const entry of entries) {
          const targetX =
            axis === "left" ? minX : axis === "right" ? maxX - entry.box.width : axis === "center-x" ? (minX + maxX) / 2 - entry.box.width / 2 : null;
          const targetY =
            axis === "top" ? minY : axis === "bottom" ? maxY - entry.box.height : axis === "center-y" ? (minY + maxY) / 2 - entry.box.height / 2 : null;
          const patch: Record<string, number> = {};
          if (targetX !== null) patch.x = round(entry.node.x + (targetX - entry.box.x));
          if (targetY !== null) patch.y = round(entry.node.y + (targetY - entry.box.y));
          if (Object.keys(patch).length) operations.push({ op: "updateNode", nodeId: entry.id, patch: patch as never });
        }
      }
      if (operations.length) apply(operations, `Align ${axis}`);
    },
    [apply, doc, pageId, selection]
  );

  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Never steal a keystroke aimed at a text field — including the chat
      // composer, which shares the page with this editor.
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      if (!rootRef.current?.contains(document.activeElement) && !rootRef.current?.matches(":hover")) return;

      const mod = event.metaKey || event.ctrlKey;
      const step = event.shiftKey ? NUDGE_LARGE : NUDGE_SMALL;

      if (mod && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) state.redo();
        else state.undo();
        return;
      }
      if (mod && event.key.toLowerCase() === "d") {
        event.preventDefault();
        if (selection.length) apply([{ op: "duplicateNodes", nodeIds: selection }], "Duplicate");
        return;
      }
      if (mod && event.key.toLowerCase() === "g") {
        event.preventDefault();
        if (selection.length < 2) return;
        if (event.shiftKey) apply([{ op: "ungroupNodes", nodeIds: selection }], "Ungroup");
        else apply([{ op: "groupNodes", nodeIds: selection }], "Group");
        return;
      }
      if (mod && event.key.toLowerCase() === "a") {
        event.preventDefault();
        const page = doc?.pages.find((p) => p.id === pageId);
        if (page) selectNodes(page.children);
        return;
      }
      if (mod && event.key === "]") {
        event.preventDefault();
        if (selection.length) apply([{ op: "reorderNodes", nodeIds: selection, to: event.altKey ? "front" : "forward" }], "Bring forward");
        return;
      }
      if (mod && event.key === "[") {
        event.preventDefault();
        if (selection.length) apply([{ op: "reorderNodes", nodeIds: selection, to: event.altKey ? "back" : "backward" }], "Send backward");
        return;
      }
      if (mod) return; // leave every other ⌘/Ctrl chord to the browser

      switch (event.key) {
        case "Escape":
          if (state.pending) {
            state.rejectPending();
            onProposalResolved?.("rejected");
          } else if (tool !== "select") setTool("select");
          else selectNodes([]);
          return;
        case "Backspace":
        case "Delete":
          if (selection.length) {
            event.preventDefault();
            apply([{ op: "deleteNodes", nodeIds: selection }], "Delete");
          }
          return;
        case "ArrowLeft":
          event.preventDefault();
          nudge(-step, 0);
          return;
        case "ArrowRight":
          event.preventDefault();
          nudge(step, 0);
          return;
        case "ArrowUp":
          event.preventDefault();
          nudge(0, -step);
          return;
        case "ArrowDown":
          event.preventDefault();
          nudge(0, step);
          return;
        default:
          break;
      }

      const shortcut = TOOLS.find((t) => t.key.toLowerCase() === event.key.toLowerCase());
      if (shortcut) {
        event.preventDefault();
        setTool(shortcut.tool);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [apply, doc, nudge, onProposalResolved, pageId, selection, selectNodes, state, tool]);

  // ---------------------------------------------------------------- render

  if (state.loadError) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center">
        <div className="max-w-sm">
          <p className="font-serif text-heading">This design can’t be opened</p>
          <p className="pt-1 text-sm text-muted-foreground">{state.loadError}</p>
        </div>
      </div>
    );
  }
  if (!visibleDocument || !doc) {
    return <div className="flex h-full items-center justify-center text-caption text-muted-foreground">Loading design…</div>;
  }

  return (
    <div ref={rootRef} className="flex h-full min-h-0 flex-col" data-juno-design-editor="">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-border/60 bg-card/40 px-2 py-1.5">
        <div className="flex items-center gap-0.5" role="toolbar" aria-label="Design tools">
          {TOOLS.map(({ tool: value, icon: Icon, label, key }) => (
            <Tooltip key={value}>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={label}
                  aria-pressed={tool === value}
                  disabled={readOnly && value !== "select"}
                  onClick={() => setTool(value)}
                  className={cn("text-muted-foreground hover:text-foreground", tool === value && "bg-primary/10 text-primary hover:text-primary")}
                >
                  <Icon className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {label} · {key}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>

        <span aria-hidden className="mx-1 h-5 w-px bg-border/60" />

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={state.undo} disabled={!state.canUndo} aria-label="Undo" className="text-muted-foreground hover:text-foreground">
              <Undo2 className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Undo · ⌘Z</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="icon-sm" onClick={state.redo} disabled={!state.canRedo} aria-label="Redo" className="text-muted-foreground hover:text-foreground">
              <Redo2 className="size-4" aria-hidden />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Redo · ⇧⌘Z</TooltipContent>
        </Tooltip>

        {selection.length > 1 && (
          <>
            <span aria-hidden className="mx-1 h-5 w-px bg-border/60" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={() => align("center-x")} aria-label="Align horizontal centres" className="text-muted-foreground hover:text-foreground">
                  <AlignCenterVertical className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Align horizontal centres</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={() => align("center-y")} aria-label="Align vertical centres" className="text-muted-foreground hover:text-foreground">
                  <AlignCenterHorizontal className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Align vertical centres</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="icon-sm" onClick={() => align("distribute-x")} aria-label="Distribute horizontally" className="text-muted-foreground hover:text-foreground">
                  <Minus className="size-4" aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Distribute horizontally · equal spacing</TooltipContent>
            </Tooltip>
          </>
        )}

        <div className="flex-1" />

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Export"
              className="h-7 gap-1.5 rounded-[10px] px-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <Share2 className="size-3.5" aria-hidden />
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {EXPORTS.map((item) => (
              <DropdownMenuItem key={item.format} onSelect={() => void exportAs(item.format)}>
                {item.label}
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void exportAs("handoff")}>
              Juno Code handoff bundle…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {onAskJuno && selection.length > 0 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              const context = selectionContext();
              if (context) onAskJuno(context);
              else toast.error("Select a layer first.");
            }}
            className="h-7 gap-1.5 rounded-[10px] px-2 text-xs text-muted-foreground hover:text-foreground"
          >
            Ask Juno
          </Button>
        )}
        {state.saving && <span className="px-2 font-mono text-[10px] text-muted-foreground">Saving…</span>}
      </div>

      {/* Body: layers · canvas · inspector */}
      <div className="flex min-h-0 flex-1">
        <aside className={cn("w-52 shrink-0 flex-col border-r border-border/60", surface === "window" ? "flex" : "hidden md:flex")}>
          <div className="flex border-b border-border/60">
            {(["layers", "history"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setPanel(value)}
                aria-pressed={panel === value}
                className={cn(
                  "flex flex-1 items-center justify-center gap-1 py-1.5 font-mono text-[10px] transition-colors coarse:min-h-9",
                  panel === value ? "text-primary" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {value === "layers" ? <Layers className="size-3" aria-hidden /> : <History className="size-3" aria-hidden />}
                {value === "layers" ? "Layers" : "History"}
              </button>
            ))}
          </div>
          {panel === "layers" ? (
            <LayersPanel
              document={visibleDocument}
              pageId={pageId}
              onPageChange={state.setPageId}
              selection={selection}
              onSelect={selectNodes}
              onApply={(operations, summary) => apply(operations, summary)}
              readOnly={readOnly}
            />
          ) : (
            <HistoryList state={state} onSelect={selectNodes} />
          )}
        </aside>

        <div className="relative min-w-0 flex-1">
          <DesignCanvas
            document={visibleDocument}
            pageId={pageId}
            selection={selection}
            onSelect={selectNodes}
            onApply={(operations, summary) => apply(operations, summary)}
            tool={tool}
            onToolUsed={() => setTool("select")}
            readOnly={readOnly || !!state.pending}
            highlightedIds={state.pending?.result.touchedNodeIds}
          />
          {/* One bottom-anchored stack rather than two independently positioned
              overlays: the review card and the Ask Juno bar are both docked to
              the canvas, and stacking them is what keeps the bar reachable while
              a proposal is on screen instead of buried under it. The column is
              click-through so the canvas underneath still takes a drag between
              them. */}
          {(state.pending || canvasDock) && (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col gap-2 p-3">
              {state.pending && <ProposalReview state={state} onResolved={onProposalResolved} />}
              {canvasDock}
            </div>
          )}
        </div>

        <aside className={cn("w-64 shrink-0 flex-col border-l border-border/60", surface === "window" ? "flex" : "hidden lg:flex")}>
          <InspectorPanel document={visibleDocument} selection={selection} onApply={(operations, summary) => apply(operations, summary)} readOnly={readOnly || !!state.pending} />
        </aside>
      </div>
    </div>
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** The before/after review for a proposal Juno has made but nobody has accepted. */
function ProposalReview({ state, onResolved }: { state: DesignEditorState; onResolved?: (outcome: "applied" | "rejected") => void }) {
  const pending = state.pending;
  if (!pending) return null;
  return (
    <div className="pointer-events-auto rounded-[16px] border border-border/70 bg-popover/95 p-3 shadow-soft backdrop-blur-xl motion-safe:animate-rise-in">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{pending.transaction.summary}</p>
          <ul className="max-h-24 overflow-y-auto pt-1">
            {pending.changes.map((line, index) => (
              <li key={index} className="truncate font-mono text-[10px] text-muted-foreground">
                {line}
              </li>
            ))}
          </ul>
          <p className="pt-1 font-mono text-[10px] text-muted-foreground">
            Previewing on the canvas · {pending.result.touchedNodeIds.length} layer
            {pending.result.touchedNodeIds.length === 1 ? "" : "s"} affected
          </p>
        </div>
        <div className="flex shrink-0 gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              state.rejectPending();
              onResolved?.("rejected");
            }}
            className="gap-1.5"
          >
            <X className="size-3.5" aria-hidden /> Reject
          </Button>
          <Button
            size="sm"
            onClick={() => {
              void state.acceptPending();
              onResolved?.("applied");
            }}
            className="gap-1.5"
          >
            <Check className="size-3.5" aria-hidden /> Apply
          </Button>
        </div>
      </div>
    </div>
  );
}

function HistoryList({ state, onSelect }: { state: DesignEditorState; onSelect: (ids: NodeId[]) => void }) {
  const entries = [...state.history].reverse();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-1">
      {entries.length === 0 && <p className="px-3 py-6 text-center text-caption text-muted-foreground">No changes yet.</p>}
      {entries.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => onSelect(entry.touched)}
          className="block w-full rounded-[8px] px-2 py-1.5 text-left transition-colors hover:bg-muted/60"
        >
          <span className="flex items-baseline gap-1.5">
            <span className={cn("truncate text-xs", entry.author === "juno" ? "text-primary" : "text-foreground")}>{entry.summary}</span>
          </span>
          <span className="block font-mono text-[9px] text-muted-foreground">
            {entry.author === "juno" ? "Juno" : "You"} · {entry.touched.length} layer{entry.touched.length === 1 ? "" : "s"}
          </span>
        </button>
      ))}
    </div>
  );
}

/** Exported for the canvas shell so it can offer "New design" without importing
 *  the whole editor's internals. */
export function emptyDesignContent(name: string): string {
  const pageId = "page-1";
  const frameId = "frame-1";
  return JSON.stringify({
    schemaVersion: 1,
    id: `design-${Math.random().toString(36).slice(2, 10)}`,
    name,
    revision: 0,
    migratedFrom: [],
    pages: [{ id: pageId, name: "Page 1", children: [frameId], backgroundColor: { r: 0.96, g: 0.96, b: 0.97, a: 1 } }],
    nodes: {
      [frameId]: {
        id: frameId,
        type: "frame",
        name: "Frame",
        parentId: null,
        x: 0,
        y: 0,
        width: 375,
        height: 812,
        rotation: 0,
        opacity: 1,
        visible: true,
        locked: false,
        blendMode: "normal",
        fills: [{ type: "solid", color: { r: 1, g: 1, b: 1, a: 1 } }],
        strokes: [],
        cornerRadius: 0,
        shadows: [],
        blur: null,
        constraints: { horizontal: "min", vertical: "min" },
        widthMode: "fixed",
        heightMode: "fixed",
        limits: {},
        layoutChild: { grow: false, absolute: false },
        boundVariables: {},
        children: [],
        clipsContent: true,
        layout: null,
      },
    },
    components: {},
    collections: {},
    variables: {},
    activeModes: {},
    interactions: {},
    animations: {},
    comments: [],
    assets: {},
    updatedAt: new Date().toISOString(),
  });
}

export { isContainer };

// ---------------------------------------------------------------------------
// Download helpers
// ---------------------------------------------------------------------------

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

/**
 * Rasterise an exported SVG in the browser.
 *
 * The server returns vector geometry and the target size; the pixels are made
 * here because this is where a renderer actually exists. The SVG is drawn from
 * a blob URL rather than injected into the page, so nothing in it can execute
 * against the app — a canvas draw of an `<img>` is inert by construction.
 */
async function downloadRasterized(request: {
  svg: string;
  width: number;
  height: number;
  scale: number;
  fileName: string;
}): Promise<void> {
  const source = URL.createObjectURL(new Blob([request.svg], { type: "image/svg+xml" }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Could not draw the design for export."));
      image.src = source;
    });

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(request.width * request.scale));
    canvas.height = Math.max(1, Math.round(request.height * request.scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot rasterise the export.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob) throw new Error("Could not encode the PNG.");
    saveBlob(blob, request.fileName);
  } finally {
    URL.revokeObjectURL(source);
  }
}
