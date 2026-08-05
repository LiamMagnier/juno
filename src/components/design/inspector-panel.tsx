"use client";

/**
 * The contextual property inspector.
 *
 * Every field here writes through the same `updateNode` operation the canvas
 * and the AI use, so a typed value, a dragged handle and an accepted proposal
 * are indistinguishable to the undo stack. Fields only appear for properties
 * the selected node type actually has — an inspector that shows a corner radius
 * for a line is an inspector that lies.
 */

import * as React from "react";
import { hexToRgba, rgbaToHex } from "@/lib/design/variables";
import { isContainer, type AutoLayout, type DesignDocument, type DesignNode, type NodeId } from "@/lib/design/types";
import type { DesignOperation, NodePatch } from "@/lib/design/operations";
import { cn } from "@/lib/utils";

interface Props {
  document: DesignDocument;
  selection: NodeId[];
  onApply: (operations: DesignOperation[], summary: string) => void;
  readOnly?: boolean;
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

  const patchAll = (patch: NodePatch, summary: string) =>
    onApply(
      nodes.filter((n) => !n.locked).map((n) => ({ op: "updateNode" as const, nodeId: n.id, patch })),
      summary
    );

  const first = nodes[0];
  const single = nodes.length === 1 ? first : null;
  const allSameType = nodes.every((n) => n.type === first.type);

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
          <NumberField label="X" value={first.x} disabled={readOnly} onCommit={(v) => patchAll({ x: v }, "Set position")} />
          <NumberField label="Y" value={first.y} disabled={readOnly} onCommit={(v) => patchAll({ y: v }, "Set position")} />
          <NumberField label="W" value={first.width} min={0} disabled={readOnly} onCommit={(v) => patchAll({ width: v, widthMode: "fixed" }, "Set size")} />
          <NumberField label="H" value={first.height} min={0} disabled={readOnly} onCommit={(v) => patchAll({ height: v, heightMode: "fixed" }, "Set size")} />
          <NumberField label="Rotate" value={first.rotation} suffix="°" disabled={readOnly} onCommit={(v) => patchAll({ rotation: v }, "Rotate")} />
          <NumberField
            label="Opacity"
            value={Math.round(first.opacity * 100)}
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
            value={first.widthMode}
            options={[
              { value: "fixed", label: "Fixed" },
              { value: "hug", label: "Hug" },
              { value: "fill", label: "Fill" },
            ]}
            disabled={readOnly}
            onChange={(v) => patchAll({ widthMode: v as NodePatch["widthMode"] }, "Set width behaviour")}
          />
          <SelectField
            label="Height"
            value={first.heightMode}
            options={[
              { value: "fixed", label: "Fixed" },
              { value: "hug", label: "Hug" },
              { value: "fill", label: "Fill" },
            ]}
            disabled={readOnly}
            onChange={(v) => patchAll({ heightMode: v as NodePatch["heightMode"] }, "Set height behaviour")}
          />
        </div>
      </Section>

      <Section title="Constraints">
        <div className="grid grid-cols-2 gap-1.5">
          <SelectField
            label="Horizontal"
            value={first.constraints.horizontal}
            options={CONSTRAINT_OPTIONS}
            disabled={readOnly}
            onChange={(v) =>
              onApply(
                [{ op: "setConstraints", nodeIds: nodes.map((n) => n.id), constraints: { ...first.constraints, horizontal: v as never } }],
                "Set constraints"
              )
            }
          />
          <SelectField
            label="Vertical"
            value={first.constraints.vertical}
            options={CONSTRAINT_OPTIONS}
            disabled={readOnly}
            onChange={(v) =>
              onApply(
                [{ op: "setConstraints", nodeIds: nodes.map((n) => n.id), constraints: { ...first.constraints, vertical: v as never } }],
                "Set constraints"
              )
            }
          />
        </div>
      </Section>

      {single && isContainer(single) && (
        <AutoLayoutSection node={single} onApply={onApply} readOnly={readOnly} />
      )}

