"use client";

/**
 * "Ask Juno to change this design" — docked to the canvas, not a chat.
 *
 * A transcript is the wrong shape for this. What a design edit produces is not
 * a message to read; it is a transaction to look at on the canvas and accept or
 * throw away. So there is one field, the answer arrives as a live preview of the
 * artwork, and the only reply the bar itself ever shows is a refusal — the case
 * where Juno declined to change anything and said why.
 *
 * The scope chip is the whole difference between this and a chat box: when
 * layers are selected the request carries them, and the server refuses any
 * transaction that reaches outside them (see `previewProposal`). Turning the
 * chip off widens the request to the document, deliberately and visibly.
 */

import * as React from "react";
import { ArrowUp, Loader2 } from "lucide-react";
import { ActionIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { requestDesignEdit, DesignEditRequestError, type DesignEditProposal } from "@/components/design/design-edit-transport";
import type { DesignEditorHandle } from "@/components/design/design-editor";
import type { NodeId } from "@/lib/design/types";
import { cn } from "@/lib/utils";

export interface AskJunoBarHandle {
  /** Put the caret in the field — what the toolbar's "Ask Juno" button does. */
  focus: () => void;
}

interface Props {
  artifactId: string;
  /** Read at submit time, so the request names the scene actually on screen. */
  editor: React.MutableRefObject<DesignEditorHandle | null>;
  /** The current selection, mirrored here so the chip re-renders with it. */
  selection: { ids: NodeId[]; names: string[] };
  /** A proposal is already on the canvas — resolve it before asking again. */
  blocked?: boolean;
  onProposal: (proposal: DesignEditProposal) => void;
}

export const AskJunoBar = React.forwardRef<AskJunoBarHandle, Props>(function AskJunoBar(
  { artifactId, editor, selection, blocked, onProposal },
  ref
) {
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  // Scoping is opt-out rather than opt-in: selecting a layer and then asking for
  // a change means that layer, and a request that quietly redecorated the rest
  // of the screen is the failure this whole pipeline is built to prevent.
  const [scopeToSelection, setScopeToSelection] = React.useState(true);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const abortRef = React.useRef<AbortController | null>(null);

  React.useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  // Abandon an in-flight request when the bar goes away, so a slow model cannot
  // resolve into an editor that has since been unmounted or navigated away from.
  React.useEffect(() => () => abortRef.current?.abort(), []);

  const scoped = scopeToSelection && selection.ids.length > 0;

  const submit = React.useCallback(async () => {
    const prompt = draft.trim();
    const handle = editor.current;
    const revision = handle?.revision() ?? null;
    if (!prompt || busy || blocked || !handle || revision === null) return;

    setBusy(true);
    setError(null);
    setNote(null);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const proposal = await requestDesignEdit({
        artifactId,
        prompt,
        pageId: handle.pageId(),
        selectedNodeIds: scoped ? selection.ids : [],
        baseRevision: revision,
        signal: controller.signal,
      });
      setDraft("");
      // A note means Juno answered rather than changed anything. The proposal
      // still goes to the canvas — it carries the selection the answer is about
      // — but the sentence belongs here, next to the question that earned it.
      if (proposal.note) setNote(proposal.note);
      onProposal(proposal);
    } catch (err) {
      if (controller.signal.aborted) return;
      setError(err instanceof DesignEditRequestError ? err.message : "Juno could not reach the design.");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  }, [artifactId, blocked, busy, draft, editor, onProposal, scoped, selection.ids]);

  const scopeLabel =
    selection.names.length === 1
      ? selection.names[0]
      : `${selection.ids.length} layer${selection.ids.length === 1 ? "" : "s"}`;

  return (
    <div className="pointer-events-auto mx-auto w-full max-w-2xl motion-safe:animate-rise-in">
      {(error || note) && (
        <div
          className={cn(
            "mb-2 rounded-menu border px-3 py-2 text-xs leading-5",
            // The neutral strip is a floating layer like any other, so it takes the
            // shared material rather than a fourth hand-mixed one (/95 fill, /70
            // hairline, blur-xl, no shadow). The error strip keeps its own tint.
            error ? "border-destructive/30 bg-destructive/10 text-destructive" : "overlay-glass"
          )}
          role={error ? "alert" : "status"}
        >
          {error ?? note}
        </div>
      )}

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        // The design editor's floating surfaces were the furthest drift in the
        // product — /95 fills, /70 hairlines and shadow-soft, which is the IN-FLOW
        // card shadow worn by an out-of-flow layer. Same material and same radius
        // rung as every other popover now.
        className="flex items-center gap-2 rounded-popover overlay-glass p-1.5 pl-2.5"
      >
        {/* No leading glyph. The sparkle that used to sit here said nothing the
            placeholder does not already say in words, and it was the one piece
            of chat iconography on a surface whose whole argument is that this
            is not a chat. The left padding is the field's own now. */}
        {selection.ids.length > 0 && (
          <button
            type="button"
            onClick={() => setScopeToSelection((on) => !on)}
            aria-pressed={scopeToSelection}
            title={scopeToSelection ? "Only this selection will change" : "Juno may change anything in the document"}
            className={cn(
              "pressable flex max-w-[10rem] shrink-0 items-center gap-1 rounded-control px-2 py-1 font-mono text-micro transition-colors duration-fast",
              scopeToSelection
                ? "bg-primary/10 text-primary"
                : "bg-muted/60 text-muted-foreground hover:text-foreground"
            )}
          >
            <span className="truncate">{scopeToSelection ? scopeLabel : "Whole design"}</span>
            {scopeToSelection && <ActionIcons.dismiss className="size-2.5 shrink-0" aria-hidden />}
          </button>
        )}

        <input
          ref={inputRef}
          type="text"
          value={draft}
          disabled={blocked}
          onChange={(event) => setDraft(event.target.value)}
          // The editor listens for bare keys on window (V for the frame tool, ⌫
          // to delete the selection). Typing "Delete the header" here must not
          // do exactly that.
          onKeyDown={(event) => event.stopPropagation()}
          placeholder={
            blocked
              ? "Apply or reject Juno's change first"
              : scoped
                ? `Change ${scopeLabel}…`
                : "Ask Juno to change this design…"
          }
          aria-label="Ask Juno to change this design"
          className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />

        <Button
          type="submit"
          size="icon-sm"
          disabled={!draft.trim() || busy || blocked}
          aria-label={busy ? "Juno is working" : "Ask Juno"}
          className="shrink-0 rounded-field"
        >
          {busy ? <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden /> : <ArrowUp className="size-4" aria-hidden />}
        </Button>
      </form>
    </div>
  );
});
