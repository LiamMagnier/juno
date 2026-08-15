"use client";

/**
 * The controls Juno offers alongside a change it just made.
 *
 * This is the half of "ask, then tune by hand" that the prompt bar cannot do:
 * having asked for a rounder button, the next question is always *how* round,
 * and asking again in words to move a radius by two points is a bad trade. So
 * the model may attach a slider, a colour well or a segmented switch, and the
 * user finishes the job by dragging.
 *
 * The authority here is deliberately ordinary. An adjustment names a document
 * property from a fixed list (`adjustmentSchema`), and moving it emits the same
 * `updateNode` / `setVariableMode` operation the inspector emits — validated by
 * the same layer, landing on the same undo stack. An AI-generated control has
 * exactly the reach a hand-written inspector field has, and not a step more.
 */

import * as React from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ColorField } from "@/components/design/effects-panel";
import type { DesignEditorHandle } from "@/components/design/design-editor";
import type { DesignAdjustment } from "@/lib/design/ai";
import type { DesignOperation } from "@/lib/design/operations";
import { hexToRgba } from "@/lib/design/variables";
import type { DesignDocument, Paint } from "@/lib/design/types";
import { cn } from "@/lib/utils";

interface Props {
  adjustments: DesignAdjustment[];
  /** Read when an operation is built, so a control never writes against a scene
   *  the user has since changed underneath it. */
  editor: React.MutableRefObject<DesignEditorHandle | null>;
  onDismiss: () => void;
}

export function DesignAdjustments({ adjustments, editor, onDismiss }: Props) {
  const commit = React.useCallback(
    (adjustment: DesignAdjustment, value: number | string) => {
      const doc = editor.current?.document();
      if (!doc) return;
      const operations = adjustmentOperations(doc, adjustment, value);
      if (operations.length > 0) editor.current?.apply(operations, adjustment.label);
    },
    [editor]
  );

  if (adjustments.length === 0) return null;

  return (
    <div className="pointer-events-auto mx-auto w-full max-w-2xl rounded-card border border-border/70 bg-popover/95 p-3 shadow-soft backdrop-blur-xl motion-safe:animate-rise-in">
      <div className="flex items-center justify-between pb-2">
        <h2 className="font-mono text-micro text-muted-foreground">Tune Juno’s change</h2>
        <Button variant="ghost" size="icon-sm" onClick={onDismiss} aria-label="Hide these controls" className="text-muted-foreground hover:text-foreground">
          <X className="size-3.5" aria-hidden />
        </Button>
      </div>
      <div className="space-y-2.5">
        {adjustments.map((adjustment, index) => (
          <AdjustmentRow key={`${adjustment.control}-${index}`} adjustment={adjustment} onCommit={(value) => commit(adjustment, value)} />
        ))}
      </div>
    </div>
  );
}

function AdjustmentRow({ adjustment, onCommit }: { adjustment: DesignAdjustment; onCommit: (value: number | string) => void }) {
  if (adjustment.control === "slider") return <SliderRow adjustment={adjustment} onCommit={onCommit} />;
  if (adjustment.control === "color") return <ColorRow adjustment={adjustment} onCommit={onCommit} />;
  return <SegmentedRow adjustment={adjustment} onCommit={onCommit} />;
}

type SliderAdjustment = Extract<DesignAdjustment, { control: "slider" }>;
type ColorAdjustment = Extract<DesignAdjustment, { control: "color" }>;
type SegmentedAdjustment = Extract<DesignAdjustment, { control: "segmented" }>;

function SliderRow({ adjustment, onCommit }: { adjustment: SliderAdjustment; onCommit: (value: number) => void }) {
  const [value, setValue] = React.useState(adjustment.value);
  return (
    <label className="block">
      <span className="flex items-baseline justify-between pb-1">
        <span className="truncate text-xs">{adjustment.label}</span>
        <span className="shrink-0 font-mono text-micro text-muted-foreground tabular-nums">{round(value)}</span>
      </span>
      <input
        type="range"
        min={adjustment.min}
        max={adjustment.max}
        step={adjustment.step}
        value={value}
        onChange={(event) => setValue(Number(event.target.value))}
        // One transaction per gesture, not per pixel. The canvas draws a drag as
        // a ghost outline and only commits on release for the same reason: every
        // committed transaction is a stored artifact version and an undo step,
        // and a slider that wrote one per frame would bury both.
        onPointerUp={() => onCommit(value)}
        onKeyUp={() => onCommit(value)}
        onBlur={() => onCommit(value)}
        onKeyDown={(event) => event.stopPropagation()}
        className="w-full accent-primary coarse:min-h-9"
      />
    </label>
  );
}

