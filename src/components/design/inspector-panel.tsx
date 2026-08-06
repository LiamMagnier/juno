"use client";

/**
 * The contextual property inspector.
 *
 * Every field here writes through the same `updateNode` operation the canvas
 * and the AI use, so a typed value, a dragged handle and an accepted proposal
 * are indistinguishable to the undo stack. Fields only appear for properties
 * the selected node type actually has — an inspector that shows a corner radius
 * for a line is an inspector that lies.
 *
 * With more than one layer selected the same rule applies to values. A field
 * whose layers disagree reads "Mixed" instead of quietly showing the first
 * one's, and every write is built per layer, so setting a stroke's weight
 * cannot carry the first layer's colour onto the rest — which is exactly what
 * reading from `nodes[0]` and writing to all of them used to do.
 *
 * Fill and Effects live in `effects-panel.tsx`. They are big enough to earn a
 * file, and they are the two sections that are direct manipulation rather than
 * fields — a gradient axis and a stop ramp are dragged, not typed. That file
 * also owns the field primitives this one is built from, because it is the leaf
 * of the pair and a cycle between them would ship inside the Mac bundle.
 */

import * as React from "react";
import { toast } from "sonner";
import {
  ColorField,
  EffectsSection,
  FillControl,
  NumberField,
  Section,
  SelectField,
  TextField,
} from "@/components/design/effects-panel";
import { readImageAsset } from "@/components/design/use-design-document";
import { hexToRgba, rgbaToHex } from "@/lib/design/variables";
import { isContainer, type AutoLayout, type DesignDocument, type DesignNode, type ImageNode, type NodeId } from "@/lib/design/types";
import type { DesignOperation, NodePatch } from "@/lib/design/operations";

interface Props {
  document: DesignDocument;
  selection: NodeId[];
  onApply: (operations: DesignOperation[], summary: string) => void;
  readOnly?: boolean;
}

/** A value read across the selection: `mixed` when the layers disagree. */
interface Shared<T> {
  value: T;
  mixed: boolean;
}

function shared<T>(nodes: DesignNode[], read: (node: DesignNode) => T): Shared<T> {
  const value = read(nodes[0]);
  const first = JSON.stringify(value ?? null);
  return { value, mixed: nodes.some((node) => JSON.stringify(read(node) ?? null) !== first) };
}

