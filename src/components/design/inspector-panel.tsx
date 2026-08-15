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
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalDistributeCenter,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalDistributeCenter,
  Link2,
  Link2Off,
} from "lucide-react";
import {
  CheckboxField,
  ColorField,
  EffectsSection,
  FillControl,
  IconButton,
  StrokeControl,
  NumberField,
  OptionalNumberField,
  Section,
  SelectField,
  TextField,
} from "@/components/design/effects-panel";
import { readImageAsset } from "@/components/design/use-design-document";
import { collapseCornerRadius, cornerValues } from "@/lib/design/render";
import { hexToRgba, rgbaToHex } from "@/lib/design/variables";
import { variantAxes } from "@/lib/design/instances";
import {
  isContainer,
  type AutoLayout,
  type BlendMode,
  type DesignDocument,
  type DesignNode,
  type ImageNode,
  type LayoutChild,
  type NodeId,
  type SizeLimits,
  type TextNode,
  type Typography,
} from "@/lib/design/types";
import type { DesignOperation, NodePatch } from "@/lib/design/operations";

/** The eight things `align` can do. Named exactly as the editor's `align`
 *  takes them so there is no translation table between the button and the
 *  gesture. */
export type AlignAxis = "left" | "center-x" | "right" | "distribute-x" | "top" | "center-y" | "bottom" | "distribute-y";

interface Props {
  document: DesignDocument;
  selection: NodeId[];
  /** The page the canvas is showing. Only read with nothing selected, where the
   *  panel describes the page instead of a layer. */
  pageId?: string;
  onApply: (operations: DesignOperation[], summary: string) => void;
  /** Alignment is computed from laid-out boxes, which is the editor's job — the
   *  inspector only offers the gesture. Absent in hosts that do not lay out. */
  onAlign?: (axis: AlignAxis) => void;
  readOnly?: boolean;
}

/** A value read across the selection: `mixed` when the layers disagree. */
interface Shared<T> {
  value: T;
  mixed: boolean;
}

function shared<N extends DesignNode, T>(nodes: N[], read: (node: N) => T): Shared<T> {
  const value = read(nodes[0]);
  const first = JSON.stringify(value ?? null);
  return { value, mixed: nodes.some((node) => JSON.stringify(read(node) ?? null) !== first) };
}

