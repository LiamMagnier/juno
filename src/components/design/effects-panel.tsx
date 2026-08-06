"use client";

/**
 * Fill, Stroke and Effects — the inspector's direct-manipulation sections.
 *
 * All three are **lists** here because all three are lists in the model, and for
 * a long time none of them were lists in this panel. `fills` and `strokes` have
 * been arrays since the first slice while the inspector offered one paint and
 * one colour, so a document could hold a photo under a tint that nothing in the
 * product could author or reach. Effects were worse than that: three separate
 * fields pretending to be a stack, with a "Liquid glass" button that fired once
 * and scattered five primitives you then had to recognise.
 *
 * Three rules the whole file follows:
 *
 *  - **A list is a list.** Header, a **+**, and one row per entry with its own
 *    swatch or fields, its own opacity, an eye and a remove. Effects also get up
 *    and down, because their order is visible.
 *  - **Every write is one operation over the whole selection.** When layers
 *    disagree the header says "Mixed", the rows read the first layer — exactly as
 *    the scalar fields upstairs already do — and an edit assigns the whole new
 *    list to all of them. The one exception is **+** on the effect stack, which
 *    uses `addEffect` so a mixed selection keeps the stacks it already has.
 *  - **A drag is the primary gesture, and a number is the fallback.** The
 *    gradient axis, the stop positions and the radial centre are all dragged on
 *    a pad, because that is what they are; the numeric fields exist for the
 *    times you know the value you want.
 *
 * The generic field primitives live here rather than in `inspector-panel.tsx`
 * because this module is the leaf of the two — the inspector imports this file,
 * and putting them the other way round would make the pair an import cycle in a
 * bundle that ships inside the Mac app.
 */

import * as React from "react";
import { effectLabel, type DesignOperation, type NodePatch } from "@/lib/design/operations";
import { defaultEffect } from "@/lib/design/schema";
import { hexToRgba, rgbaToCss, rgbaToHex } from "@/lib/design/variables";
import type {
  DesignNode,
  Effect,
  EffectBlendMode,
  EffectType,
  GradientStop,
  Paint,
  Rgba,
  Stroke,
} from "@/lib/design/types";
import { cn } from "@/lib/utils";

type Apply = (operations: DesignOperation[], summary: string) => void;

// ---------------------------------------------------------------------------
// Paint lists (Fill and Stroke)
// ---------------------------------------------------------------------------

const DEFAULT_FILL: Rgba = { r: 0.55, g: 0.6, b: 0.95, a: 1 };
const DEFAULT_STROKE: Rgba = { r: 0.06, g: 0.06, b: 0.08, a: 1 };

/** The stops a solid becomes when it is promoted to a gradient: the colour you
 *  already had, fading to nothing. Anything else would replace the user's
 *  colour with an invention at the moment they asked for a gradient of it. */
function stopsFrom(paint: Paint | undefined): GradientStop[] {
  if (paint && (paint.type === "linear-gradient" || paint.type === "radial-gradient")) return paint.stops;
  const color = paint?.type === "solid" ? paint.color : DEFAULT_FILL;
  return [
    { position: 0, color: { ...color, a: 1 } },
    { position: 1, color: { ...color, a: 0 } },
  ];
}

function solidFrom(paint: Paint | undefined): Rgba {
  if (paint?.type === "solid") return paint.color;
  if (paint && (paint.type === "linear-gradient" || paint.type === "radial-gradient")) return paint.stops[0].color;
  return DEFAULT_FILL;
}

const PAINT_KINDS = [
  { value: "solid", label: "Solid" },
  { value: "linear-gradient", label: "Linear" },
  { value: "radial-gradient", label: "Radial" },
] as const;

function paintKindLabel(paint: Paint): string {
  switch (paint.type) {
    case "solid":
      return rgbaToHex(paint.color);
    case "linear-gradient":
      return "Linear";
    case "radial-gradient":
      return "Radial";
    case "image":
      return "Image";
  }
}

/** The swatch behind a row: a solid chip, a ramp, or a placeholder for an image
 *  paint whose asset this panel has no business resolving. */
function paintPreviewCss(paint: Paint): string {
  switch (paint.type) {
    case "solid":
      return rgbaToCss(paint.color);
    case "linear-gradient":
      return `linear-gradient(to bottom, ${paint.stops
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((s) => `${rgbaToCss(s.color)} ${Math.round(s.position * 100)}%`)
        .join(", ")})`;
    case "radial-gradient":
      return `radial-gradient(circle, ${paint.stops
        .slice()
        .sort((a, b) => a.position - b.position)
        .map((s) => `${rgbaToCss(s.color)} ${Math.round(s.position * 100)}%`)
        .join(", ")})`;
    case "image":
      return "repeating-conic-gradient(hsl(var(--border)) 0% 25%, transparent 0% 50%)";
  }
}

/**
 * Fill as a **list**, which is what it always was in the model and never was in
 * this panel.
 *
 * `fills` has been `Paint[]` since the first slice, and the inspector offered a
 * segmented None/Solid/Linear/Radial picker over `fills[0]` — so a document could
 * hold three stacked fills, the renderer would draw the first, and there was no
 * gesture anywhere in the product that could reach the other two or make a
 * fourth. A layer with a photo under a tint is two fills; the picker made it
 * unsayable. Now every fill is a row with its own swatch, opacity, eye and
 * remove, a **+** adds one, and the type picker and gradient editors live inside
 * the row they belong to.
 *
 * Every write is one `updateNode` per editable layer carrying the whole new list,
 * for the reason in the module note: a list edit assembled per layer from that
 * layer's own list is how "set the fill colour" used to carry the first layer's
 * gradient onto the rest.
 */
