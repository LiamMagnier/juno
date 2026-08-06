"use client";

/**
 * Fill and Effects — the inspector's two direct-manipulation sections.
 *
 * Almost nothing here is new to the document. Gradients, drop shadows, inner
 * shadows and blur have been in the scene model since the first slice and have
 * never had a control, so a document could hold a three-stop radial gradient
 * that no one could author and no one could edit. This is the surface that
 * makes them reachable; only grain is genuinely new.
 *
 * Two rules the whole file follows:
 *
 *  - **Every write is one `setEffects` or one `updateNode` over the whole
 *    selection.** Effects are lists, and a list edit built per layer from that
 *    layer's own list is how "set the shadow colour" used to carry the first
 *    layer's blur radius onto the rest. So when layers disagree the header says
 *    "Mixed", the fields read the first layer — exactly as the scalar fields
 *    upstairs already do — and an edit assigns the whole new value to all of
 *    them. That is what "set the selection's shadows" means.
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
import { effectPresetOperations, type DesignOperation, type NodePatch } from "@/lib/design/operations";
import { hexToRgba, rgbaToCss, rgbaToHex } from "@/lib/design/variables";
import type { Blur, DesignNode, GradientStop, Noise, Paint, Rgba, Shadow } from "@/lib/design/types";
import { cn } from "@/lib/utils";

type Apply = (operations: DesignOperation[], summary: string) => void;

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

const DEFAULT_FILL: Rgba = { r: 0.55, g: 0.6, b: 0.95, a: 1 };

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

const FILL_KINDS = [
  { value: "none", label: "None" },
  { value: "solid", label: "Solid" },
  { value: "linear-gradient", label: "Linear" },
  { value: "radial-gradient", label: "Radial" },
] as const;

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
  const first = nodes[0];
  const paint = first.fills[0];
  const kind = paint?.type ?? "none";
  const mixed = nodes.some((n) => (n.fills[0]?.type ?? "none") !== kind);
  const [selectedStop, setSelectedStop] = React.useState(0);

  const setFills = (fills: NodePatch["fills"], summary: string) =>
    onApply(
      editable.map((n) => ({ op: "updateNode" as const, nodeId: n.id, patch: { fills } })),
      summary
    );

  const setPaint = (next: Paint, summary: string) => setFills([next], summary);

  const changeKind = (next: string) => {
    if (next === kind) return;
    if (next === "none") return setFills([], "Remove fill");
    if (next === "solid") return setPaint({ type: "solid", color: solidFrom(paint) }, "Set fill");
    const stops = stopsFrom(paint);
    if (next === "linear-gradient") {
      return setPaint({ type: "linear-gradient", stops, from: { x: 0, y: 0 }, to: { x: 0, y: 1 } }, "Set gradient fill");
    }
    return setPaint({ type: "radial-gradient", stops, center: { x: 0.5, y: 0.5 }, radius: 0.5 }, "Set gradient fill");
  };

  const gradient = paint && (paint.type === "linear-gradient" || paint.type === "radial-gradient") ? paint : null;
  // Stop editing needs one list to edit. Across a mixed selection there is no
  // such list, so the ramp is shown and the stops are not — the alternative is
  // a stop editor that silently rewrites four layers from a fifth one's ramp.
  const editStops = gradient && nodes.length === 1;

  const commitStops = (stops: GradientStop[], summary: string) => {
    if (!gradient) return;
    const ordered = [...stops].sort((a, b) => a.position - b.position);
    setPaint({ ...gradient, stops: ordered }, summary);
  };

  return (
    <Section title="Fill" action={mixed ? <MixedBadge /> : null}>
      <Segmented
        value={mixed ? "" : kind}
        options={FILL_KINDS}
        disabled={readOnly}
        onChange={changeKind}
        label="Fill type"
      />

      {kind === "solid" && !mixed && (
        <ColorField
          label="Colour"
          value={rgbaToHex(solidFrom(paint))}
          disabled={readOnly}
          onCommit={(hex) => {
            const color = hexToRgba(hex);
            if (color) setPaint({ type: "solid", color }, "Set fill");
          }}
        />
      )}

      {gradient && (
        <>
          <GradientRail
            stops={gradient.stops}
            selected={selectedStop}
            disabled={readOnly || !editStops}
            onSelect={setSelectedStop}
            onMove={(index, position) => {
              const next = gradient.stops.map((s, i) => (i === index ? { ...s, position } : s));
              commitStops(next, "Move gradient stop");
            }}
          />
          {editStops && (
            <StopEditor
              stops={gradient.stops}
              selected={Math.min(selectedStop, gradient.stops.length - 1)}
              disabled={readOnly}
              onSelect={setSelectedStop}
              onChange={commitStops}
            />
          )}
          {gradient.type === "linear-gradient" ? (
            <AxisPad
              from={gradient.from}
              to={gradient.to}
              disabled={readOnly}
              onChange={(from, to) => setPaint({ ...gradient, from, to }, "Set gradient direction")}
            />
          ) : (
            <RadialPad
              center={gradient.center}
              radius={gradient.radius}
              disabled={readOnly}
              onChange={(center, radius) => setPaint({ ...gradient, center, radius }, "Set gradient shape")}
            />
          )}
        </>
      )}
    </Section>
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

const DEFAULT_DROP_SHADOW: Shadow = {
  type: "drop",
  color: { r: 0, g: 0, b: 0, a: 0.25 },
  offsetX: 0,
  offsetY: 4,
  blur: 12,
  spread: 0,
};

const DEFAULT_NOISE: Noise = { opacity: 0.08, density: 0.9, seed: 1, monochrome: true, blend: "overlay" };

const BLUR_KINDS = [
  { value: "none", label: "None" },
  { value: "layer", label: "Layer" },
  { value: "background", label: "Background" },
] as const;

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
  const shadows = first.shadows;
  const blur = first.blur;
  const noise = first.noise;
  const same = (read: (node: DesignNode) => unknown) => {
    const reference = JSON.stringify(read(first) ?? null);
    return !nodes.some((n) => JSON.stringify(read(n) ?? null) !== reference);
  };
  const mixed = !same((n) => n.shadows) || !same((n) => n.blur) || !same((n) => n.noise);
  const ids = editable.map((n) => n.id);
  const write = (
    fields: { shadows?: Shadow[]; blur?: Blur | null; noise?: Noise | null },
    summary: string
  ) => {
    if (ids.length === 0) return;
    onApply([{ op: "setEffects", nodeIds: ids, ...fields }], summary);
  };

  const setShadows = (next: Shadow[], summary: string) => write({ shadows: next }, summary);
  const patchShadow = (index: number, partial: Partial<Shadow>, summary: string) =>
    setShadows(shadows.map((s, i) => (i === index ? { ...s, ...partial } : s)), summary);

  return (
    <Section
      title="Effects"
      action={
        <div className="flex items-center gap-1.5">
          {mixed && <MixedBadge />}
          <button
            type="button"
            disabled={readOnly || ids.length === 0}
            onClick={() => onApply(effectPresetOperations(ids, "liquid-glass"), "Apply liquid glass")}
            title="Background blur, a sheen gradient, a rim light, a lift shadow and a little grain — applied as those five things, each still editable below."
            className="pressable rounded-[6px] border border-border/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            Liquid glass
          </button>
        </div>
      }
    >
      {shadows.map((shadow, index) => (
        <ShadowRow
          key={index}
          shadow={shadow}
          index={index}
          count={shadows.length}
          disabled={readOnly}
          onChange={(partial, summary) => patchShadow(index, partial, summary)}
          onRemove={() => setShadows(shadows.filter((_, i) => i !== index), "Remove shadow")}
          onMove={(delta) => {
            const to = index + delta;
            if (to < 0 || to >= shadows.length) return;
            const next = [...shadows];
            const [moved] = next.splice(index, 1);
            next.splice(to, 0, moved);
            setShadows(next, "Reorder shadows");
          }}
        />
      ))}
      <div className="flex gap-1.5">
        <MiniButton
          disabled={readOnly || shadows.length >= 32}
          onClick={() => setShadows([...shadows, { ...DEFAULT_DROP_SHADOW }], "Add shadow")}
        >
          Add shadow
        </MiniButton>
        <MiniButton
          disabled={readOnly || shadows.length >= 32}
          onClick={() =>
            setShadows(
              [...shadows, { ...DEFAULT_DROP_SHADOW, type: "inner", color: { r: 0, g: 0, b: 0, a: 0.2 }, blur: 4, offsetY: 2 }],
              "Add inner shadow"
            )
          }
        >
          Add inner shadow
        </MiniButton>
      </div>

      <div className="grid grid-cols-2 gap-1.5 pt-1">
        <SelectField
          label="Blur"
          value={blur?.type ?? "none"}
          options={BLUR_KINDS as unknown as { value: string; label: string }[]}
          disabled={readOnly}
          onChange={(value) =>
            write(
              { blur: value === "none" ? null : { type: value as Blur["type"], radius: blur?.radius ?? 16, saturation: blur?.saturation } },
              value === "none" ? "Remove blur" : "Set blur"
            )
          }
        />
        {blur && (
          <NumberField
            label="Radius"
            value={blur.radius}
            min={0}
            disabled={readOnly}
            onCommit={(v) => write({ blur: { ...blur, radius: Math.max(0, v) } }, "Set blur radius")}
          />
        )}
      </div>
      {blur && (
        <NumberField
          label="Saturation"
          suffix="%"
          value={Math.round((blur.saturation ?? 1) * 100)}
          min={0}
          max={1000}
          step={10}
          disabled={readOnly}
          onCommit={(v) => write({ blur: { ...blur, saturation: Math.max(0, v / 100) } }, "Set blur saturation")}
        />
      )}
      {blur?.type === "background" && (
        <p className="text-[10px] leading-snug text-muted-foreground">
          Blurs what is behind this layer. Give the layer a low-alpha fill so there is something to see through.
        </p>
      )}

      <NoiseRows noise={noise} disabled={readOnly} onChange={(next, summary) => write({ noise: next }, summary)} />
    </Section>
  );
}

function ShadowRow({
  shadow,
  index,
  count,
  disabled,
  onChange,
  onRemove,
  onMove,
}: {
  shadow: Shadow;
  index: number;
  count: number;
  disabled?: boolean;
  onChange: (partial: Partial<Shadow>, summary: string) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  const hidden = shadow.visible === false;
  return (
    <div className={cn("space-y-1.5 rounded-[10px] border border-border/60 p-2", hidden && "opacity-50")}>
      <div className="flex items-center gap-1.5">
        <SelectField
          label={`Shadow ${index + 1}`}
          value={shadow.type}
          options={[
            { value: "drop", label: "Drop" },
            { value: "inner", label: "Inner" },
          ]}
          disabled={disabled}
          onChange={(value) => onChange({ type: value as Shadow["type"] }, "Set shadow type")}
        />
        <div className="flex shrink-0 items-end gap-0.5 self-end pb-0.5">
          <IconButton
            label={hidden ? `Show shadow ${index + 1}` : `Hide shadow ${index + 1}`}
            disabled={disabled}
            onClick={() => onChange({ visible: hidden }, hidden ? "Show shadow" : "Hide shadow")}
          >
            {hidden ? "○" : "●"}
          </IconButton>
          <IconButton label={`Move shadow ${index + 1} forward`} disabled={disabled || index === 0} onClick={() => onMove(-1)}>
            ↑
          </IconButton>
          <IconButton label={`Move shadow ${index + 1} back`} disabled={disabled || index === count - 1} onClick={() => onMove(1)}>
            ↓
          </IconButton>
          <IconButton label={`Remove shadow ${index + 1}`} disabled={disabled} destructive onClick={onRemove}>
            ×
          </IconButton>
        </div>
      </div>
      <ColorField
        label="Colour"
        value={rgbaToHex(shadow.color)}
        disabled={disabled}
        onCommit={(hex) => {
          const color = hexToRgba(hex);
          if (color) onChange({ color }, "Set shadow colour");
        }}
      />
      <div className="grid grid-cols-4 gap-1.5">
        <NumberField label="X" value={shadow.offsetX} disabled={disabled} onCommit={(v) => onChange({ offsetX: v }, "Set shadow offset")} />
        <NumberField label="Y" value={shadow.offsetY} disabled={disabled} onCommit={(v) => onChange({ offsetY: v }, "Set shadow offset")} />
        <NumberField label="Blur" value={shadow.blur} min={0} disabled={disabled} onCommit={(v) => onChange({ blur: Math.max(0, v) }, "Set shadow blur")} />
        <NumberField label="Spread" value={shadow.spread} disabled={disabled} onCommit={(v) => onChange({ spread: v }, "Set shadow spread")} />
      </div>
    </div>
  );
}

function NoiseRows({
  noise,
  disabled,
  onChange,
}: {
  noise: Noise | null;
  disabled?: boolean;
  onChange: (noise: Noise | null, summary: string) => void;
}) {
  if (!noise) {
    return (
      <MiniButton disabled={disabled} onClick={() => onChange({ ...DEFAULT_NOISE }, "Add grain")}>
        Add grain
      </MiniButton>
    );
  }
  const hidden = noise.visible === false;
  return (
    <div className={cn("space-y-1.5 rounded-[10px] border border-border/60 p-2", hidden && "opacity-50")}>
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] text-muted-foreground">Grain</span>
        <div className="flex gap-0.5">
          <IconButton
            label={hidden ? "Show grain" : "Hide grain"}
            disabled={disabled}
            onClick={() => onChange({ ...noise, visible: hidden }, hidden ? "Show grain" : "Hide grain")}
          >
            {hidden ? "○" : "●"}
          </IconButton>
          <IconButton label="Remove grain" disabled={disabled} destructive onClick={() => onChange(null, "Remove grain")}>
            ×
          </IconButton>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField
          label="Amount"
          suffix="%"
          value={Math.round(noise.opacity * 100)}
          min={0}
          max={100}
          disabled={disabled}
          onCommit={(v) => onChange({ ...noise, opacity: Math.max(0, Math.min(1, v / 100)) }, "Set grain amount")}
        />
        <NumberField
          label="Density"
          value={noise.density}
          min={0.001}
          max={4}
          step={0.05}
          disabled={disabled}
          onCommit={(v) => onChange({ ...noise, density: Math.max(0.001, Math.min(4, v)) }, "Set grain density")}
        />
      </div>
      <div className="grid grid-cols-2 gap-1.5">
        <SelectField
          label="Blend"
          value={noise.blend}
          options={[
            { value: "overlay", label: "Overlay" },
            { value: "soft-light", label: "Soft light" },
            { value: "multiply", label: "Multiply" },
            { value: "screen", label: "Screen" },
            { value: "normal", label: "Normal" },
          ]}
          disabled={disabled}
          onChange={(value) => onChange({ ...noise, blend: value as Noise["blend"] }, "Set grain blend")}
        />
        <NumberField
          label="Seed"
          value={noise.seed}
          min={0}
          max={65535}
          disabled={disabled}
          onCommit={(v) => onChange({ ...noise, seed: Math.max(0, Math.min(65_535, Math.round(v))) }, "Set grain seed")}
        />
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={noise.monochrome}
          disabled={disabled}
          onChange={(event) => onChange({ ...noise, monochrome: event.target.checked }, "Set grain colour")}
        />
        Monochrome
      </label>
    </div>
  );
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