export function InspectorPanel({ document: doc, selection, pageId, onApply, onAlign, readOnly }: Props) {
  const nodes = selection.map((id) => doc.nodes[id]).filter((n): n is DesignNode => !!n);

  if (nodes.length === 0) {
    return <DocumentSection document={doc} pageId={pageId} onApply={onApply} readOnly={readOnly} />;
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

  /**
   * The same write, built per layer from that layer's own state.
   *
   * `updateNode` replaces `cornerRadius`, `limits` and `layoutChild` wholesale
   * rather than merging them, so "set the top-left corner to 8" and "turn on
   * grow" are both edits to an object the other layers each have their own copy
   * of. Assembling one patch and sending it everywhere is precisely how the
   * first layer's stroke colour used to land on the rest.
   */
  const patchEach = (build: (node: DesignNode) => NodePatch, summary: string) =>
    onApply(
      editable.map((n) => ({ op: "updateNode" as const, nodeId: n.id, patch: build(n) })),
      summary
    );

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
  const blendMode = shared(nodes, (n) => n.blendMode);

  // A group carries `clipsContent` in the model and the renderer ignores it
  // (render.ts only clips a non-group container), so the control is offered
  // where it does something and nowhere else.
  const containers = nodes.filter(isContainer);
  const clippable = containers.length === nodes.length && containers.every((n) => n.type !== "group");
  const clips = clippable ? shared(containers, (n) => n.clipsContent) : null;

  // Grow, align-self and absolute only mean anything inside a parent that lays
  // its children out — a child of a plain frame is already positioned by its own
  // x/y, which is what `absolute` asks for.
  const inFlow = nodes.every((n) => {
    const parent = n.parentId ? doc.nodes[n.parentId] : null;
    return !!parent && isContainer(parent) && !!parent.layout;
  });

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

      {onAlign && <AlignSection count={nodes.length} onAlign={onAlign} disabled={readOnly || editable.length < 2} />}

      <Section title="Position & size">
        <div className="grid grid-cols-2 gap-1.5">
          <NumberField label="X" value={x.value} mixed={x.mixed} disabled={readOnly} onCommit={(v) => patchAll({ x: v }, "Set position")} />
          <NumberField label="Y" value={y.value} mixed={y.mixed} disabled={readOnly} onCommit={(v) => patchAll({ y: v }, "Set position")} />
          <NumberField
            label="W"
            ariaLabel="Width"
            value={width.value}
            mixed={width.mixed}
            min={0}
            disabled={readOnly}
            onCommit={(v) => patchAll({ width: v, widthMode: "fixed" }, "Set size")}
          />
          <NumberField
            label="H"
            ariaLabel="Height"
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
        {/* The sizing behaviour sits directly under the number it governs, so
            "W 320" and "W Fixed" read as two halves of one property. */}
        <div className="grid grid-cols-2 gap-1.5 pt-1.5">
          <SelectField
            label="W"
            ariaLabel="Width behaviour"
            value={widthMode.value}
            mixed={widthMode.mixed}
            options={SIZING_OPTIONS}
            disabled={readOnly}
            onChange={(v) => patchAll({ widthMode: v as NodePatch["widthMode"] }, "Set width behaviour")}
          />
          <SelectField
            label="H"
            ariaLabel="Height behaviour"
            value={heightMode.value}
            mixed={heightMode.mixed}
            options={SIZING_OPTIONS}
            disabled={readOnly}
            onChange={(v) => patchAll({ heightMode: v as NodePatch["heightMode"] }, "Set height behaviour")}
          />
        </div>
        {/* The floor and ceiling the layout engine has always clamped against
            (`clampSize`), with no way to set them outside the AI. Empty means
            unset, which is not the same as 0 — see `OptionalNumberField`. */}
        <div className="grid grid-cols-2 gap-1.5 pt-1.5">
          {LIMIT_FIELDS.map(({ key, label, name }) => {
            const limit = shared(nodes, (n) => n.limits[key] ?? null);
            return (
              <OptionalNumberField
                key={key}
                label={label}
                ariaLabel={name}
                value={limit.value}
                mixed={limit.mixed}
                min={0}
                disabled={readOnly}
                onCommit={(v) => patchEach((node) => ({ limits: withLimit(node.limits, key, v) }), `Set ${name.toLowerCase()}`)}
              />
            );
          })}
        </div>
      </Section>

      <Section title="Constraints">
        <div className="grid grid-cols-2 gap-1.5">
          <SelectField
            label="Horiz"
            ariaLabel="Horizontal constraint"
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
            label="Vert"
            ariaLabel="Vertical constraint"
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

      {inFlow && <LayoutChildSection nodes={nodes} patchEach={patchEach} readOnly={readOnly} />}

      {single && isContainer(single) && <AutoLayoutSection node={single} onApply={onApply} readOnly={readOnly} />}

      <Section title="Appearance">
        {/* Twelve blend modes have been in the model and honoured by the
            renderer (`mix-blend-mode`) since the first slice with nothing
            anywhere in the product able to set one. */}
        <SelectField
          label="Blend"
          ariaLabel="Blend mode"
          value={blendMode.value}
          mixed={blendMode.mixed}
          options={BLEND_MODE_OPTIONS}
          disabled={readOnly}
          onChange={(v) => patchAll({ blendMode: v as BlendMode }, "Set blend mode")}
        />
        {allSameType && first.type !== "line" && (
          <CornerRadiusControl nodes={nodes} patchEach={patchEach} readOnly={readOnly} />
        )}
        {clips && (
          <CheckboxField
            label="Clip"
            ariaLabel="Clip content to this frame"
            checked={clips.value}
            mixed={clips.mixed}
            disabled={readOnly}
            onChange={(v) => patchAll({ clipsContent: v }, v ? "Clip content" : "Show overflow")}
          />
        )}
      </Section>

      {/* A line is drawn from its stroke and has no interior, so a fill control
          on one is a control that does nothing. Effects are a different matter:
          a line casts a shadow like anything else. */}
      {first.type !== "line" && <FillControl nodes={nodes} editable={editable} onApply={onApply} readOnly={readOnly} />}

      {/* Stroke, as the list it is in the model.
          `StrokeControl` had been written in full — per-stroke paint, gradients,
          weight and alignment — and never imported anywhere, while this panel
          offered one colour swatch and one weight that assigned a fresh
          one-element array. So a document could hold three strokes or a gradient
          stroke, and touching the colour field silently flattened them; the
          alignment control the renderer now honours did not exist at all. */}
      <StrokeControl nodes={nodes} editable={editable} onApply={onApply} readOnly={readOnly} />

      <EffectsSection nodes={nodes} editable={editable} onApply={onApply} readOnly={readOnly} />

      {single?.type === "instance" && <InstanceSection node={single} document={doc} onApply={onApply} readOnly={readOnly} />}

      {single?.type === "image" && <ImageSection node={single} document={doc} onApply={onApply} readOnly={readOnly} />}

      {allSameType && first.type === "text" && (
        <TypographySection
          nodes={nodes as TextNode[]}
          single={single?.type === "text" ? single : null}
          patchAll={patchAll}
          readOnly={readOnly}
        />
      )}

      {Object.keys(doc.variables).length > 0 && single && (
        <Section title="Variables">
          <SelectField
            label="Fill"
            ariaLabel="Fill colour token"
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

/**
 * What the inspector says when nothing is selected.
 *
 * It used to say one sentence, centred in the vertical middle of a 256px column
 * — a hero layout in a place a tool should be dense, and the only screen in the
 * editor where the eye has to travel to the middle of an empty rail to find one
 * line of text. Figma answers an empty selection with the page and document
 * instead, and so does this: the page's name, editable in place, its background,
 * and the counts this panel can derive from the document it already holds.
 *
 * The background well was held back through two passes because the model could
 * only set the colour at `createPage` — a well that showed the colour and could
 * not write it would have been worse than none. `setPageBackground` is what
 * changed, so the well is a real control and the alpha the picker offers is real
 * too: `backgroundColor` is an `Rgba` and the canvas honours its alpha, which is
 * how a page gets a transparent ground to export a sticker sheet against.
 */
function DocumentSection({
  document: doc,
  pageId,
  onApply,
  readOnly,
}: {
  document: DesignDocument;
  pageId?: string;
  onApply: (operations: DesignOperation[], summary: string) => void;
  readOnly?: boolean;
}) {
  const page = doc.pages.find((p) => p.id === pageId) ?? doc.pages[0];
  const onPage = page ? countSubtree(doc, page.children) : 0;

  return (
    <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
      <Section title="Page">
        {page && (
          <TextField
            label="Name"
            value={page.name}
            disabled={readOnly}
            onCommit={(value) => value.trim() && value !== page.name && onApply([{ op: "renamePage", pageId: page.id, name: value.trim() }], "Rename page")}
          />
        )}
        {page && (
          <ColorField
            label="Bg"
            ariaLabel="Page background colour"
            value={rgbaToHex(page.backgroundColor)}
            disabled={readOnly}
            // No `onClear`: every other well in the editor clears to "no paint",
            // and a page has no such state — the schema requires an `Rgba` and
            // the canvas has to paint something. Transparent is reachable through
            // the picker's alpha, which is the honest way to say "nothing here".
            onCommit={(hex) => {
              const color = hexToRgba(hex);
              if (color) onApply([{ op: "setPageBackground", pageId: page.id, color }], "Set page background");
            }}
          />
        )}
        <p className="text-caption text-muted-foreground">Select a layer to edit its properties.</p>
      </Section>

      <Section title="Document">
        <dl className="space-y-1">
          {[
            { term: "Layers here", value: onPage },
            { term: "Pages", value: doc.pages.length },
            { term: "Components", value: Object.keys(doc.components).length },
            { term: "Variables", value: Object.keys(doc.variables).length },
            { term: "Interactions", value: Object.keys(doc.interactions).length },
            { term: "Animations", value: Object.keys(doc.animations).length },
          ].map((row) => (
            <div key={row.term} className="flex items-baseline justify-between gap-2">
              <dt className="truncate font-mono text-micro text-muted-foreground">{row.term}</dt>
              <dd className="shrink-0 text-xs tabular-nums text-foreground">{row.value}</dd>
            </div>
          ))}
        </dl>
      </Section>
    </div>
  );
}

/**
 * Which variant of its component this instance shows.
 *
 * This section was refused twice on honesty grounds, and the refusals were
 * right: `variantProperties` was a field the AI panel and the prototype editor
 * could write and *nothing that draws* could read, so a variant picker would
 * have relabelled a layer and changed no pixel. `setInstanceVariant` is what
 * changed — it swaps the instance's subtree for the variant's — so the control
 * below is a control.
 *
 * The axes come from `variantAxes`, which reads the keys of `component.variants`
 * rather than `component.properties`: `properties` is an optional description
 * that a component made by "promote to component" or by the AI simply does not
 * have, so a picker built from it would be empty for most real components. Every
 * option listed therefore has a node behind it, and the operation refuses a
 * combination that does not — which is why there is no "Mixed"-style fallback
 * here: an unresolvable variant cannot be reached from these menus.
 *
 * Component *properties* — the boolean/text/instance-swap half — are still not
 * offered, and still for the original reason. `targetNodeId` names a node inside
 * the main component, and nothing in the document maps that to the corresponding
 * node inside this instance, so those controls would write to a record nobody
 * reads. Half a section that works beats a whole one that lies.
 */
function InstanceSection({
  node,
  document: doc,
  onApply,
  readOnly,
}: {
  node: DesignNode & { type: "instance" };
  document: DesignDocument;
  onApply: (operations: DesignOperation[], summary: string) => void;
  readOnly?: boolean;
}) {
  const component = doc.components[node.componentId];
  const axes = component ? variantAxes(component) : [];
  // A component with no variant set has nothing to choose between, and a section
  // whose only content is the name of something is a row of chrome.
  if (!component || axes.length === 0) return null;

  return (
    <Section title="Instance">
      <p className="truncate font-mono text-micro text-muted-foreground" title={component.name}>
        {component.name}
      </p>
      {axes.map((axis) => (
        <SelectField
          key={axis.name}
          label={axis.name}
          ariaLabel={`${axis.name} variant`}
          value={node.variantProperties[axis.name] ?? ""}
          options={[
            // The blank row is the component's own root, which is what an
            // instance placed before the set existed is showing — reachable, and
            // named for what it is rather than left as an unlabelled gap.
            { value: "", label: "Default" },
            ...axis.values.map((value) => ({ value, label: value })),
          ]}
          disabled={readOnly}
          onChange={(value) => {
            const next = { ...node.variantProperties };
            // Removing the key rather than storing "" — the empty string is not
            // a variant value and `canonicalVariantKey` would build `size=` for
            // it, a key no `createVariant` has ever written.
            if (value) next[axis.name] = value;
            else delete next[axis.name];
            onApply([{ op: "setInstanceVariant", instanceNodeId: node.id, variantProperties: next }], "Set variant");
          }}
        />
      ))}
    </Section>
  );
}

/** Every node under these roots, the page's own children included — the number
 *  a designer means by "how much is on this page". */
function countSubtree(doc: DesignDocument, roots: NodeId[]): number {
  let total = 0;
  const walk = (ids: NodeId[]) => {
    for (const id of ids) {
      const node = doc.nodes[id];
      if (!node) continue;
      total += 1;
      if (isContainer(node)) walk(node.children);
    }
  };
  walk(roots);
  return total;
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

/** Both axes' floors and ceilings, in the order they pair up in the 2-up grid:
 *  the two widths on one row, the two heights on the next. */
const LIMIT_FIELDS: { key: keyof SizeLimits; label: string; name: string }[] = [
  { key: "minWidth", label: "Min W", name: "Minimum width" },
  { key: "maxWidth", label: "Max W", name: "Maximum width" },
  { key: "minHeight", label: "Min H", name: "Minimum height" },
  { key: "maxHeight", label: "Max H", name: "Maximum height" },
];

/** An absent limit is not a zero one — `clampSize` reads a `maxWidth` of 0 as
 *  "zero points wide" — so clearing the field removes the key rather than
 *  writing a number. */
function withLimit(limits: SizeLimits, key: keyof SizeLimits, value: number | null): SizeLimits {
  const next: SizeLimits = { ...limits };
  if (value === null) delete next[key];
  else next[key] = Math.max(0, value);
  return next;
}

const BLEND_MODE_OPTIONS: { value: BlendMode; label: string }[] = [
  { value: "normal", label: "Normal" },
  { value: "multiply", label: "Multiply" },
  { value: "screen", label: "Screen" },
  { value: "overlay", label: "Overlay" },
  { value: "darken", label: "Darken" },
  { value: "lighten", label: "Lighten" },
  { value: "color-dodge", label: "Colour dodge" },
  { value: "color-burn", label: "Colour burn" },
  { value: "hard-light", label: "Hard light" },
  { value: "soft-light", label: "Soft light" },
  { value: "difference", label: "Difference" },
  { value: "exclusion", label: "Exclusion" },
];

/**
 * Align and distribute — all eight, which is how many `align()` has always
 * implemented.
 *
 * The toolbar wired three of them, so align-left, align-right, align-top,
 * align-bottom and distribute-vertically were reachable by nothing at all. They
 * live here rather than in the toolbar because this rail is where they survive a
 * narrow window, and because the toolbar cluster appeared and disappeared with
 * the selection and shoved everything to its right sideways as it did.
 *
 * Distribute needs three boxes to have anything to say — with two, the "even
 * spacing" it computes is the one gap that is already there — so it is disabled
 * below three rather than being a button that does nothing.
 */
function AlignSection({ count, onAlign, disabled }: { count: number; onAlign: (axis: AlignAxis) => void; disabled?: boolean }) {
  return (
    <Section title="Align">
      <div className="grid grid-cols-4 gap-1">
        {ALIGN_BUTTONS.map(({ axis, label, icon: Icon }) => (
          <button
            key={axis}
            type="button"
            aria-label={label}
            title={label}
            disabled={disabled || (axis.startsWith("distribute") && count < 3)}
            onClick={() => onAlign(axis)}
            className="pressable flex h-6 items-center justify-center rounded-control border border-border/60 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-30 coarse:h-9"
          >
            <Icon className="size-3.5" aria-hidden />
          </button>
        ))}
      </div>
    </Section>
  );
}

/** Horizontal ops on the first row, vertical on the second, each ending in its
 *  own distribute — so the grid reads as one axis per line. */
const ALIGN_BUTTONS = [
  { axis: "left", label: "Align left edges", icon: AlignStartVertical },
  { axis: "center-x", label: "Align horizontal centres", icon: AlignCenterVertical },
  { axis: "right", label: "Align right edges", icon: AlignEndVertical },
  { axis: "distribute-x", label: "Distribute horizontally", icon: AlignHorizontalDistributeCenter },
  { axis: "top", label: "Align top edges", icon: AlignStartHorizontal },
  { axis: "center-y", label: "Align vertical centres", icon: AlignCenterHorizontal },
  { axis: "bottom", label: "Align bottom edges", icon: AlignEndHorizontal },
  { axis: "distribute-y", label: "Distribute vertically", icon: AlignVerticalDistributeCenter },
] as const satisfies readonly { axis: AlignAxis; label: string; icon: React.ComponentType<{ className?: string }> }[];

/**
 * Corner radius, per corner.
 *
 * The model has carried `number | [tl, tr, br, bl]` from the start and the
 * renderer has drawn the tuple correctly since `roundedRectPathData` — but this
 * field read `cornerRadius[0]` and wrote a scalar, so opening a card with only
 * its top corners rounded and touching the radius silently flattened the other
 * three. A card rounded at the top is one of the most ordinary shapes there is.
 *
 * Linked is the resting state because a uniform radius is the common case and
 * four boxes for one number is noise; the chain breaks the link, and a document
 * that already differs per corner opens unlinked so the field cannot lie about
 * what it is showing. Writing goes back through `collapseCornerRadius`, so a
 * shape whose corners agree stays the cheap scalar the renderer draws as a
 * `<rect>`.
 */
function CornerRadiusControl({
  nodes,
  patchEach,
  readOnly,
}: {
  nodes: DesignNode[];
  patchEach: (build: (node: DesignNode) => NodePatch, summary: string) => void;
  readOnly?: boolean;
}) {
  const corners = cornerValues(nodes[0].cornerRadius);
  const perCorner = corners.some((value) => value !== corners[0]);
  const [unlinked, setUnlinked] = React.useState(perCorner);
  const separate = unlinked || perCorner;

  const uniform = shared(nodes, (n) => cornerValues(n.cornerRadius)[0]);
  const smoothing = shared(nodes, (n) => Math.round((n.cornerSmoothing ?? 0) * 100));
  /**
   * Smoothing is only offered once a corner is actually round.
   *
   * At radius 0 the superellipse and the arc are the same point, so the field
   * would move and the shape would not — a control that does nothing, which is
   * the one thing this panel is not allowed to contain. It appears the moment
   * any selected layer has a corner to smooth, and takes the whole selection
   * with it, because that is how every other field here behaves.
   */
  const roundedSomewhere = nodes.some((node) => cornerValues(node.cornerRadius).some((value) => value > 0));

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <div className="min-w-0 flex-1">
          {separate ? (
            <div className="grid grid-cols-4 gap-1.5">
              {CORNERS.map(({ index, label, name }) => {
                const value = shared(nodes, (n) => cornerValues(n.cornerRadius)[index]);
                return (
                  <NumberField
                    key={label}
                    label={label}
                    ariaLabel={name}
                    value={value.value}
                    mixed={value.mixed}
                    min={0}
                    disabled={readOnly}
                    onCommit={(v) =>
                      patchEach((node) => {
                        const next = cornerValues(node.cornerRadius);
                        next[index] = Math.max(0, v);
                        return { cornerRadius: collapseCornerRadius(next) };
                      }, "Set corner radius")
                    }
                  />
                );
              })}
            </div>
          ) : (
            <NumberField
              label="Radius"
              ariaLabel="Corner radius"
              value={uniform.value}
              mixed={uniform.mixed}
              min={0}
              disabled={readOnly}
              onCommit={(v) => patchEach(() => ({ cornerRadius: Math.max(0, v) }), "Set corner radius")}
            />
          )}
        </div>
        <IconButton
          label={separate ? "Link corner radii" : "Set each corner separately"}
          onClick={() => {
            if (!separate) return setUnlinked(true);
            // Re-linking is an edit, not just a change of view: the four values
            // have to become one, and the top-left is the one the collapsed
            // field would have shown anyway.
            setUnlinked(false);
            if (perCorner) patchEach((node) => ({ cornerRadius: cornerValues(node.cornerRadius)[0] }), "Link corner radii");
          }}
          disabled={readOnly}
        >
          {separate ? <Link2Off className="size-3.5" aria-hidden /> : <Link2 className="size-3.5" aria-hidden />}
        </IconButton>
      </div>
      {roundedSomewhere && (
        <NumberField
          label="Smooth"
          ariaLabel="Corner smoothing"
          // Shown as a percentage because that is the number designers say to
          // each other ("60% smoothing is the iOS corner"); the model stores the
          // 0–1 the geometry actually uses, and the two are converted here
          // rather than storing percent and dividing in four render paths.
          value={smoothing.value}
          mixed={smoothing.mixed}
          min={0}
          max={100}
          suffix="%"
          disabled={readOnly}
          onCommit={(v) =>
            patchEach(() => ({ cornerSmoothing: Math.min(1, Math.max(0, v / 100)) }), "Set corner smoothing")
          }
        />
      )}
    </div>
  );
}

/** Top-left clockwise, which is the order the model stores and the order a
 *  reader's eye walks a box. */
const CORNERS = [
  { index: 0, label: "TL", name: "Top-left corner radius" },
  { index: 1, label: "TR", name: "Top-right corner radius" },
  { index: 2, label: "BR", name: "Bottom-right corner radius" },
  { index: 3, label: "BL", name: "Bottom-left corner radius" },
] as const;

/**
 * How this layer behaves inside its parent's auto layout.
 *
 * Keyed on the *parent* having a layout, because that is what makes any of it
 * meaningful: `grow` and `alignSelf` are read by `placeNode` only for children
 * in the flow, and `absolute` is the switch that takes a child out of it. All
 * three have been in the layout engine and reachable by nothing but the AI.
 */
function LayoutChildSection({
  nodes,
  patchEach,
  readOnly,
}: {
  nodes: DesignNode[];
  patchEach: (build: (node: DesignNode) => NodePatch, summary: string) => void;
  readOnly?: boolean;
}) {
  const grow = shared(nodes, (n) => n.layoutChild.grow);
  const absolute = shared(nodes, (n) => n.layoutChild.absolute);
  const alignSelf = shared(nodes, (n) => n.layoutChild.alignSelf ?? "");

  const write = (partial: Partial<LayoutChild>, summary: string) =>
    patchEach((node) => ({ layoutChild: { ...node.layoutChild, ...partial } }), summary);

  return (
    <Section title="In parent layout">
      <div className="grid grid-cols-2 gap-1.5">
        <CheckboxField
          label="Grow"
          ariaLabel="Fill the parent's main axis"
          checked={grow.value}
          mixed={grow.mixed}
          disabled={readOnly}
          onChange={(v) => write({ grow: v }, v ? "Grow to fill" : "Stop growing")}
        />
        <CheckboxField
          label="Free"
          ariaLabel="Ignore the parent's layout and keep x and y"
          checked={absolute.value}
          mixed={absolute.mixed}
          disabled={readOnly}
          onChange={(v) => write({ absolute: v }, v ? "Leave the layout flow" : "Rejoin the layout flow")}
        />
      </div>
      <SelectField
        label="Self"
        ariaLabel="Cross-axis alignment for this layer"
        value={alignSelf.value}
        mixed={alignSelf.mixed}
        options={[
          // "" is the model's absent `alignSelf`, which means the parent's own
          // `align` decides — not a fifth alignment of its own.
          { value: "", label: "Auto" },
          { value: "start", label: "Start" },
          { value: "center", label: "Center" },
          { value: "end", label: "End" },
          { value: "baseline", label: "Baseline" },
          { value: "stretch", label: "Stretch" },
        ]}
        disabled={readOnly}
        onChange={(v) =>
          patchEach(
            (node) => {
              const next: LayoutChild = { ...node.layoutChild };
              if (v === "") delete next.alignSelf;
              else next.alignSelf = v as LayoutChild["alignSelf"];
              return { layoutChild: next };
            },
            "Set self alignment"
          )
        }
      />
    </Section>
  );
}

/**
 * Typography — all of it, across the whole selection.
 *
 * `lineHeight`, `letterSpacing`, `verticalAlign`, `textDecoration` and `italic`
 * are in the model, validated by the schema and drawn by the renderer, and none
 * of them had a control. The section was also gated on a single selection, alone
 * among the inspector's sections, so "make these six labels 13pt" was six trips.
 *
 * `textCase` is deliberately still absent: nothing reads it — not the renderer,
 * not one of the eight exporters — so a control for it would write a field the
 * product cannot draw, which is worse than not offering it.
 *
 * Only the characters stay single-selection. Every other field here is a
 * property of the type; the characters are the layer's content, and a "Text"
 * box that quietly overwrote six different strings with one is not a multi-edit,
 * it is a data loss.
 */
function TypographySection({
  nodes,
  single,
  patchAll,
  readOnly,
}: {
  nodes: TextNode[];
  single: TextNode | null;
  patchAll: (patch: NodePatch, summary: string) => void;
  readOnly?: boolean;
}) {
  const type = (partial: Partial<Typography>, summary: string) => patchAll({ typography: partial }, summary);

  const family = shared(nodes, (n) => n.typography.fontFamily);
  const size = shared(nodes, (n) => n.typography.fontSize);
  const weight = shared(nodes, (n) => n.typography.fontWeight);
  const align = shared(nodes, (n) => n.typography.textAlign);
  const vertical = shared(nodes, (n) => n.typography.verticalAlign);
  const tracking = shared(nodes, (n) => n.typography.letterSpacing);
  const decoration = shared(nodes, (n) => n.typography.textDecoration ?? "none");
  const italic = shared(nodes, (n) => n.typography.italic === true);
  // A percentage line height is relative to the size, an absolute one is not, so
  // the unit is part of the value rather than a display preference — switching
  // it converts, which is the only reading under which "150 %" then "24 pt" both
  // mean what they say.
  const leadingUnit = shared(nodes, (n) => (typeof n.typography.lineHeight === "number" ? "pt" : "percent"));
  const leading = shared(nodes, (n) =>
    typeof n.typography.lineHeight === "number" ? n.typography.lineHeight : n.typography.lineHeight.value
  );

  return (
    <Section title="Typography">
      {single && (
        <TextField
          label="Text"
          value={single.characters}
          multiline
          disabled={readOnly}
          onCommit={(value) => value !== single.characters && patchAll({ characters: value }, "Edit text")}
        />
      )}
      <TextField
        label="Family"
        value={family.value}
        mixed={family.mixed}
        disabled={readOnly}
        onCommit={(v) => v && type({ fontFamily: v }, "Set typeface")}
      />
      <div className="grid grid-cols-2 gap-1.5">
        <NumberField
          label="Size"
          value={size.value}
          mixed={size.mixed}
          min={1}
          disabled={readOnly}
          onCommit={(v) => type({ fontSize: v }, "Set font size")}
        />
        <NumberField
          label="Weight"
          value={weight.value}
          mixed={weight.mixed}
          min={100}
          max={900}
          step={100}
          disabled={readOnly}
          onCommit={(v) => type({ fontWeight: v }, "Set font weight")}
        />
        <NumberField
          label="Line"
          ariaLabel="Line height"
          value={leading.value}
          mixed={leading.mixed}
          min={0}
          disabled={readOnly}
          onCommit={(v) =>
            type(
              { lineHeight: leadingUnit.value === "percent" ? { unit: "percent", value: Math.max(0, v) } : Math.max(0, v) },
              "Set line height"
            )
          }
        />
        <SelectField
          label="Unit"
          ariaLabel="Line height unit"
          value={leadingUnit.value}
          mixed={leadingUnit.mixed}
          options={[
            { value: "pt", label: "Points" },
            { value: "percent", label: "Percent" },
          ]}
          disabled={readOnly}
          onChange={(unit) =>
            // Converted, not reinterpreted: 150 % of a 16pt face is 24pt, and
            // switching the unit without converting would resize every line on
            // screen while claiming to change only how the number is written.
            patchAll(
              {
                typography: {
                  lineHeight:
                    unit === "percent"
                      ? { unit: "percent", value: size.value > 0 ? Math.round((leading.value / size.value) * 100) : 100 }
                      : Math.round(((leading.value * size.value) / 100) * 100) / 100,
                },
              },
              "Set line height unit"
            )
          }
        />
        <NumberField
          label="Track"
          ariaLabel="Letter spacing"
          value={tracking.value}
          mixed={tracking.mixed}
          min={-100}
          max={100}
          step={0.5}
          disabled={readOnly}
          onCommit={(v) => type({ letterSpacing: Math.max(-100, Math.min(100, v)) }, "Set letter spacing")}
        />
        <SelectField
          label="Style"
          ariaLabel="Type style"
          value={italic.value ? "italic" : "regular"}
          mixed={italic.mixed}
          options={[
            { value: "regular", label: "Regular" },
            { value: "italic", label: "Italic" },
          ]}
          disabled={readOnly}
          onChange={(v) => type({ italic: v === "italic" }, v === "italic" ? "Italicise" : "Set upright")}
        />
        <SelectField
          label="Align"
          ariaLabel="Horizontal text alignment"
          value={align.value}
          mixed={align.mixed}
          options={[
            { value: "left", label: "Left" },
            { value: "center", label: "Center" },
            { value: "right", label: "Right" },
            { value: "justify", label: "Justify" },
          ]}
          disabled={readOnly}
          onChange={(v) => type({ textAlign: v as Typography["textAlign"] }, "Set text alignment")}
        />
        <SelectField
          label="Vert"
          ariaLabel="Vertical text alignment"
          value={vertical.value}
          mixed={vertical.mixed}
          options={[
            { value: "top", label: "Top" },
            { value: "middle", label: "Middle" },
            { value: "bottom", label: "Bottom" },
          ]}
          disabled={readOnly}
          onChange={(v) => type({ verticalAlign: v as Typography["verticalAlign"] }, "Set vertical alignment")}
        />
      </div>
      <SelectField
        label="Decoration"
        ariaLabel="Text decoration"
        value={decoration.value}
        mixed={decoration.mixed}
        options={[
          { value: "none", label: "None" },
          { value: "underline", label: "Underline" },
          { value: "strikethrough", label: "Strikethrough" },
        ]}
        disabled={readOnly}
        onChange={(v) => type({ textDecoration: v as Typography["textDecoration"] }, "Set text decoration")}
      />
    </Section>
  );
}

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
          className="pressable w-full rounded-control border border-border/60 px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground coarse:min-h-10"
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
          className="pressable rounded-sm px-1 font-mono text-micro text-muted-foreground hover:text-destructive"
        >
          Remove
        </button>
      }
    >
      <div className="grid grid-cols-2 gap-1.5">
        <SelectField
          label="Axis"
          ariaLabel="Layout direction"
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
      {/* One letter each. Four labelled fields on one 232px row cannot each
          carry "Top"; the accessible name is the whole word, and the four sit
          in the order the CSS shorthand does so the letters are read as a
          padding box rather than as four unrelated numbers. */}
      <div className="grid grid-cols-4 gap-1.5">
        {(["top", "right", "bottom", "left"] as const).map((side) => (
          <NumberField
            key={side}
            label={side[0].toUpperCase()}
            ariaLabel={`${side[0].toUpperCase()}${side.slice(1)} padding`}
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
          ariaLabel="Cross-axis alignment"
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
          label="Space"
          ariaLabel="Distribution along the layout axis"
          value={layout.justify}
          options={[
            { value: "start", label: "Start" },
            { value: "center", label: "Center" },
            { value: "end", label: "End" },
            // "Space between" beside a leading label does not fit a half-rail
            // dropdown; under a label that already says "Space", the second word
            // is the only one carrying meaning.
            { value: "space-between", label: "Between" },
            { value: "space-around", label: "Around" },
            { value: "space-evenly", label: "Evenly" },
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
      <p className="truncate font-mono text-micro text-muted-foreground">
        {asset ? `${Math.round(asset.width)} × ${Math.round(asset.height)} ${asset.mimeType.replace("image/", "").toUpperCase()}` : "No picture yet"}
      </p>
      <button
        type="button"
        disabled={readOnly}
        onClick={() => inputRef.current?.click()}
        className="pressable w-full rounded-control border border-border/60 px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50 coarse:min-h-10"
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