export function FillControl({
  nodes,
  editable,
  onApply,
  readOnly,
}: {
  nodes: DesignNode[];
  editable: DesignNode[];
  onApply: Apply;
  readOnly?: boolean;
}) {
  return (
    <PaintListSection
      title="Fill"
      nodes={nodes}
      editable={editable}
      onApply={onApply}
      readOnly={readOnly}
      read={(node) => node.fills}
      write={(paints) => ({ fills: paints })}
      addLabel="Add fill"
      newPaint={(existing) => ({ type: "solid", color: existing.length > 0 ? { ...DEFAULT_FILL, a: 1 } : DEFAULT_FILL })}
    />
  );
}

/**
 * Stroke as a list, on the same terms.
 *
 * A stroke is a paint plus a weight and an alignment, so the row carries those
 * two extra fields and everything else — the swatch, the opacity, the eye, the
 * remove, the gradient editor — is the identical machinery the fills use. The
 * model has been `Stroke[]` all along; the inspector offered exactly one colour
 * and one weight.
 */
export function StrokeControl({
  nodes,
  editable,
  onApply,
  readOnly,
}: {
  nodes: DesignNode[];
  editable: DesignNode[];
  onApply: Apply;
  readOnly?: boolean;
}) {
  return (
    <PaintListSection
      title="Stroke"
      nodes={nodes}
      editable={editable}
      onApply={onApply}
      readOnly={readOnly}
      read={(node) => node.strokes.map((stroke) => stroke.paint)}
      write={(paints, node) => ({
        strokes: paints.map((paint, index) => ({
          paint,
          weight: node.strokes[index]?.weight ?? 1,
          align: node.strokes[index]?.align ?? "center",
          ...(node.strokes[index]?.dash ? { dash: node.strokes[index].dash } : {}),
        })),
      })}
      addLabel="Add stroke"
      newPaint={() => ({ type: "solid", color: DEFAULT_STROKE })}
      extra={(index, node, patchAll) => (
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField
            label="Weight"
            value={node.strokes[index]?.weight ?? 1}
            min={0}
            disabled={readOnly}
            onCommit={(v) =>
              patchAll(
                (target) => ({
                  strokes: target.strokes.map((stroke, i) => (i === index ? { ...stroke, weight: Math.max(0, v) } : stroke)),
                }),
                "Set stroke weight"
              )
            }
          />
          <SelectField
            label="Align"
            value={node.strokes[index]?.align ?? "center"}
            options={[
              { value: "inside", label: "Inside" },
              { value: "center", label: "Centre" },
              { value: "outside", label: "Outside" },
            ]}
            disabled={readOnly}
            onChange={(value) =>
              patchAll(
                (target) => ({
                  strokes: target.strokes.map((stroke, i) =>
                    i === index ? { ...stroke, align: value as Stroke["align"] } : stroke
                  ),
                }),
                "Set stroke alignment"
              )
            }
          />
        </div>
      )}
    />
  );
}

/** The shared body of Fill and Stroke: a list of paints with per-row opacity,
 *  visibility and removal, and the gradient editors folded into the row. */
