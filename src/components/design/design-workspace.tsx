"use client";

/**
 * Juno Design's own window.
 *
 * Opening a design used to route into `/chat/{id}?artifact={id}`, which put a
 * full direct-manipulation editor inside a narrow side panel behind a
 * Preview/Code tab strip — and at that width the editor hid its own layers rail
 * and inspector, so what people actually got was a canvas with no way to see or
 * change anything on it. Design read as a chat because it was living in one.
 *
 * Here the editor is the page: both rails stay, the toolbar is the toolbar, and
 * the way you ask Juno for something is a prompt bar docked to the canvas whose
 * answer arrives as a change to the artwork rather than as a message to read.
 */

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, MessagesSquare } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AskJunoBar, type AskJunoBarHandle } from "@/components/design/ask-juno-bar";
import { DesignAdjustments } from "@/components/design/design-adjustments";
import { DesignEditor, type DesignEditorHandle } from "@/components/design/design-editor";
import { ZoomBar, type DesignViewportHandle } from "@/components/design/design-canvas";
import { toPendingProposal, type DesignEditProposal } from "@/components/design/design-edit-transport";
import type { DesignAdjustment } from "@/lib/design/ai";
import type { NodeId } from "@/lib/design/types";

interface Props {
  artifactId: string;
  /** The artifact's title — the name shown everywhere else this design appears. */
  title: string;
  version: number;
  /** The current version's document JSON, read on the server. */
  content: string;
  /** The conversation that owns the artifact, for the way back into chat. */
  conversationId: string;
}

