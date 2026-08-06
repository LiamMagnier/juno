/**
 * Juno Design — the platform-independent scene model.
 *
 * These are the *shape* declarations only; `schema.ts` carries the executable
 * contract (zod) that every persisted document and every operation is validated
 * against, and `contracts/design/design-document.v1.schema.json` is the
 * language-neutral mirror the Swift `Codable` types are checked against.
 *
 * Two rules the whole feature rests on:
 *
 *  1. **Identity is a minted id, never a rendering artefact.** A node is
 *     addressed by `NodeId` — a stable string minted once and persisted. DOM
 *     selectors, generated class names, XPath and layer names are all derived,
 *     all mutable, and none of them may ever be used to address an editable
 *     object. This is what makes "change only what I selected" enforceable, and
 *     what lets a Mac and a browser edit the same document.
 *  2. **The tree is a flat map plus explicit child order.** Children live in
 *     `children: NodeId[]` on their container, so z-order is the array order
 *     (index 0 is furthest back) rather than an implicit consequence of
 *     traversal. Lookup stays O(1), which the layout engine and the operation
 *     inverses both depend on.
 */

export const DESIGN_SCHEMA_VERSION = 1;

export type NodeId = string;
export type PageId = string;
export type ComponentId = string;
export type VariableId = string;
export type CollectionId = string;
export type InteractionId = string;
export type AnimationId = string;
export type CommentId = string;
export type AssetId = string;

// ---------------------------------------------------------------------------
// Paint, effects, typography
// ---------------------------------------------------------------------------

/** sRGB with straight (non-premultiplied) alpha, components 0..1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface GradientStop {
  position: number; // 0..1
  color: Rgba;
}

export type Paint =
  | { type: "solid"; color: Rgba; opacity?: number; visible?: boolean; boundVariable?: VariableId | null }
  | {
      type: "linear-gradient";
      stops: GradientStop[];
      /** Gradient axis in normalized node space (0,0 top-left → 1,1 bottom-right). */
      from: { x: number; y: number };
      to: { x: number; y: number };
      opacity?: number;
      visible?: boolean;
    }
  | {
      type: "radial-gradient";
      stops: GradientStop[];
      center: { x: number; y: number };
      radius: number;
      opacity?: number;
      visible?: boolean;
    }
  | { type: "image"; assetId: AssetId; scaleMode: "fill" | "fit" | "stretch" | "tile"; opacity?: number; visible?: boolean };

export type StrokeAlign = "inside" | "center" | "outside";

export interface Stroke {
  paint: Paint;
  weight: number;
  align: StrokeAlign;
  dash?: number[];
}

export interface Shadow {
  type: "drop" | "inner";
  color: Rgba;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  visible?: boolean;
}

export interface Blur {
  type: "layer" | "background";
  radius: number;
  /**
   * Saturation multiplier applied together with the blur; 1 leaves colour alone.
   *
   * It lives on the blur rather than on the node because saturation is only ever
   * meaningful *with* one: a "liquid glass" panel is a blurred sample of what is
   * behind it with its colour pushed back up, and every target expresses the
   * pair as a single operation — `backdrop-filter: blur() saturate()` in CSS,
   * `feGaussianBlur` + `feColorMatrix type="saturate"` in SVG, and the
   * saturation SwiftUI's materials already bake in. Splitting them would let a
   * document express a saturation nothing could render.
   *
   * Optional, with 1 as the identity, for the same reason `Paint.opacity` is:
   * a stored blur that never mentions it means "unchanged".
   */
  saturation?: number;
}

/**
 * Film grain over a layer.
 *
 * This is `feTurbulence` and nothing more — deliberately. Noise is the one
 * effect with no natural declarative form, and the temptation is to invent a
 * "Juno grain" that only Juno can draw. Instead the model carries exactly the
 * four numbers an SVG turbulence node takes, so the canvas, the SVG/PNG exports
 * and the CSS targets (which embed the same turbulence as a data-URI
 * background) all draw the identical grain from the identical parameters.
 */