      {allSameType && first.type !== "line" && (
        <Section title="Appearance">
          <NumberField
            label="Corner radius"
            value={typeof first.cornerRadius === "number" ? first.cornerRadius : first.cornerRadius[0]}
            min={0}
            disabled={readOnly}
            onCommit={(v) => patchAll({ cornerRadius: v }, "Set corner radius")}
          />
          <ColorField
            label="Fill"
            value={first.fills[0]?.type === "solid" ? rgbaToHex(first.fills[0].color) : ""}
            disabled={readOnly}
            onCommit={(hex) => {
              const color = hexToRgba(hex);
              if (color) patchAll({ fills: [{ type: "solid", color }] }, "Set fill");
            }}
            onClear={first.fills.length > 0 ? () => patchAll({ fills: [] }, "Remove fill") : undefined}
          />
          <div className="grid grid-cols-2 gap-1.5">
            <ColorField
              label="Stroke"
              value={first.strokes[0]?.paint.type === "solid" ? rgbaToHex(first.strokes[0].paint.color) : ""}
              disabled={readOnly}
              onCommit={(hex) => {
                const color = hexToRgba(hex);
                if (color) {
                  patchAll(
                    { strokes: [{ paint: { type: "solid", color }, weight: first.strokes[0]?.weight ?? 1, align: first.strokes[0]?.align ?? "center" }] },
                    "Set stroke"
                  );
                }
              }}
              onClear={first.strokes.length > 0 ? () => patchAll({ strokes: [] }, "Remove stroke") : undefined}
            />
            {first.strokes[0] && (
              <NumberField
                label="Weight"
                value={first.strokes[0].weight}
                min={0}
                disabled={readOnly}
                onCommit={(v) => patchAll({ strokes: [{ ...first.strokes[0], weight: v }] }, "Set stroke weight")}
              />
            )}
          </div>
        </Section>
      )}

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

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between">
        <h3 className="truncate font-mono text-[10px] text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

const fieldClass =
  "w-full rounded-[8px] border border-border/60 bg-background px-2 py-1 text-xs tabular-nums outline-none transition-colors focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/20 disabled:opacity-50 coarse:min-h-9";

function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  // Uncontrolled while focused so typing "12" does not fight a re-render at "1".
  const [draft, setDraft] = React.useState<string | null>(null);
  const shown = draft ?? String(Math.round(value * 100) / 100);
  return (
    <label className="block">
      <span className="block pb-0.5 font-mono text-[9px] text-muted-foreground">
        {label}
        {suffix ? ` (${suffix})` : ""}
      </span>
      <input
        type="number"
        className={fieldClass}
        value={shown}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft !== null) {
            const parsed = Number.parseFloat(draft);
            if (Number.isFinite(parsed)) onCommit(parsed);
          }
          setDraft(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setDraft(null);
            (e.target as HTMLInputElement).blur();
          }
          e.stopPropagation(); // canvas shortcuts must not fire while typing
        }}
      />
    </label>
  );
}

function TextField({
  label,
  value,
  multiline,
  disabled,
  onCommit,
}: {
  label: string;
  value: string;
  multiline?: boolean;
  disabled?: boolean;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const shown = draft ?? value;
  const shared = {
    className: fieldClass,
    value: shown,
    disabled,
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => {
      if (draft !== null) onCommit(draft);
      setDraft(null);
    },
    onKeyDown: (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !multiline) (e.target as HTMLElement).blur();
      if (e.key === "Escape") {
        setDraft(null);
        (e.target as HTMLElement).blur();
      }
      e.stopPropagation();
    },
  };
  return (
    <label className="block">
      <span className="block pb-0.5 font-mono text-[9px] text-muted-foreground">{label}</span>
      {multiline ? <textarea rows={3} {...shared} className={cn(fieldClass, "resize-y")} /> : <input type="text" {...shared} />}
    </label>
  );
}

function SelectField({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block">
      <span className="block pb-0.5 font-mono text-[9px] text-muted-foreground">{label}</span>
      <select className={fieldClass} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function ColorField({
  label,
  value,
  disabled,
  onCommit,
  onClear,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onCommit: (hex: string) => void;
  onClear?: () => void;
}) {
  return (
    <label className="block">
      <span className="block pb-0.5 font-mono text-[9px] text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1.5">
        <input
          type="color"
          value={value ? value.slice(0, 7) : "#000000"}
          disabled={disabled}
          onChange={(e) => onCommit(e.target.value)}
          className="size-7 shrink-0 cursor-pointer rounded-[6px] border border-border/60 bg-transparent p-0.5 disabled:opacity-50"
          aria-label={`${label} colour`}
        />
        <input
          type="text"
          className={fieldClass}
          value={value}
          placeholder="none"
          disabled={disabled}
          onChange={(e) => onCommit(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        {onClear && (
          <button
            type="button"
            disabled={disabled}
            onClick={onClear}
            aria-label={`Remove ${label.toLowerCase()}`}
            className="pressable shrink-0 rounded px-1 font-mono text-[10px] text-muted-foreground hover:text-destructive"
          >
            ×
          </button>
        )}
      </div>
    </label>
  );
}