function PaintListSection({
  title,
  nodes,
  editable,
  onApply,
  readOnly,
  read,
  write,
  addLabel,
  newPaint,
  extra,
}: {
  title: string;
  nodes: DesignNode[];
  editable: DesignNode[];
  onApply: Apply;
  readOnly?: boolean;
  read: (node: DesignNode) => Paint[];
  write: (paints: Paint[], node: DesignNode) => NodePatch;
  addLabel: string;
  newPaint: (existing: Paint[]) => Paint;
  extra?: (index: number, node: DesignNode, patchAll: PatchAll) => React.ReactNode;
}) {
  const first = nodes[0];
  const paints = read(first);
  const mixed = nodes.some((node) => JSON.stringify(read(node)) !== JSON.stringify(paints));
  const [expanded, setExpanded] = React.useState<number | null>(null);

  const patchAll: PatchAll = (build, summary) =>
    onApply(
      editable.map((node) => ({ op: "updateNode" as const, nodeId: node.id, patch: build(node) })),
      summary
    );

  const setPaints = (next: Paint[], summary: string) => patchAll((node) => write(next, node), summary);
  const setPaint = (index: number, paint: Paint, summary: string) =>
    setPaints(paints.map((p, i) => (i === index ? paint : p)), summary);

  return (
    <Section
      title={title}
      action={
        <div className="flex items-center gap-1.5">
          {mixed && <MixedBadge />}
          <IconButton
            label={addLabel}
            disabled={readOnly || editable.length === 0 || paints.length >= 32}
            onClick={() => {
              setPaints([...paints, newPaint(paints)], addLabel);
              setExpanded(paints.length);
            }}
          >
            +
          </IconButton>
        </div>
      }
    >
      {paints.length === 0 && <EmptyRow>None</EmptyRow>}
      {paints.map((paint, index) => {
        const hidden = paint.visible === false;
        const gradient = paint.type === "linear-gradient" || paint.type === "radial-gradient" ? paint : null;
        return (
          <div key={index} className={cn("space-y-1.5 rounded-[10px] border border-border/60 p-1.5", hidden && "opacity-50")}>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                aria-label={`${title} ${index + 1} — edit`}
                aria-expanded={expanded === index}
                disabled={readOnly}
                onClick={() => setExpanded(expanded === index ? null : index)}
                className="pressable size-6 shrink-0 rounded-[6px] border border-border/60"
                style={{ background: paintPreviewCss(paint) }}
              />
              {paint.type === "solid" ? (
                <input
                  type="text"
                  aria-label={`${title} ${index + 1} colour`}
                  className={cn(fieldClass, "min-w-0 flex-1")}
                  value={rgbaToHex(paint.color).slice(0, 7)}
                  disabled={readOnly}
                  onChange={(event) => {
                    const color = hexToRgba(event.target.value);
                    if (color) setPaint(index, { ...paint, color: { ...color, a: paint.color.a } }, `Set ${title.toLowerCase()} colour`);
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                />
              ) : (
                <span className="min-w-0 flex-1 truncate px-2 text-xs text-muted-foreground">{paintKindLabel(paint)}</span>
              )}
              <input
                type="number"
                aria-label={`${title} ${index + 1} opacity`}
                className={cn(fieldClass, "w-14 shrink-0")}
                value={Math.round((paint.opacity ?? 1) * 100)}
                min={0}
                max={100}
                disabled={readOnly}
                onChange={(event) => {
                  const parsed = Number.parseFloat(event.target.value);
                  if (Number.isFinite(parsed)) {
                    setPaint(index, { ...paint, opacity: Math.max(0, Math.min(1, parsed / 100)) }, `Set ${title.toLowerCase()} opacity`);
                  }
                }}
                onKeyDown={(event) => event.stopPropagation()}
              />
              <IconButton
                label={hidden ? `Show ${title.toLowerCase()} ${index + 1}` : `Hide ${title.toLowerCase()} ${index + 1}`}
                disabled={readOnly}
                onClick={() => setPaint(index, { ...paint, visible: hidden }, hidden ? `Show ${title.toLowerCase()}` : `Hide ${title.toLowerCase()}`)}
              >
                {hidden ? "○" : "●"}
              </IconButton>
              <IconButton
                label={`Remove ${title.toLowerCase()} ${index + 1}`}
                disabled={readOnly}
                destructive
                onClick={() => {
                  setPaints(paints.filter((_, i) => i !== index), `Remove ${title.toLowerCase()}`);
                  setExpanded(null);
                }}
              >
                −
              </IconButton>
            </div>

            {extra?.(index, first, patchAll)}

            {expanded === index && (
              <PaintEditor
                paint={paint}
                // Stop editing needs one list to edit. Across a mixed selection
                // there is no such list, so the ramp is shown and the stops are
                // not — the alternative is a stop editor that silently rewrites
                // four layers from a fifth one's ramp.
                singleLayer={nodes.length === 1}
                disabled={readOnly}
                onChange={(next, summary) => setPaint(index, next, summary)}
              />
            )}
            {expanded === index && gradient === null && paint.type === "image" && (
              <p className="text-[10px] leading-snug text-muted-foreground">
                An image fill is placed from the canvas; its asset is not editable here.
              </p>
            )}
          </div>
        );
      })}
    </Section>
  );
}

type PatchAll = (build: (node: DesignNode) => NodePatch, summary: string) => void;

/** The type picker and, for a gradient, its ramp and geometry — the detail of
 *  one row, shown under the row it belongs to. */
function PaintEditor({
  paint,
  singleLayer,
  disabled,
  onChange,
}: {
  paint: Paint;
  singleLayer: boolean;
  disabled?: boolean;
  onChange: (paint: Paint, summary: string) => void;
}) {
  const [selectedStop, setSelectedStop] = React.useState(0);
  const gradient = paint.type === "linear-gradient" || paint.type === "radial-gradient" ? paint : null;

  const changeKind = (next: string) => {
    if (next === paint.type) return;
    const opacity = paint.opacity;
    const visible = paint.visible;
    const carried = { ...(opacity === undefined ? {} : { opacity }), ...(visible === undefined ? {} : { visible }) };
    if (next === "solid") return onChange({ type: "solid", color: solidFrom(paint), ...carried }, "Set fill type");
    const stops = stopsFrom(paint);
    if (next === "linear-gradient") {
      return onChange({ type: "linear-gradient", stops, from: { x: 0, y: 0 }, to: { x: 0, y: 1 }, ...carried }, "Set gradient fill");
    }
    return onChange({ type: "radial-gradient", stops, center: { x: 0.5, y: 0.5 }, radius: 0.5, ...carried }, "Set gradient fill");
  };

  const commitStops = (stops: GradientStop[], summary: string) => {
    if (!gradient) return;
    onChange({ ...gradient, stops: [...stops].sort((a, b) => a.position - b.position) }, summary);
  };

  return (
    <div className="space-y-1.5 border-t border-border/40 pt-1.5">
      {paint.type !== "image" && (
        <Segmented value={paint.type} options={PAINT_KINDS} disabled={disabled} onChange={changeKind} label="Paint type" />
      )}

      {paint.type === "solid" && (
        <ColorField
          label="Colour"
          value={rgbaToHex(paint.color)}
          disabled={disabled}
          onCommit={(hex) => {
            const color = hexToRgba(hex);
            if (color) onChange({ ...paint, color }, "Set fill colour");
          }}
        />
      )}

      {gradient && (
        <>
          <GradientRail
            stops={gradient.stops}
            selected={selectedStop}
            disabled={disabled || !singleLayer}
            onSelect={setSelectedStop}
            onMove={(index, position) => {
              commitStops(gradient.stops.map((s, i) => (i === index ? { ...s, position } : s)), "Move gradient stop");
            }}
          />
          {singleLayer && (
            <StopEditor
              stops={gradient.stops}
              selected={Math.min(selectedStop, gradient.stops.length - 1)}
              disabled={disabled}
              onSelect={setSelectedStop}
              onChange={commitStops}
            />
          )}
          {gradient.type === "linear-gradient" ? (
            <AxisPad
              from={gradient.from}
              to={gradient.to}
              disabled={disabled}
              onChange={(from, to) => onChange({ ...gradient, from, to }, "Set gradient direction")}
            />
          ) : (
            <RadialPad
              center={gradient.center}
              radius={gradient.radius}
              disabled={disabled}
              onChange={(center, radius) => onChange({ ...gradient, center, radius }, "Set gradient shape")}
            />
          )}
        </>
      )}
    </div>
  );
}

/**
 * The stop rail: the ramp with a draggable handle per stop.
 *
 * Dragging a handle is the whole point — a gradient is a thing you feel out,
 * not a list of percentages you type — so the numeric position field below is
 * the fallback rather than the interface.
 */
function GradientRail({
  stops,
  selected,
  disabled,
  onSelect,
  onMove,
}: {
  stops: GradientStop[];
  selected: number;
  disabled?: boolean;
  onSelect: (index: number) => void;
  onMove: (index: number, position: number) => void;
}) {
  const railRef = React.useRef<HTMLDivElement>(null);
  const ramp = stops
    .slice()
    .sort((a, b) => a.position - b.position)
    .map((s) => `${rgbaToCss(s.color)} ${Math.round(s.position * 100)}%`)
    .join(", ");

  const positionFrom = (clientX: number) => {
    const rail = railRef.current;
    if (!rail) return 0;
    const rect = rail.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
  };

  return (
    <div className="space-y-1">
      <div
        ref={railRef}
        className="relative h-6 rounded-[6px] border border-border/60"
        style={{
          // The chequerboard is what makes a fade to transparent legible; it is
          // drawn from the border token rather than a literal grey.
          backgroundImage: `linear-gradient(to right, ${ramp}), repeating-conic-gradient(hsl(var(--border)) 0% 25%, transparent 0% 50%)`,
          backgroundSize: "auto, 10px 10px",
        }}
      />
      <div className="relative h-4">
        {stops.map((stop, index) => (
          <button
            key={index}
            type="button"
            disabled={disabled}
            aria-label={`Gradient stop ${index + 1}`}
            onPointerDown={(event) => {
              onSelect(index);
              if (disabled) return;
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              if (disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
              onMove(index, positionFrom(event.clientX));
            }}
            onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
            className={cn(
              "pressable absolute top-0 size-3.5 -translate-x-1/2 cursor-ew-resize rounded-full border-2 shadow-soft transition-colors",
              index === selected ? "border-primary" : "border-border"
            )}
            style={{ left: `${stop.position * 100}%`, background: rgbaToCss(stop.color) }}
          />
        ))}
      </div>
    </div>
  );
}

function StopEditor({
  stops,
  selected,
  disabled,
  onSelect,
  onChange,
}: {
  stops: GradientStop[];
  selected: number;
  disabled?: boolean;
  onSelect: (index: number) => void;
  onChange: (stops: GradientStop[], summary: string) => void;
}) {
  const stop = stops[selected];
  if (!stop) return null;

  /** New stops land in the widest gap, which is where a person reaching for
   *  "add a stop" is almost always pointing. */
  const addStop = () => {
    const sorted = [...stops].sort((a, b) => a.position - b.position);
    let gap = 0;
    let at = 0.5;
    for (let i = 0; i < sorted.length - 1; i++) {
      const width = sorted[i + 1].position - sorted[i].position;
      if (width > gap) {
        gap = width;
        at = sorted[i].position + width / 2;
      }
    }
    // The new stop takes the colour of the one it sits after, so adding a stop
    // changes the ramp's shape and not its colours.
    let before = sorted[0];
    for (const candidate of sorted) if (candidate.position <= at) before = candidate;
    onChange([...stops, { position: at, color: { ...before.color } }], "Add gradient stop");
    onSelect(stops.length);
  };

  return (
    <div className="space-y-1.5">
      <div className="grid grid-cols-[1fr_auto] gap-1.5">
        <ColorField
          label={`Stop ${selected + 1}`}
          value={rgbaToHex(stop.color)}
          disabled={disabled}
          onCommit={(hex) => {
            const color = hexToRgba(hex);
            if (color) onChange(stops.map((s, i) => (i === selected ? { ...s, color } : s)), "Set gradient stop colour");
          }}
        />
        <NumberField
          label="Pos"
          suffix="%"
          value={Math.round(stop.position * 100)}
          min={0}
          max={100}
          disabled={disabled}
          onCommit={(v) =>
            onChange(
              stops.map((s, i) => (i === selected ? { ...s, position: Math.max(0, Math.min(1, v / 100)) } : s)),
              "Move gradient stop"
            )
          }
        />
      </div>
      <div className="flex gap-1.5">
        <MiniButton disabled={disabled} onClick={addStop}>
          Add stop
        </MiniButton>
        <MiniButton
          // Two stops is the schema's minimum and the concept's: one stop is a
          // solid colour, and the type picker is how you say that.
          disabled={disabled || stops.length <= 2}
          onClick={() => {
            onChange(stops.filter((_, i) => i !== selected), "Remove gradient stop");
            onSelect(Math.max(0, selected - 1));
          }}
        >
          Remove stop
        </MiniButton>
      </div>
    </div>
  );
}

/** A unit-square pad: drag either end of the gradient axis. */
function AxisPad({
  from,
  to,
  disabled,
  onChange,
}: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  disabled?: boolean;
  onChange: (from: { x: number; y: number }, to: { x: number; y: number }) => void;
}) {
  const { padRef, pointFrom } = usePad();
  const drag = (which: "from" | "to") => ({
    onPointerDown: (event: React.PointerEvent) => {
      if (disabled) return;
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    onPointerMove: (event: React.PointerEvent) => {
      if (disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      const point = pointFrom(event.clientX, event.clientY);
      onChange(which === "from" ? point : from, which === "to" ? point : to);
    },
    onPointerUp: (event: React.PointerEvent) => event.currentTarget.releasePointerCapture(event.pointerId),
  });

  return (
    <label className="block">
      <span className="block pb-0.5 font-mono text-[9px] text-muted-foreground">Direction</span>
      <div ref={padRef} className="relative h-24 w-full rounded-[8px] border border-border/60 bg-muted/40">
        <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 1 1" preserveAspectRatio="none">
          <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="hsl(var(--primary))" strokeWidth="0.012" vectorEffect="non-scaling-stroke" />
        </svg>
        <PadHandle x={from.x} y={from.y} label="Gradient start" disabled={disabled} {...drag("from")} />
        <PadHandle x={to.x} y={to.y} label="Gradient end" disabled={disabled} filled {...drag("to")} />
      </div>
    </label>
  );
}

/** The radial equivalent: drag the centre, drag the rim to set the radius. */
function RadialPad({
  center,
  radius,
  disabled,
  onChange,
}: {
  center: { x: number; y: number };
  radius: number;
  disabled?: boolean;
  onChange: (center: { x: number; y: number }, radius: number) => void;
}) {
  const { padRef, pointFrom } = usePad();

  return (
    <label className="block">
      <span className="block pb-0.5 font-mono text-[9px] text-muted-foreground">Centre &amp; radius</span>
      <div ref={padRef} className="relative h-24 w-full rounded-[8px] border border-border/60 bg-muted/40">
        <svg className="pointer-events-none absolute inset-0 size-full" viewBox="0 0 1 1" preserveAspectRatio="none">
          <circle cx={center.x} cy={center.y} r={radius} fill="none" stroke="hsl(var(--primary))" strokeWidth="0.012" vectorEffect="non-scaling-stroke" />
        </svg>
        <PadHandle
          x={center.x}
          y={center.y}
          label="Gradient centre"
          disabled={disabled}
          filled
          onPointerDown={(event) => !disabled && event.currentTarget.setPointerCapture(event.pointerId)}
          onPointerMove={(event) => {
            if (disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
            onChange(pointFrom(event.clientX, event.clientY), radius);
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        />
        <PadHandle
          x={center.x + radius}
          y={center.y}
          label="Gradient radius"
          disabled={disabled}
          onPointerDown={(event) => !disabled && event.currentTarget.setPointerCapture(event.pointerId)}
          onPointerMove={(event) => {
            if (disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
            const point = pointFrom(event.clientX, event.clientY);
            onChange(center, Math.max(0.02, Math.hypot(point.x - center.x, point.y - center.y)));
          }}
          onPointerUp={(event) => event.currentTarget.releasePointerCapture(event.pointerId)}
        />
      </div>
    </label>
  );
}

function usePad() {
  const padRef = React.useRef<HTMLDivElement>(null);
  const pointFrom = React.useCallback((clientX: number, clientY: number) => {
    const pad = padRef.current;
    if (!pad) return { x: 0, y: 0 };
    const rect = pad.getBoundingClientRect();
    return {
      x: Math.round(Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width))) * 1000) / 1000,
      y: Math.round(Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height))) * 1000) / 1000,
    };
  }, []);
  return { padRef, pointFrom };
}

function PadHandle({
  x,
  y,
  label,
  filled,
  disabled,
  ...handlers
}: {
  x: number;
  y: number;
  label: string;
  filled?: boolean;
  disabled?: boolean;
} & React.ComponentPropsWithoutRef<"button">) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      className={cn(
        "pressable absolute size-3.5 -translate-x-1/2 -translate-y-1/2 cursor-grab touch-none rounded-full border-2 border-primary shadow-soft active:cursor-grabbing",
        filled ? "bg-primary" : "bg-background"
      )}
      style={{ left: `${x * 100}%`, top: `${y * 100}%` }}
      {...handlers}
    />
  );
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

/**
 * The **+** menu, and what is deliberately not in it.
 *
 * These are Figma's items, in Figma's order, minus one. *Shader (Beta)* is
 * absent because a shader is a program: a document that holds one can only be
 * drawn by something that runs it, and this renderer feeds eight exporters that
 * cannot. The rule the whole design surface rests on is that nothing is
 * authorable here unless SVG, PNG, PDF, HTML, React and SwiftUI can each either
 * honour it or say exactly which part of it they dropped — and "we ran your
 * fragment shader" is not something a PDF can say.
 */
const EFFECT_MENU: { type: EffectType; label: string; hint: string }[] = [
  { type: "inner-shadow", label: "Inner shadow", hint: "Shadow cast inside the layer's own silhouette." },
  { type: "drop-shadow", label: "Drop shadow", hint: "Shadow cast behind the layer." },
  { type: "layer-blur", label: "Layer blur", hint: "Blurs this layer." },
  { type: "background-blur", label: "Background blur", hint: "Blurs what is behind this layer." },
  { type: "noise", label: "Noise", hint: "Film grain over the layer." },
  { type: "texture", label: "Texture", hint: "The same grain, lit as a relief." },
  { type: "glass", label: "Glass", hint: "Backdrop blur, a refracting rim, a tint and a light." },
];

/**
 * The effect stack.
 *
 * What this replaces: a fixed shadow list, a single None/Layer/Background blur
 * choice, one optional grain, and a **Liquid glass** button that fired once and
 * expanded into five unrelated primitives. That last one was the tell — there
 * was no such thing as *a* glass effect to hide, retune or delete, only a
 * scattering of parts you had to recognise as having once been glass.
 *
 * Now there is one list. Every entry is added from the **+** menu, and every
 * entry has the same four controls in the same place — eye, up, down, remove —
 * because in a stack those are properties of *being an entry*, not of being a
 * shadow. Ordering is real: the list is applied bottom-up and moving a row
 * changes what the layer looks like.
 */
export function EffectsSection({
  nodes,
  editable,
  onApply,
  readOnly,
}: {
  nodes: DesignNode[];
  editable: DesignNode[];
  onApply: Apply;
  readOnly?: boolean;
}) {
  const first = nodes[0];
  const effects = first.effects;
  const mixed = nodes.some((node) => JSON.stringify(node.effects) !== JSON.stringify(effects));
  const ids = editable.map((node) => node.id);

  const setEffects = (next: Effect[], summary: string) => {
    if (ids.length === 0) return;
    onApply([{ op: "setEffects", nodeIds: ids, effects: next }], summary);
  };

  const patchEffect = (index: number, effect: Effect, summary: string) =>
    setEffects(effects.map((e, i) => (i === index ? effect : e)), summary);

  /** Adding uses `addEffect`, not an assignment: across a mixed selection the
   *  other layers keep the stacks they already have, which is the whole reason
   *  that operation exists. */
  const addEffect = (type: EffectType) => {
    if (ids.length === 0) return;
    onApply([{ op: "addEffect", nodeIds: ids, effect: defaultEffect(type) }], `Add ${effectLabel(type)}`);
  };

  const move = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= effects.length) return;
    const next = [...effects];
    const [moved] = next.splice(index, 1);
    next.splice(to, 0, moved);
    setEffects(next, "Reorder effects");
  };

  const hasBackdrop = effects.some((effect) => effect.type === "background-blur" || effect.type === "glass");

  return (
    <Section
      title="Effects"
      action={
        <div className="flex items-center gap-1.5">
          {mixed && <MixedBadge />}
          <AddEffectMenu disabled={readOnly || ids.length === 0 || effects.length >= 64} onAdd={addEffect} />
        </div>
      }
    >
      {effects.length === 0 && <EmptyRow>None</EmptyRow>}
      {effects.map((effect, index) => (
        <EffectRow
          key={index}
          effect={effect}
          index={index}
          count={effects.length}
          disabled={readOnly}
          onChange={(next, summary) => patchEffect(index, next, summary)}
          onRemove={() => setEffects(effects.filter((_, i) => i !== index), `Remove ${effectLabel(effect.type)}`)}
          onMove={(delta) => move(index, delta)}
        />
      ))}
      {hasBackdrop && (
        <p className="text-[10px] leading-snug text-muted-foreground">
          A backdrop effect samples what is behind this layer, so it is drawn beneath it wherever it sits in the list. Give the
          layer a low-alpha fill, or none, so there is something to see through.
        </p>
      )}
    </Section>
  );
}