export function DesignWorkspace({ artifactId, title, version, content, conversationId }: Props) {
  const router = useRouter();
  const editorRef = React.useRef<DesignEditorHandle | null>(null);
  const barRef = React.useRef<AskJunoBarHandle | null>(null);
  const viewportRef = React.useRef<DesignViewportHandle | null>(null);

  const [name, setName] = React.useState(title);
  const [zoom, setZoom] = React.useState(1);
  const [currentVersion, setCurrentVersion] = React.useState(version);
  const [selection, setSelection] = React.useState<{ ids: NodeId[]; names: string[] }>({ ids: [], names: [] });
  /** Adjustments Juno attached to a proposal nobody has accepted yet. They only
   *  become controls once the change they tune is actually on the document. */
  const [armed, setArmed] = React.useState<DesignAdjustment[]>([]);
  const [adjustments, setAdjustments] = React.useState<DesignAdjustment[]>([]);
  const [reviewing, setReviewing] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);

  const onSelectionChange = React.useCallback((_revision: number, ids: NodeId[]) => {
    const names = editorRef.current?.selectionNames() ?? [];
    // The editor reports the selection on every document change, not only when
    // it actually moves — so a drag fires this once per commit with the same
    // ids. Holding the old object keeps the prompt bar out of that churn.
    setSelection((current) => (same(current.ids, ids) && same(current.names, names) ? current : { ids, names }));
  }, []);

  const onProposal = React.useCallback((proposal: DesignEditProposal) => {
    // A proposal that touches no node is Juno declining and answering instead —
    // its operations are a `setSelection` pointing at what the answer is about.
    // There is nothing to review, so honour the selection and let the bar show
    // the sentence: `apply` treats a transaction that changes no node as
    // selection-only, with no history entry and no save.
    if (proposal.touchedNodeIds.length === 0) {
      editorRef.current?.apply(proposal.transaction.operations, proposal.transaction.summary);
      setArmed([]);
      setAdjustments([]);
      setReviewing(false);
      return;
    }
    editorRef.current?.proposeTransaction(toPendingProposal(proposal));
    setArmed(proposal.adjustments);
    setAdjustments([]);
    setReviewing(true);
  }, []);

  const onProposalResolved = React.useCallback(
    (outcome: "applied" | "rejected") => {
      setReviewing(false);
      setAdjustments(outcome === "applied" ? armed : []);
      setArmed([]);
    },
    [armed]
  );

  /** The toolbar's "Ask Juno" button. The selection is already carried by the
   *  bar's scope chip, so the useful thing to do with it is put the caret where
   *  the question gets typed. */
  const onAskJuno = React.useCallback(() => barRef.current?.focus(), []);

  /**
   * Rename the design — both halves of it.
   *
   * The artifact carries the name the library, the Artifacts list and the
   * conversation show; `DesignDocument.name` carries the one every export is
   * filed under. This used to PATCH only the first, so a design renamed in the
   * header still exported as whatever it was called when it was authored.
   * Renaming the document goes through the operation layer like any other
   * edit, which is also what makes it undoable.
   */
  const rename = React.useCallback(
    async (next: string) => {
      const trimmed = next.trim();
      if (!trimmed || trimmed === name) {
        setName(name);
        return;
      }
      setName(trimmed);
      editorRef.current?.apply([{ op: "renameDocument", name: trimmed }], "Rename design");
      const res = await fetch(`/api/artifacts/${artifactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      }).catch(() => null);
      if (!res?.ok) {
        setName(name);
        editorRef.current?.apply([{ op: "renameDocument", name }], "Rename design");
        toast.error("Could not rename this design.");
      }
    },
    [artifactId, name]
  );

  const deleteDesign = React.useCallback(async () => {
    if (deleting) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/artifacts/${artifactId}`, { method: "DELETE" });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Could not delete this design.");
      toast.success("Design deleted.");
      router.replace("/design");
    } catch (error) {
      setDeleting(false);
      toast.error(error instanceof Error ? error.message : "Could not delete this design.");
    }
  }, [artifactId, deleting, router]);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b border-border/60 px-3 py-2">
        <Button asChild variant="ghost" size="icon-sm" className="shrink-0 text-muted-foreground hover:text-foreground">
          <Link href="/design" aria-label="All designs">
            <ArrowLeft className="size-4" aria-hidden />
          </Link>
        </Button>

        <NameField value={name} onCommit={rename} />

        <span className="shrink-0 font-mono text-micro text-muted-foreground tabular-nums">v{currentVersion}</span>

        <div className="flex-1" />

        <Button asChild variant="ghost" size="sm" className="h-7 gap-1.5 rounded-control px-2 text-xs text-muted-foreground hover:text-foreground">
          <Link href={`/chat/${conversationId}`}>
            <MessagesSquare className="size-3.5" aria-hidden />
            Chat
          </Link>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Design actions" className="shrink-0 text-muted-foreground hover:text-foreground">
              <ActionIcons.more className="size-4" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem variant="destructive" onSelect={() => setDeleteOpen(true)}>
              <ActionIcons.delete className="size-4" aria-hidden />
              Delete design
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>

      <div className="min-h-0 flex-1">
        <DesignEditor
          artifactId={artifactId}
          content={content}
          surface="window"
          editorRef={editorRef}
          onCommitted={setCurrentVersion}
          onSelectionChange={onSelectionChange}
          onAskJuno={onAskJuno}
          onProposalResolved={onProposalResolved}
          onViewportChange={setZoom}
          viewportRef={viewportRef}
          chrome={<ZoomControls zoom={zoom} viewport={viewportRef} hasSelection={selection.ids.length > 0} />}
          canvasDock={
            <>
              {adjustments.length > 0 && (
                <DesignAdjustments adjustments={adjustments} editor={editorRef} onDismiss={() => setAdjustments([])} />
              )}
              <AskJunoBar
                ref={barRef}
                artifactId={artifactId}
                editor={editorRef}
                selection={selection}
                blocked={reviewing}
                onProposal={onProposal}
              />
            </>
          }
        />
      </div>

      <Dialog open={deleteOpen} onOpenChange={(open) => !open && !deleting && setDeleteOpen(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {name}?</DialogTitle>
            <DialogDescription>
              Every version of this design and its history will be permanently removed. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            {/* Ghost, not outline. Cancel is the way out of a dialog, not a
                second thing being offered, and every other confirm dialog in
                the product spells that as ghost. An outlined cancel drew a box
                that competed with the destructive button beside it. */}
            <DialogClose asChild>
              <Button variant="ghost" disabled={deleting}>Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={() => void deleteDesign()} disabled={deleting}>
              {deleting ? "Deleting…" : "Delete design"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function same(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The zoom control, in the toolbar where a design editor's zoom belongs.
 *
 * It reads the magnification the canvas reports and drives the canvas's own
 * viewport closures, so the number on screen is the number the pointer is
 * panning rather than a second copy that has to be kept in step. Handing the
 * canvas a `viewportRef` is also what stops it drawing its own floating
 * control — one editor, one zoom readout.
 */
function ZoomControls({
  zoom,
  viewport,
  hasSelection,
}: {
  zoom: number;
  viewport: React.MutableRefObject<DesignViewportHandle | null>;
  hasSelection: boolean;
}) {
  // The same control the canvas draws for chrome-less hosts — see `ZoomBar`.
  // This used to be a second copy of the identical five buttons.
  return (
    <ZoomBar
      zoom={zoom}
      onZoomBy={(factor) => viewport.current?.zoomBy(factor)}
      onReset={() => viewport.current?.zoomTo100()}
      onFit={() => viewport.current?.zoomToFit()}
      onSelection={() => viewport.current?.zoomToSelection()}
      hasSelection={hasSelection}
    />
  );
}

/** The design's name, edited in place. Commits to both names it has: the
 *  artifact's, which is what the library, Artifacts and the conversation show,
 *  and the document's, which is what its exports are called. */
function NameField({ value, onCommit }: { value: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = React.useState<string | null>(null);
  return (
    <input
      type="text"
      value={draft ?? value}
      aria-label="Design name"
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        if (draft !== null) onCommit(draft);
        setDraft(null);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") (event.target as HTMLInputElement).blur();
        if (event.key === "Escape") {
          setDraft(null);
          (event.target as HTMLInputElement).blur();
        }
        // The editor's shortcuts are bound on window; typing a name must not
        // switch tools or delete the selection.
        event.stopPropagation();
      }}
      className="min-w-0 max-w-xs flex-initial truncate rounded-md border border-transparent bg-transparent px-1.5 py-0.5 font-sans text-heading outline-none transition-colors hover:border-border/60 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/20"
    />
  );
}