export function InspectorPanel({ document: doc, selection, onApply, readOnly }: Props) {
  const nodes = selection.map((id) => doc.nodes[id]).filter((n): n is DesignNode => !!n);

  if (nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center px-4 text-center">
        <p className="text-caption text-muted-foreground">Select a layer to edit its properties.</p>
      </div>
    );
  }

  // A locked layer is left out of every write; it still counts for what the
  // fields report, because it is still selected and still on screen.
  const editable = nodes.filter((n) => !n.locked);

  /** Write the same fields to every editable layer. Only ever the fields the
   *  user just touched — never a value read back off another layer. */
  const patchAll = (patch: NodePatch, summary: string) =>
    onApply(
      editable.map((n) => ({ op: "updateNode" as const, nodeId: n.id, patch })),
      summary
    );

  /** Write a patch computed from each layer's own state, for fields that live
   *  inside a structure the layer already owns (a stroke, its constraints). */
  const patchEach = (build: (node: DesignNode) => NodePatch | null, summary: string) => {
    const operations = editable.flatMap((n) => {
      const patch = build(n);
      return patch ? [{ op: "updateNode" as const, nodeId: n.id, patch }] : [];
    });
    if (operations.length) onApply(operations, summary);
  };

  const first = nodes[0];
  const single = nodes.length === 1 ? first : null;
  const allSameType = nodes.every((n) => n.type === first.type);

  const x = shared(nodes, (n) => n.x);
  const y = shared(nodes, (n) => n.y);
  const width = shared(nodes, (n) => n.width);
  const height = shared(nodes, (n) => n.height);
  const rotation = shared(nodes, (n) => n.rotation);
  const opacity = shared(nodes, (n) => n.opacity);
  const widthMode = shared(nodes, (n) => n.widthMode);
  const heightMode = shared(nodes, (n) => n.heightMode);
  const horizontal = shared(nodes, (n) => n.constraints.horizontal);
  const vertical = shared(nodes, (n) => n.constraints.vertical);
  const radius = shared(nodes, (n) => (typeof n.cornerRadius === "number" ? n.cornerRadius : n.cornerRadius[0]));
  const strokeColor = shared(nodes, (n) => (n.strokes[0]?.paint.type === "solid" ? rgbaToHex(n.strokes[0].paint.color) : ""));
  const strokeWeight = shared(nodes, (n) => n.strokes[0]?.weight ?? 0);
  const hasStroke = nodes.some((n) => n.strokes.length > 0);

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
      <Section title={nodes.length === 1 ? first.name : `${nodes.length} layers selected`}>
        {single && (
          <TextField
            label="Name"
            value={single.name}
            disabled={readOnly}
            onCommit={(value) => value !== single.name && patchAll({ name: value }, "Rename layer")}
          />
        )}
      </Section>

      <Section title="Position & size">
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField label="X" value={x.value} mixed={x.mixed} disabled={readOnly} onCommit={(v) => patchAll({ x: v }, "Set position")} />
          <NumberField label="Y" value={y.value} mixed={y.mixed} disabled={readOnly} onCommit={(v) => patchAll({ y: v }, "Set position")} />
          <NumberField
            label="W"
            value={width.value}
            mixed={width.mixed}
            min={0}
            disabled={readOnly}
            onCommit={(v) => patchAll({ width: v, widthMode: "fixed" }, "Set size")}
          />
          <NumberField
            label="H"
            value={height.value}
            mixed={height.mixed}
            min={0}
            disabled={readOnly}
            onCommit={(v) => patchAll({ height: v, heightMode: "fixed" }, "Set size")}
          />
          <NumberField
            label="Rotate"
            value={rotation.value}
            mixed={rotation.mixed}
            suffix="°"
            disabled={readOnly}
            onCommit={(v) => patchAll({ rotation: v }, "Rotate")}
          />
          <NumberField
            label="Opacity"
            value={Math.round(opacity.value * 100)}
            mixed={opacity.mixed}
            min={0}
            max={100}
            suffix="%"
            disabled={readOnly}
            onCommit={(v) => patchAll({ opacity: Math.max(0, Math.min(1, v / 100)) }, "Set opacity")}
          />
        </div>
        <div className="grid grid-cols-2 gap-1.5 pt-1.5">
          <SelectField
            label="Width"
            value={widthMode.value}
            mixed={widthMode.mixed}
            options={SIZING_OPTIONS}
            disabled={readOnly}
            onChange={(v) => patchAll({ widthMode: v as NodePatch["widthMode"] }, "Set width behaviour")}
          />
          <SelectField
            label="Height"
            value={heightMode.value}
            mixed={heightMode.mixed}
            options={SIZING_OPTIONS}
            disabled={readOnly}
            onChange={(v) => patchAll({ heightMode: v as NodePatch["heightMode"] }, "Set height behaviour")}
          />
        </div>
      </Section>

      <Section title="Constraints">
        <div className="grid grid-cols-2 gap-1.5">
          <SelectField
            label="Horizontal"
            value={horizontal.value}
            mixed={horizontal.mixed}
            options={CONSTRAINT_OPTIONS}
            disabled={readOnly}
            onChange={(v) =>
              onApply(
                editable.map((n) => ({
                  op: "setConstraints" as const,
                  nodeIds: [n.id],
                  constraints: { ...n.constraints, horizontal: v as never },
                })),
                "Set constraints"
              )
            }
          />
          <SelectField
            label="Vertical"
            value={vertical.value}
            mixed={vertical.mixed}
            options={CONSTRAINT_OPTIONS}
            disabled={readOnly}
            onChange={(v) =>
              onApply(
                editable.map((n) => ({
                  op: "setConstraints" as const,
                  nodeIds: [n.id],
                  constraints: { ...n.constraints, vertical: v as never },
                })),
                "Set constraints"
              )
            }
          />
        </div>
      </Section>

      {single && isContainer(single) && <AutoLayoutSection node={single} onApply={onApply} readOnly={readOnly} />}

      {allSameType && first.type !== "line" && (
        <Section title="Appearance">
          <NumberField
            label="Corner radius"
            value={radius.value}
            mixed={radius.mixed}
            min={0}
            disabled={readOnly}
            onCommit={(v) => patchAll({ cornerRadius: v }, "Set corner radius")}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <ColorField
              label="Stroke"
              value={strokeColor.value}
              mixed={strokeColor.mixed}
              disabled={readOnly}
              onCommit={(hex) => {
                const color = hexToRgba(hex);
                if (!color) return;
                // Weight and alignment are each layer's own; only the colour was
                // asked for.
                patchEach(
                  (n) => ({
                    strokes: [{ paint: { type: "solid", color }, weight: n.strokes[0]?.weight ?? 1, align: n.strokes[0]?.align ?? "center" }],
                  }),
                  "Set stroke"
                );
              }}
              onClear={hasStroke ? () => patchAll({ strokes: [] }, "Remove stroke") : undefined}
            />
            {hasStroke && (
              <NumberField
                label="Weight"
                value={strokeWeight.value}
                mixed={strokeWeight.mixed}
                min={0}
                disabled={readOnly}
                onCommit={(v) => patchEach((n) => (n.strokes[0] ? { strokes: [{ ...n.strokes[0], weight: v }] } : null), "Set stroke weight")}
              />
            )}
          </div>
        </Section>
      )}

      {/* A line is drawn from its stroke and has no interior, so a fill control
          on one is a control that does nothing. Effects are a different matter:
          a line casts a shadow like anything else. */}
      {first.type !== "line" && <FillControl nodes={nodes} editable={editable} onApply={onApply} readOnly={readOnly} />}

      <EffectsSection nodes={nodes} editable={editable} onApply={onApply} readOnly={readOnly} />

      {single?.type === "image" && <ImageSection node={single} document={doc} onApply={onApply} readOnly={readOnly} />}

      {single?.type === "text" && (
        <Section title="Typography">
          <TextField
            label="Text"
            value={single.characters}
            multiline
            disabled={readOnly}
            onCommit={(value) => value !== single.characters && patchAll({ characters: value }, "Edit text")}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <NumberField
              label="Size"
              value={single.typography.fontSize}
              min={1}
              disabled={readOnly}
              onCommit={(v) => patchAll({ typography: { fontSize: v } }, "Set font size")}
            />
            <NumberField
              label="Weight"
              value={single.typography.fontWeight}
              min={100}
              max={900}
              step={100}
              disabled={readOnly}
              onCommit={(v) => patchAll({ typography: { fontWeight: v } }, "Set font weight")}
            />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <TextField
              label="Family"
              value={single.typography.fontFamily}
              disabled={readOnly}
              onCommit={(v) => v && patchAll({ typography: { fontFamily: v } }, "Set typeface")}
            />
            <SelectField
              label="Align"
              value={single.typography.textAlign}
              options={[
                { value: "left", label: "Left" },
                { value: "center", label: "Center" },
                { value: "right", label: "Right" },
                { value: "justify", label: "Justify" },
              ]}
              disabled={readOnly}
              onChange={(v) => patchAll({ typography: { textAlign: v as never } }, "Set text alignment")}
            />
          </div>
        </Section>
      )}

      {Object.keys(doc.variables).length > 0 && single && (
        <Section title="Variables">
          <SelectField
            label="Fill token"
            value={single.boundVariables["fills.0.color"] ?? ""}
            options={[
              { value: "", label: "None" },
              ...Object.values(doc.variables)
                .filter((v) => v.type === "color")
                .map((v) => ({ value: v.id, label: v.name })),
            ]}
            disabled={readOnly}
            onChange={(variableId) =>
              onApply(
                [{ op: "bindVariable", nodeId: single.id, property: "fills.0.color", variableId: variableId || null }],
                variableId ? "Bind fill token" : "Unbind fill token"
              )
            }
          />
        </Section>
      )}
    </div>
  );
}