/** The **+** and its menu. A listbox rather than a `<select>` because each item
 *  carries a one-line explanation of what it does, and an option element cannot
 *  hold one. */
function AddEffectMenu({ disabled, onAdd }: { disabled?: boolean; onAdd: (type: EffectType) => void }) {
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  return (
    <div
      ref={containerRef}
      className="relative"
      onBlur={(event) => {
        // Closes when focus leaves the menu entirely, not when it moves between
        // the button and the items — `relatedTarget` is what tells them apart.
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
        event.stopPropagation();
      }}
    >
      <IconButton label="Add effect" disabled={disabled} onClick={() => setOpen((value) => !value)}>
        +
      </IconButton>
      {open && (
        <div
          role="menu"
          aria-label="Add effect"
          className="absolute right-0 top-full z-30 mt-1 w-56 space-y-0.5 rounded-[10px] border border-border/60 bg-popover p-1 shadow-soft"
        >
          {EFFECT_MENU.map((item) => (
            <button
              key={item.type}
              type="button"
              role="menuitem"
              onClick={() => {
                onAdd(item.type);
                setOpen(false);
              }}
              className="pressable block w-full rounded-[6px] px-2 py-1 text-left transition-colors hover:bg-accent"
            >
              <span className="block text-xs text-foreground">{item.label}</span>
              <span className="block text-[10px] leading-snug text-muted-foreground">{item.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EffectRow({
  effect,
  index,
  count,
  disabled,
  onChange,
  onRemove,
  onMove,
}: {
  effect: Effect;
  index: number;
  count: number;
  disabled?: boolean;
  onChange: (effect: Effect, summary: string) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const hidden = effect.visible === false;
  const label = effectLabel(effect.type);
  const title = label.charAt(0).toUpperCase() + label.slice(1);

  return (
    <div className={cn("space-y-1.5 rounded-[10px] border border-border/60 p-2", hidden && "opacity-50")}>
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-muted-foreground">{title}</span>
        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            label={hidden ? `Show ${label}` : `Hide ${label}`}
            disabled={disabled}
            onClick={() => onChange({ ...effect, visible: hidden }, hidden ? `Show ${label}` : `Hide ${label}`)}
          >
            {hidden ? "○" : "●"}
          </IconButton>
          <IconButton label={`Move ${label} down the stack`} disabled={disabled || index === 0} onClick={() => onMove(-1)}>
            ↑
          </IconButton>
          <IconButton label={`Move ${label} up the stack`} disabled={disabled || index === count - 1} onClick={() => onMove(1)}>
            ↓
          </IconButton>
          <IconButton label={`Remove ${label}`} disabled={disabled} destructive onClick={onRemove}>
            −
          </IconButton>
        </div>
      </div>
      <EffectFields effect={effect} disabled={disabled} onChange={onChange} />
    </div>
  );
}

/** One row's controls. A `switch` over the tag rather than a table of field
 *  descriptors: the variants genuinely do not share a shape, and a descriptor
 *  table would have to invent one and then work around it for glass. */
function EffectFields({
  effect,
  disabled,
  onChange,
}: {
  effect: Effect;
  disabled?: boolean;
  onChange: (effect: Effect, summary: string) => void;
}) {
  switch (effect.type) {
    case "drop-shadow":
    case "inner-shadow":
      return (
        <>
          <ColorField
            label="Colour"
            value={rgbaToHex(effect.color)}
            disabled={disabled}
            onCommit={(hex) => {
              const color = hexToRgba(hex);
              if (color) onChange({ ...effect, color }, "Set shadow colour");
            }}
          />
          <div className="grid grid-cols-4 gap-1.5">
            <NumberField label="X" value={effect.offsetX} disabled={disabled} onCommit={(v) => onChange({ ...effect, offsetX: v }, "Set shadow offset")} />
            <NumberField label="Y" value={effect.offsetY} disabled={disabled} onCommit={(v) => onChange({ ...effect, offsetY: v }, "Set shadow offset")} />
            <NumberField
              label="Blur"
              value={effect.blur}
              min={0}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, blur: Math.max(0, v) }, "Set shadow blur")}
            />
            <NumberField label="Spread" value={effect.spread} disabled={disabled} onCommit={(v) => onChange({ ...effect, spread: v }, "Set shadow spread")} />
          </div>
        </>
      );

    case "layer-blur":
    case "background-blur":
      return (
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField
            label="Radius"
            value={effect.radius}
            min={0}
            disabled={disabled}
            onCommit={(v) => onChange({ ...effect, radius: Math.max(0, v) }, "Set blur radius")}
          />
          <NumberField
            label="Saturation"
            suffix="%"
            value={Math.round((effect.saturation ?? 1) * 100)}
            min={0}
            max={1000}
            step={10}
            disabled={disabled}
            onCommit={(v) => onChange({ ...effect, saturation: Math.max(0, Math.min(10, v / 100)) }, "Set blur saturation")}
          />
        </div>
      );

    case "noise":
      return (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            <NumberField
              label="Amount"
              suffix="%"
              value={Math.round(effect.opacity * 100)}
              min={0}
              max={100}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, opacity: clampUnit(v / 100) }, "Set grain amount")}
            />
            <NumberField
              label="Density"
              value={effect.density}
              min={0.001}
              max={4}
              step={0.05}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, density: Math.max(0.001, Math.min(4, v)) }, "Set grain density")}
            />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <BlendField value={effect.blend} disabled={disabled} onChange={(blend) => onChange({ ...effect, blend }, "Set grain blend")} />
            <NumberField
              label="Seed"
              value={effect.seed}
              min={0}
              max={65535}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, seed: clampSeed(v) }, "Set grain seed")}
            />
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={effect.monochrome}
              disabled={disabled}
              onChange={(event) => onChange({ ...effect, monochrome: event.target.checked }, "Set grain colour")}
            />
            Monochrome
          </label>
        </>
      );

    case "texture":
      return (
        <>
          <div className="grid grid-cols-3 gap-1.5">
            <NumberField
              label="Scale"
              value={effect.scale}
              min={0.001}
              max={4}
              step={0.05}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, scale: Math.max(0.001, Math.min(4, v)) }, "Set texture scale")}
            />
            <NumberField
              label="Depth"
              value={effect.depth}
              min={0}
              max={200}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, depth: Math.max(0, Math.min(200, v)) }, "Set texture depth")}
            />
            <NumberField
              label="Rough"
              value={effect.roughness}
              min={1}
              max={4}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, roughness: Math.max(1, Math.min(4, Math.round(v))) }, "Set texture roughness")}
            />
          </div>
          <ColorField
            label="Light"
            value={rgbaToHex(effect.color)}
            disabled={disabled}
            onCommit={(hex) => {
              const color = hexToRgba(hex);
              if (color) onChange({ ...effect, color }, "Set texture colour");
            }}
          />
          <div className="grid grid-cols-3 gap-1.5">
            <NumberField
              label="Amount"
              suffix="%"
              value={Math.round(effect.opacity * 100)}
              min={0}
              max={100}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, opacity: clampUnit(v / 100) }, "Set texture amount")}
            />
            <BlendField value={effect.blend} disabled={disabled} onChange={(blend) => onChange({ ...effect, blend }, "Set texture blend")} />
            <NumberField
              label="Seed"
              value={effect.seed}
              min={0}
              max={65535}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, seed: clampSeed(v) }, "Set texture seed")}
            />
          </div>
        </>
      );

    case "glass":
      return (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            <NumberField
              label="Blur"
              value={effect.blur}
              min={0}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, blur: Math.max(0, v) }, "Set glass blur")}
            />
            <NumberField
              label="Saturation"
              suffix="%"
              value={Math.round(effect.saturation * 100)}
              min={0}
              max={1000}
              step={10}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, saturation: Math.max(0, Math.min(10, v / 100)) }, "Set glass saturation")}
            />
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <NumberField
              label="Refraction"
              suffix="%"
              value={Math.round(effect.refraction * 100)}
              min={0}
              max={100}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, refraction: clampUnit(v / 100) }, "Set glass refraction")}
            />
            <NumberField
              label="Depth"
              value={effect.depth}
              min={0}
              max={1000}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, depth: Math.max(0, Math.min(1000, v)) }, "Set glass depth")}
            />
          </div>
          <ColorField
            label="Tint"
            value={rgbaToHex(effect.tint)}
            disabled={disabled}
            onCommit={(hex) => {
              const tint = hexToRgba(hex);
              if (tint) onChange({ ...effect, tint }, "Set glass tint");
            }}
          />
          <div className="grid grid-cols-3 gap-1.5">
            <NumberField
              label="Tint"
              suffix="%"
              value={Math.round(effect.tintOpacity * 100)}
              min={0}
              max={100}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, tintOpacity: clampUnit(v / 100) }, "Set glass tint opacity")}
            />
            <NumberField
              label="Light"
              suffix="%"
              value={Math.round(effect.lightIntensity * 100)}
              min={0}
              max={100}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, lightIntensity: clampUnit(v / 100) }, "Set glass light")}
            />
            <NumberField
              label="Angle"
              suffix="°"
              value={effect.lightAngle}
              min={-360}
              max={360}
              step={15}
              disabled={disabled}
              onCommit={(v) => onChange({ ...effect, lightAngle: Math.max(-360, Math.min(360, v)) }, "Set glass light angle")}
            />
          </div>
        </>
      );
  }
}