export interface Noise {
  /** 0..1 — how strongly the grain is mixed over the layer. */
  opacity: number;
  /** `feTurbulence` base frequency, in cycles per point. Higher is finer. */
  density: number;
  /** `feTurbulence` seed. Explicit and persisted: a grain that reshuffles on
   *  every render is a grain that makes two exports of one document differ. */
  seed: number;
  /** Grey grain (film) rather than per-channel colour speckle. */
  monochrome: boolean;
  /** How the grain mixes with the layer beneath it. Restricted to the modes
   *  `feBlend`, CSS `mix-blend-mode` and Core Graphics all agree on. */
  blend: "normal" | "multiply" | "screen" | "overlay" | "soft-light";
  visible?: boolean;
}

export type BlendMode =
  | "normal"
  | "multiply"
  | "screen"
  | "overlay"
  | "darken"
  | "lighten"
  | "color-dodge"
  | "color-burn"
  | "hard-light"
  | "soft-light"
  | "difference"
  | "exclusion";

/** Uniform radius, or per-corner starting top-left and going clockwise. */
export type CornerRadius = number | [number, number, number, number];

export interface Typography {
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  lineHeight: number | { unit: "percent"; value: number };
  letterSpacing: number;
  textAlign: "left" | "center" | "right" | "justify";
  verticalAlign: "top" | "middle" | "bottom";
  textCase?: "none" | "upper" | "lower" | "title";
  textDecoration?: "none" | "underline" | "strikethrough";
  italic?: boolean;
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export type ConstraintBehavior = "min" | "max" | "center" | "stretch" | "scale";

/** `min` is left/top, `max` is right/bottom — spelled by axis, not by edge, so
 *  one union serves both axes without a horizontal/vertical duplicate. */
export interface Constraints {
  horizontal: ConstraintBehavior;
  vertical: ConstraintBehavior;
}

export type SizingMode = "fixed" | "hug" | "fill";

export interface Padding {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type LayoutDirection = "horizontal" | "vertical" | "grid";
export type LayoutAlign = "start" | "center" | "end" | "baseline";
export type LayoutJustify = "start" | "center" | "end" | "space-between" | "space-around" | "space-evenly";

export interface AutoLayout {
  direction: LayoutDirection;
  padding: Padding;
  gap: number;
  /** Cross-axis gap for grid and wrapped flows; falls back to `gap` when absent. */
  crossGap?: number;
  align: LayoutAlign;
  justify: LayoutJustify;
  wrap: boolean;
  /** Grid track count. Only read when `direction === "grid"`. */
  columns?: number;
}

/** How a child behaves inside its parent's auto layout. */
export interface LayoutChild {
  /** Fill along the parent's main axis (flex-grow, but boolean-shaped). */
  grow: boolean;
  alignSelf?: LayoutAlign | "stretch";
  /** Ignore the flow entirely and keep x/y as parent-relative coordinates. */
  absolute: boolean;
}

export interface SizeLimits {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

export type NodeType =
  | "frame"
  | "group"
  | "rectangle"
  | "ellipse"
  | "line"
  | "path"
  | "text"
  | "image"
  | "component"
  | "instance";

/** Every node carries the full common block; type-specific data hangs off the
 *  discriminated members below. Fields are required (not optional) so a decoded
 *  document is total — a renderer never has to invent a default mid-frame. */
export interface BaseNode {
  id: NodeId;
  type: NodeType;
  name: string;
  /** Null only for a page's root frame. */
  parentId: NodeId | null;
  /** Parent-relative, in points, of the node's untransformed top-left. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise, about the node's centre. */
  rotation: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  blendMode: BlendMode;
  fills: Paint[];
  strokes: Stroke[];
  cornerRadius: CornerRadius;
  shadows: Shadow[];
  blur: Blur | null;
  /** Grain over this layer. Required (never absent) on a decoded node: the
   *  schema defaults a missing key to `null`, so a v1 document written before
   *  grain existed still decodes to a total node. */
  noise: Noise | null;
  constraints: Constraints;
  widthMode: SizingMode;
  heightMode: SizingMode;
  limits: SizeLimits;
  layoutChild: LayoutChild;
  /** Bound design variables, keyed by the property path they drive
   *  (e.g. `"fills.0.color"`, `"cornerRadius"`, `"width"`). */
  boundVariables: Record<string, VariableId>;
}

export interface ContainerNode extends BaseNode {
  type: "frame" | "group" | "component" | "instance";
  children: NodeId[];
  clipsContent: boolean;
  layout: AutoLayout | null;
}

export interface FrameNode extends ContainerNode {
  type: "frame";
}

export interface GroupNode extends ContainerNode {
  type: "group";
}

export interface ComponentNode extends ContainerNode {
  type: "component";
  componentId: ComponentId;
}

export interface InstanceNode extends ContainerNode {
  type: "instance";
  componentId: ComponentId;
  /** Which variant of the set this instance shows, by property name. */
  variantProperties: Record<string, string>;
  /** Per-node overrides applied on top of the main component's subtree, keyed
   *  by the *main component's* node id so a re-instantiation still lands. */
  overrides: Record<NodeId, Record<string, unknown>>;
}

export interface RectangleNode extends BaseNode {
  type: "rectangle";
}

export interface EllipseNode extends BaseNode {
  type: "ellipse";
}

export interface LineNode extends BaseNode {
  type: "line";
}

export interface PathNode extends BaseNode {
  type: "path";
  /** SVG path data in the node's own coordinate space (0,0 → width,height). */
  d: string;
  windingRule: "nonzero" | "evenodd";
}

export interface TextNode extends BaseNode {
  type: "text";
  characters: string;
  typography: Typography;
}

export interface ImageNode extends BaseNode {
  type: "image";
  assetId: AssetId;
  scaleMode: "fill" | "fit" | "stretch" | "tile";
}

export type DesignNode =
  | FrameNode
  | GroupNode
  | ComponentNode
  | InstanceNode
  | RectangleNode
  | EllipseNode
  | LineNode
  | PathNode
  | TextNode
  | ImageNode;

export function isContainer(node: DesignNode): node is FrameNode | GroupNode | ComponentNode | InstanceNode {
  return node.type === "frame" || node.type === "group" || node.type === "component" || node.type === "instance";
}

// ---------------------------------------------------------------------------
// Pages, components, variables
// ---------------------------------------------------------------------------

export interface DesignPage {
  id: PageId;
  name: string;
  /** Top-level nodes on this page, back-to-front. */
  children: NodeId[];
  backgroundColor: Rgba;
}

export type ComponentPropertyType = "boolean" | "text" | "instance-swap" | "variant";

export interface ComponentProperty {
  name: string;
  type: ComponentPropertyType;
  defaultValue: string | boolean;
  /** For `variant`: the allowed values, in author order. */
  options?: string[];
  /** Node this property drives, and which of its fields. */
  targetNodeId?: NodeId;
  targetField?: string;
}

export interface ComponentDefinition {
  id: ComponentId;
  name: string;
  description: string;
  /** The node that *is* this component's default appearance. */
  rootNodeId: NodeId;
  properties: ComponentProperty[];
  /** Variant sets map a property-value combination to its own root node.
   *  Key is the canonical `"prop=value,prop=value"` string (sorted by name). */
  variants: Record<string, NodeId>;
}

export type VariableValue =
  | { kind: "color"; value: Rgba }
  | { kind: "number"; value: number }
  | { kind: "string"; value: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "alias"; value: VariableId };

export interface VariableCollection {
  id: CollectionId;
  name: string;
  /** Mode ids in author order; the first is the default. */
  modes: { id: string; name: string }[];
}

export interface DesignVariable {
  id: VariableId;
  collectionId: CollectionId;
  name: string;
  type: "color" | "number" | "string" | "boolean";
  /** One value per mode id. A missing mode inherits the collection's default. */
  valuesByMode: Record<string, VariableValue>;
}

// ---------------------------------------------------------------------------
// Prototyping and motion
// ---------------------------------------------------------------------------

export type InteractionTrigger =
  | { type: "click" }
  | { type: "hover" }
  | { type: "press" }
  | { type: "drag" }
  | { type: "key"; key: string }
  | { type: "delay"; ms: number }
  | { type: "scroll-into-view" };

export type InteractionAction =
  | { type: "navigate"; targetNodeId: NodeId }
  | { type: "back" }
  | { type: "open-overlay"; targetNodeId: NodeId }
  | { type: "close-overlay" }
  | { type: "scroll-to"; targetNodeId: NodeId }
  | { type: "open-url"; url: string }
  | { type: "set-variable"; variableId: VariableId; value: VariableValue }
  | { type: "set-variable-mode"; collectionId: CollectionId; modeId: string }
  | { type: "set-variant"; instanceNodeId: NodeId; variantProperties: Record<string, string> }
  | { type: "play-animation"; animationId: AnimationId; reverse: boolean };

export type EasingCurve =
  | { type: "linear" }
  | { type: "ease-in" }
  | { type: "ease-out" }
  | { type: "ease-in-out" }
  | { type: "cubic-bezier"; x1: number; y1: number; x2: number; y2: number }
  | { type: "spring"; stiffness: number; damping: number; mass: number };

export type TransitionKind = "instant" | "dissolve" | "slide" | "push" | "move";

export interface Transition {
  kind: TransitionKind;
  direction?: "left" | "right" | "up" | "down";
  durationMs: number;
  delayMs: number;
  easing: EasingCurve;
  /** Match nodes across frames by stable id and tween the difference —
   *  the concept behind "smart animate". */
  matchStableIds: boolean;
}

export interface PrototypeInteraction {
  id: InteractionId;
  sourceNodeId: NodeId;
  trigger: InteractionTrigger;
  action: InteractionAction;
  transition: Transition;
}

export type AnimatableProperty =
  | "x"
  | "y"
  | "width"
  | "height"
  | "rotation"
  | "opacity"
  | "cornerRadius"
  | "blur"
  | "fillColor"
  | "strokeColor"
  | "fontSize"
  | "letterSpacing"
  | "scale";

export interface Keyframe {
  /** Milliseconds from the start of the animation. */
  time: number;
  value: number | Rgba;
  /** Easing applied on the segment that *starts* at this keyframe. */
  easing: EasingCurve;
}

export interface MotionTrack {
  nodeId: NodeId;
  property: AnimatableProperty;
  keyframes: Keyframe[];
}

export interface MotionAnimation {
  id: AnimationId;
  name: string;
  durationMs: number;
  loop: boolean;
  tracks: MotionTrack[];
  /** Component state this animation represents, when it is a state animation. */
  state?: "default" | "hover" | "pressed" | "selected" | "loading" | string;
}

// ---------------------------------------------------------------------------
// Comments and assets
// ---------------------------------------------------------------------------

export interface DesignComment {
  id: CommentId;
  /** Anchored to a stable node id when possible; otherwise page coordinates. */
  nodeId: NodeId | null;
  pageId: PageId;
  x: number;
  y: number;
  body: string;
  authorId: string;
  createdAt: string;
  resolvedAt: string | null;
  /** Transaction this comment produced, when it was sent to Juno as an edit
   *  request — the link that survives after the edit is applied. */
  transactionId: string | null;
}

export interface AssetRef {
  id: AssetId;
  kind: "image";
  /** App-relative URL or data URL. Never a third-party origin at rest. */
  url: string;
  width: number;
  height: number;
  mimeType: string;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export interface DesignDocument {
  schemaVersion: number;
  id: string;
  name: string;
  /** Monotonic. Every applied transaction bumps it by one; an operation that
   *  names a stale `baseRevision` is refused rather than rebased. */
  revision: number;
  /** Schema versions this document has been migrated through, oldest first. */
  migratedFrom: number[];
  pages: DesignPage[];
  nodes: Record<NodeId, DesignNode>;
  components: Record<ComponentId, ComponentDefinition>;
  collections: Record<CollectionId, VariableCollection>;
  variables: Record<VariableId, DesignVariable>;
  /** Active mode per collection. Absent means the collection's first mode. */
  activeModes: Record<CollectionId, string>;
  interactions: Record<InteractionId, PrototypeInteraction>;
  animations: Record<AnimationId, MotionAnimation>;
  comments: DesignComment[];
  assets: Record<AssetId, AssetRef>;
  updatedAt: string;
}