/**
 * The colour well Juno can attach to a change it just made.
 *
 * The same `ColorField` the inspector uses, rather than a second native
 * `<input type="color">`. This card floats over the canvas a few pixels from
 * the Ask Juno bar and the review card, both of which are the product's own
 * material; an OS-drawn colour well in the middle of them was the one control
 * on this surface the app did not draw. It also gains what that input never
 * had — a typable hex field, and one transaction per pause instead of one per
 * frame of a cursor sweep.
 */
function ColorRow({ adjustment, onCommit }: { adjustment: ColorAdjustment; onCommit: (value: string) => void }) {
  const [value, setValue] = React.useState(adjustment.value.slice(0, 7));
  return (
    <ColorField
      label={adjustment.label}
      value={value}
      onCommit={(hex) => {
        // Kept locally as well as sent: the control is uncontrolled from the
        // document's side, and re-reading the adjustment would show the value
        // this card was created with rather than the one under the cursor.
        setValue(hex);
        onCommit(hex);
      }}
    />
  );
}

function SegmentedRow({ adjustment, onCommit }: { adjustment: SegmentedAdjustment; onCommit: (value: string) => void }) {
  const [value, setValue] = React.useState(adjustment.value);
  return (
    <div>
      <p className="truncate pb-1 text-xs">{adjustment.label}</p>
      <div className="flex flex-wrap gap-1" role="group" aria-label={adjustment.label}>
        {adjustment.options.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={value === option.value}
            onClick={() => {
              setValue(option.value);
              onCommit(option.value);
            }}
            className={cn(
              "pressable rounded-control px-2 py-1 text-xs transition-colors duration-fast coarse:min-h-9",
              value === option.value ? "bg-primary/10 text-primary" : "bg-muted/60 text-muted-foreground hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Adjustment → operations
// ---------------------------------------------------------------------------

/** Nodes the adjustment names that still exist and are not locked. A control
 *  left over from a change the user has since undone simply does nothing. */
function livingTargets(doc: DesignDocument, nodeIds: string[]) {
  return nodeIds.flatMap((id) => {
    const node = doc.nodes[id];
    return node && !node.locked ? [node] : [];
  });
}

export function adjustmentOperations(doc: DesignDocument, adjustment: DesignAdjustment, raw: number | string): DesignOperation[] {
  if (adjustment.control === "slider" && typeof raw === "number") {
    // The model chooses the slider's range, but the document model owns what a
    // property may hold — opacity outside 0..1 would be refused by the operation
    // layer and surface as an error toast under the user's thumb.
    const value = adjustment.property === "opacity" ? Math.max(0, Math.min(1, raw)) : raw;
    return livingTargets(doc, adjustment.nodeIds).map((node) => ({
      op: "updateNode",
      nodeId: node.id,
      // Dragging a width slider on a hugging or filling node has to pin the
      // sizing mode too, or the layout engine recomputes the value away — the
      // same pairing the inspector's W/H fields make.
      patch:
        adjustment.property === "width"
          ? { width: value, widthMode: "fixed" }
          : adjustment.property === "height"
            ? { height: value, heightMode: "fixed" }
            : adjustment.property === "cornerRadius"
              ? { cornerRadius: value }
              : adjustment.property === "rotation"
                ? { rotation: value }
                : adjustment.property === "opacity"
                  ? { opacity: value }
                  : adjustment.property === "x"
                    ? { x: value }
                    : { y: value },
    }));
  }

  if (adjustment.control === "color" && typeof raw === "string") {
    const color = hexToRgba(raw);
    if (!color) return [];
    return livingTargets(doc, adjustment.nodeIds).map((node) => {
      const [first, ...rest] = node.fills;
      // `fills.0.color` has no meaning on a gradient or an image fill, so a
      // colour control replaces it with the solid the user picked rather than
      // pretending to recolour something that has no single colour.
      const solid: Paint = first && first.type === "solid" ? { ...first, color } : { type: "solid", color };
      return { op: "updateNode", nodeId: node.id, patch: { fills: [solid, ...rest] } };
    });
  }

  if (adjustment.control === "segmented" && typeof raw === "string") {
    if (adjustment.kind === "variable-mode") {
      if (!doc.collections[adjustment.targetId]) return [];
      return [{ op: "setVariableMode", collectionId: adjustment.targetId, modeId: raw }];
    }
    const node = doc.nodes[adjustment.targetId];
    if (!node || node.locked || node.type !== "instance" || !adjustment.property) return [];
    return [
      {
        op: "updateNode",
        nodeId: node.id,
        patch: { variantProperties: { ...node.variantProperties, [adjustment.property]: raw } },
      },
    ];
  }

  return [];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