function BlendField({
  value,
  disabled,
  onChange,
}: {
  value: EffectBlendMode;
  disabled?: boolean;
  onChange: (blend: EffectBlendMode) => void;
}) {
  return (
    <SelectField
      label="Blend"
      value={value}
      options={[
        { value: "overlay", label: "Overlay" },
        { value: "soft-light", label: "Soft light" },
        { value: "multiply", label: "Multiply" },
        { value: "screen", label: "Screen" },
        { value: "normal", label: "Normal" },
      ]}
      disabled={disabled}
      onChange={(next) => onChange(next as EffectBlendMode)}
    />
  );
}

const clampUnit = (value: number) => Math.max(0, Math.min(1, value));
const clampSeed = (value: number) => Math.max(0, Math.min(65_535, Math.round(value)));

/** What a list section shows when it is empty. Not nothing: an empty section
 *  with no row at all reads as a section that failed to load. */
function EmptyRow({ children }: { children: React.ReactNode }) {
  return <p className="rounded-[8px] border border-dashed border-border/60 px-2 py-1 text-[11px] text-muted-foreground">{children}</p>;
}

// ---------------------------------------------------------------------------
// Shared field primitives (see the module note on why they live here)
// ---------------------------------------------------------------------------

export function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate font-mono text-[10px] text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

