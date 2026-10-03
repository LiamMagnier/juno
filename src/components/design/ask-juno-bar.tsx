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
import { AnimatePresence, motion } from "framer-motion";
import { Loader2, Send } from "@/components/ui/icons";
import { ActionIcons, StatusIcons } from "@/lib/app-icons";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { IconSwap } from "@/components/ui/icon-swap";
import { requestDesignEdit, DesignEditRequestError, type DesignEditProposal } from "@/components/design/design-edit-transport";
import type { DesignEditorHandle } from "@/components/design/design-editor";
import type { NodeId } from "@/lib/design/types";
import { variants } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { PRODUCT_NAME } from "@/lib/brand/names";

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
      setError(err instanceof DesignEditRequestError ? err.message : `${PRODUCT_NAME} could not reach the design.`);
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
            "mb-2 flex items-start gap-2 rounded-menu border px-3 py-2 text-caption leading-5 motion-safe:animate-rise-in",
            // The neutral strip is a floating layer like any other, so it takes the
            // shared material rather than a fourth hand-mixed one (/95 fill, /70
            // hairline, blur-xl, no shadow). The error strip keeps its own tint.
            error ? "border-destructive/30 bg-destructive/10 text-destructive" : "overlay-glass"
          )}
          role={error ? "alert" : "status"}
        >
          {/* A failure carries the failure mark, in its own colour, on the
              first line's centre — the same circle every error in the product
              draws. Juno's answer needs no glyph: the sentence is the answer. */}
          {error && <StatusIcons.error className="mt-[3px] size-3.5 shrink-0" aria-hidden />}
          <span className="min-w-0">{error ?? note}</span>
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
        // The one edge on the canvas that must be found: it darkens while the
        // field has focus, the way the composer's does.
        // `p-1` on every side: the scope chip and the send key are 8px keys
        // seated 4px inside a 12px shell (12 − 4 = 8). It was `p-1.5 pl-2.5`,
        // which seated them 6px in (wanting 6) and gave the left corner a
        // different inset from the right. The field carries its own left
        // padding instead, so the placeholder still starts where it did.
        className="flex items-center gap-2 rounded-popover overlay-glass p-1 transition-colors duration-fast ease-out-soft focus-within:border-foreground/30"
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
            title={scopeToSelection ? "Only this selection will change" : `${PRODUCT_NAME} may change anything in the document`}
            className={cn(
              // `.pressable` eases the fill and ink itself; a `transition-*`
              // utility here replaced its shorthand and snapped the press.
              "pressable flex max-w-[10rem] shrink-0 items-center gap-1 rounded-control px-2 py-1 font-mono text-micro",
              scopeToSelection
                ? "bg-primary/10 text-primary hover:bg-primary/15"
                : "bg-muted/60 text-muted-foreground hover:bg-accent hover:text-foreground"
            )}
          >
            <span className="truncate">{scopeToSelection ? scopeLabel : "Whole design"}</span>
            {/* 12px, the floor of the ladder — it was 10px, below the size the
                set is drawn to survive at. It cross-fades out when the scope
                is widened rather than vanishing in the frame the label
                changes, and holds its place while it goes (`sync`, not
                `popLayout`: a popped mark would fade over the new label or
                off the end of a narrower pill). The fade and scale live on a
                wrapper, so the glyph's own hover turn still composes. */}
            <AnimatePresence initial={false}>
              {scopeToSelection && (
                <motion.span
                  key="scope-dismiss"
                  variants={variants.swap}
                  initial="hidden"
                  animate="visible"
                  exit="exit"
                  className="flex shrink-0"
                  aria-hidden
                >
                  <ActionIcons.dismiss className="size-3 shrink-0" aria-hidden />
                </motion.span>
              )}
            </AnimatePresence>
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
              ? `Apply or reject ${PRODUCT_NAME}'s change first`
              : scoped
                ? `Change ${scopeLabel}…`
                : `Ask ${PRODUCT_NAME} to change this design…`
          }
          aria-label={`Ask ${PRODUCT_NAME} to change this design`}
          className="min-w-0 flex-1 bg-transparent px-1 py-1.5 text-ui outline-none first:pl-2.5 placeholder:text-muted-foreground disabled:opacity-60"
        />

        {/* The hint says what the accessible name says. Radix closes it on
            the click that sends, so it never hangs over the busy key. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="submit"
              size="icon-sm"
              disabled={!draft.trim() || busy || blocked}
              aria-label={busy ? `${PRODUCT_NAME} is working` : `Ask ${PRODUCT_NAME}`}
              // `control` (8), not `field` (10): the bar is a 12px shell with
              // `p-1` (4), so its seated controls are 12 − 4 = 8.
              className="shrink-0 rounded-control"
            >
              {/* Send and busy share one key and cross-fade — the arrow does not
                  vanish in a frame the moment the request leaves. */}
              <IconSwap
                curve="spring"
                swapped={busy}
                from={<Send className="size-4" />}
                to={<Loader2 className={cn("size-4", busy && "motion-safe:animate-spin")} />}
              />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{busy ? `${PRODUCT_NAME} is working` : `Ask ${PRODUCT_NAME}`}</TooltipContent>
        </Tooltip>
      </form>
    </div>
  );
});