const SIZING_OPTIONS = [
  { value: "fixed", label: "Fixed" },
  { value: "hug", label: "Hug" },
  { value: "fill", label: "Fill" },
];

const CONSTRAINT_OPTIONS = [
  { value: "min", label: "Start" },
  { value: "max", label: "End" },
  { value: "center", label: "Center" },
  { value: "stretch", label: "Stretch" },
  { value: "scale", label: "Scale" },
];

function AutoLayoutSection({
  node,
  onApply,
  readOnly,
}: {
  node: DesignNode & { layout: AutoLayout | null };
  onApply: (operations: DesignOperation[], summary: string) => void;
  readOnly?: boolean;
}) {
  const layout = node.layout;
  const set = (next: AutoLayout | null, summary: string) => onApply([{ op: "setAutoLayout", nodeId: node.id, layout: next }], summary);

  if (!layout) {
    return (
      <Section title="Auto layout">
        <button
          type="button"
          disabled={readOnly}
          onClick={() =>
            set(
              {
                direction: "vertical",
                padding: { top: 16, right: 16, bottom: 16, left: 16 },
                gap: 12,
                align: "start",
                justify: "start",
                wrap: false,
              },
              "Enable auto layout"
            )
          }
          className="pressable w-full rounded-[10px] border border-border/60 px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground coarse:min-h-10"
        >
          Add auto layout
        </button>
      </Section>
    );
  }

  const patch = (partial: Partial<AutoLayout>, summary: string) => set({ ...layout, ...partial }, summary);

  return (
    <Section
      title="Auto layout"
      action={
        <button
          type="button"
          disabled={readOnly}
          onClick={() => set(null, "Remove auto layout")}
          className="pressable rounded px-1 font-mono text-[10px] text-muted-foreground hover:text-destructive"
        >
          Remove
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-1.5">
        <SelectField
          label="Direction"
          value={layout.direction}
          options={[
            { value: "vertical", label: "Vertical" },
            { value: "horizontal", label: "Horizontal" },
            { value: "grid", label: "Grid" },
          ]}
          disabled={readOnly}
          onChange={(v) => patch({ direction: v as AutoLayout["direction"] }, "Set layout direction")}
        />
        <NumberField label="Gap" value={layout.gap} min={0} disabled={readOnly} onCommit={(v) => patch({ gap: v }, "Set gap")} />
      </div>
      <div className="grid grid-cols-4 gap-1.5">
        {(["top", "right", "bottom", "left"] as const).map((side) => (
          <NumberField
            key={side}
            label={side[0].toUpperCase() + side.slice(1, 3)}
            value={layout.padding[side]}
            min={0}
            disabled={readOnly}
            onCommit={(v) => patch({ padding: { ...layout.padding, [side]: v } }, "Set padding")}
          />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <SelectField
          label="Align"
          value={layout.align}
          options={[
            { value: "start", label: "Start" },
            { value: "center", label: "Center" },
            { value: "end", label: "End" },
            { value: "baseline", label: "Baseline" },
          ]}
          disabled={readOnly}
          onChange={(v) => patch({ align: v as AutoLayout["align"] }, "Set alignment")}
        />
        <SelectField
          label="Distribute"
          value={layout.justify}
          options={[
            { value: "start", label: "Start" },
            { value: "center", label: "Center" },
            { value: "end", label: "End" },
            { value: "space-between", label: "Space between" },
            { value: "space-around", label: "Space around" },
            { value: "space-evenly", label: "Space evenly" },
          ]}
          disabled={readOnly}
          onChange={(v) => patch({ justify: v as AutoLayout["justify"] }, "Set distribution")}
        />
      </div>
      {layout.direction === "grid" && (
        <NumberField
          label="Columns"
          value={layout.columns ?? 2}
          min={1}
          max={64}
          disabled={readOnly}
          onCommit={(v) => patch({ columns: Math.round(v) }, "Set columns")}
        />
      )}
      {layout.direction === "horizontal" && (
        <label className="flex items-center gap-2 pt-1 text-xs text-muted-foreground">
          <input type="checkbox" checked={layout.wrap} disabled={readOnly} onChange={(e) => patch({ wrap: e.target.checked }, "Set wrapping")} />
          Wrap
        </label>
      )}
    </Section>
  );
}

/**
 * The picture behind an image layer.
 *
 * An image layer has no meaning without an asset, so this is where one is
 * chosen — the file is read into a data URL and put in the same transaction as
 * the layer that points at it, which is what makes the change undoable in one
 * step and impossible to half-apply. The asset it replaces is dropped in the
 * same transaction when nothing else uses it: a document carries its pictures
 * inside itself and shares one size budget with them, so an orphan is not free.
 */
function ImageSection({
  node,
  document: doc,
  onApply,
  readOnly,
}: {
  node: ImageNode;
  document: DesignDocument;
  onApply: (operations: DesignOperation[], summary: string) => void;
  readOnly?: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const asset = doc.assets[node.assetId];

  const choose = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const chosen = await readImageAsset(file);
      const operations: DesignOperation[] = [
        { op: "createAsset", asset: chosen },
        { op: "updateNode", nodeId: node.id, patch: { assetId: chosen.id } },
      ];
      if (asset && !isAssetUsedElsewhere(doc, asset.id, node.id)) {
        operations.push({ op: "deleteAsset", assetId: asset.id });
      }
      onApply(operations, asset ? "Replace image" : "Set image");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not read that image.");
    }
  };

  return (
    <Section title="Image">
      <p className="truncate font-mono text-[10px] text-muted-foreground">
        {asset ? `${Math.round(asset.width)} × ${Math.round(asset.height)} ${asset.mimeType.replace("image/", "").toUpperCase()}` : "No picture yet"}
      </p>
      <button
        type="button"
        disabled={readOnly}
        onClick={() => inputRef.current?.click()}
        className="pressable w-full rounded-[10px] border border-border/60 px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 coarse:min-h-10"
      >
        {asset ? "Replace picture…" : "Choose a picture…"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="sr-only"
        tabIndex={-1}
        aria-hidden
        onChange={choose}
      />
      <SelectField
        label="Scaling"
        value={node.scaleMode}
        options={[
          { value: "fill", label: "Fill" },
          { value: "fit", label: "Fit" },
          { value: "stretch", label: "Stretch" },
          { value: "tile", label: "Tile" },
        ]}
        disabled={readOnly}
        onChange={(v) => onApply([{ op: "updateNode", nodeId: node.id, patch: { scaleMode: v as ImageNode["scaleMode"] } }], "Set image scaling")}
      />
    </Section>
  );
}

/** Whether anything other than `exceptNodeId` still needs this picture — an
 *  image layer, or any node using it as an image fill. */
function isAssetUsedElsewhere(doc: DesignDocument, assetId: string, exceptNodeId: NodeId): boolean {
  return Object.values(doc.nodes).some((node) => {
    if (node.id === exceptNodeId) return false;
    if (node.type === "image" && node.assetId === assetId) return true;
    return node.fills.some((paint) => paint.type === "image" && paint.assetId === assetId);
  });
}