export const fieldClass =
  "w-full rounded-[8px] border border-border/60 bg-background px-2 py-1 text-xs tabular-nums outline-none transition-colors focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-primary/20 disabled:opacity-50 coarse:min-h-9";

/** "Mixed" as a badge rather than a value, because the section below it shows
 *  the first layer's state and a badge is the only honest way to say so. */
function MixedBadge() {
  return <span className="shrink-0 rounded-[4px] bg-muted px-1 font-mono text-[9px] text-muted-foreground">Mixed</span>;
}

function MiniButton({ children, disabled, onClick }: { children: React.ReactNode; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="pressable flex-1 rounded-[8px] border border-border/60 px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 coarse:min-h-9"
    >
      {children}
    </button>
  );
}

function IconButton({
  children,
  label,
  disabled,
  destructive,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "pressable rounded-[6px] px-1 font-mono text-[11px] text-muted-foreground transition-colors disabled:opacity-30 coarse:min-h-8 coarse:min-w-8",
        destructive ? "hover:text-destructive" : "hover:text-foreground"
      )}
    >
      {children}
    </button>
  );
}

function Segmented({
  value,
  options,
  label,
  disabled,
  onChange,
}: {
  value: string;
  options: readonly { value: string; label: string }[];
  label: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div role="group" aria-label={label} className="flex gap-0.5 rounded-[8px] border border-border/60 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "pressable flex-1 rounded-[6px] px-1 py-1 text-[11px] transition-colors disabled:opacity-50 coarse:min-h-8",
            value === option.value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function NumberField({
  label,
  value,
  mixed,
  min,
  max,
  step = 1,
  suffix,
  disabled,
  onCommit,
}: {
  label: string;
  value: number;
  /** The selected layers disagree: show nothing rather than the first one's. */
  mixed?: boolean;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  // Uncontrolled while focused so typing "12" does not fight a re-render at "1".
  const [draft, setDraft] = React.useState<string | null>(null);
  const shown = draft ?? (mixed ? "" : String(Math.round(value * 100) / 100));
  return (
    <label className="block">
      <span className="block truncate pb-0.5 font-mono text-[9px] text-muted-foreground">
        {label}
        {suffix ? ` (${suffix})` : ""}
      </span>
      <input
        type="number"
        className={fieldClass}
        value={shown}
        placeholder={mixed ? "Mixed" : undefined}
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

export function TextField({
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

/** Sentinel for the "Mixed" row. Not the empty string: some of these selects
 *  use "" for a real choice ("None"). */
const MIXED_OPTION = " mixed";

export function SelectField({
  label,
  value,
  mixed,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  mixed?: boolean;
  options: { value: string; label: string }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <label className="block min-w-0 flex-1">
      <span className="block truncate pb-0.5 font-mono text-[9px] text-muted-foreground">{label}</span>
      <select
        className={fieldClass}
        value={mixed ? MIXED_OPTION : value}
        disabled={disabled}
        onChange={(e) => e.target.value !== MIXED_OPTION && onChange(e.target.value)}
      >
        {mixed && <option value={MIXED_OPTION}>Mixed</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function ColorField({
  label,
  value,
  mixed,
  disabled,
  onCommit,
  onClear,
}: {
  label: string;
  value: string;
  mixed?: boolean;
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
          value={!mixed && value ? value.slice(0, 7) : "#000000"}
          disabled={disabled}
          onChange={(e) => onCommit(e.target.value)}
          className="size-7 shrink-0 cursor-pointer rounded-[6px] border border-border/60 bg-transparent p-0.5 disabled:opacity-50"
          aria-label={`${label} colour`}
        />
        <input
          type="text"
          className={fieldClass}
          value={mixed ? "" : value}
          placeholder={mixed ? "Mixed" : "none"}
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
