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

/**
 * How an effect that draws its own pixels mixes with the layer beneath it.
 *
 * Restricted to the modes `feBlend`, CSS `mix-blend-mode`/`background-blend-mode`
 * and Core Graphics all agree on, so grain and texture composite the same way in
 * the canvas, the SVG/PNG export and the generated HTML.
 */
export type EffectBlendMode = "normal" | "multiply" | "screen" | "overlay" | "soft-light";

/**
 * One entry in a layer's effect stack.
 *
 * **Why one list rather than three fields.** This used to be `shadows: Shadow[]`
 * plus `blur: Blur | null` plus `noise: Noise | null`, and the shape of that
 * carried a claim the renderer could not honour: that a layer has at most one
 * blur, that grain is a property rather than a thing you stack, and — worst —
 * that the relative order of a blur, a grain and a shadow is fixed by the model
 * instead of chosen by the designer. It is not. Grain *under* a blur is a
 * smeared field; grain *over* it is film. Both are legitimate and only an
 * ordered list can say which one this layer means.
 *
 * So: one `effects` array per node, tagged variants, **applied in list order**.
 * Index 0 is applied first — closest to the raw layer — and every later entry
 * composites on top of the result of the ones before it. Adding appends, which
 * is why a freshly added drop shadow lands over what is already there.
 *
 * The one thing order cannot decide is where a *backdrop* effect sits.
 * `background-blur` and `glass` sample what is painted **behind** the layer, so
 * they are drawn beneath it no matter where in the list they appear; their order
 * among themselves is respected, their order relative to the filter effects is
 * not, because "behind the layer" and "on the layer" are different places rather
 * than different times. The panel says so rather than pretending otherwise.
 *
 * Every variant below is a *composition of primitives every target already has*.
 * That is the rule this module exists to enforce: `glass` is a name for a recipe
 * (backdrop blur + rim refraction + tint + light), not a new drawing primitive,
 * so SVG, PNG, PDF, HTML, React and SwiftUI can each honour it or say precisely
 * which part of it they cannot. Figma's own list has one more item — *Shader
 * (Beta)* — and it is deliberately absent here: a shader is a **program**, and a
 * document that holds a program can only be rendered by something that runs it.
 * Eight exporters cannot, so a Juno document will not hold one.
 */
export type Effect =
  | DropShadowEffect
  | InnerShadowEffect
  | LayerBlurEffect
  | BackgroundBlurEffect
  | NoiseEffect
  | TextureEffect
  | GlassEffect;

export type EffectType = Effect["type"];

/** Fields every effect carries. Absent `visible` means visible — an effect
 *  written before the eye existed is not a hidden one. */
interface EffectCommon {
  visible?: boolean;
}

export interface DropShadowEffect extends EffectCommon {
  type: "drop-shadow";
  color: Rgba;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
}

export interface InnerShadowEffect extends EffectCommon {
  type: "inner-shadow";
  color: Rgba;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
}

/**
 * Saturation on the blurs is a multiplier, 1 being "leave the colour alone".
 *
 * It lives on the blur rather than on the node because saturation is only ever
 * meaningful *with* one: a frosted panel is a blurred sample of what is behind
 * it with its colour pushed back up, and every target expresses the pair as a
 * single operation — `backdrop-filter: blur() saturate()` in CSS,
 * `feGaussianBlur` + `feColorMatrix type="saturate"` in SVG, and the saturation
 * SwiftUI's materials already bake in. Splitting them would let a document
 * express a saturation nothing could render.
 */
export interface LayerBlurEffect extends EffectCommon {
  type: "layer-blur";
  radius: number;
  saturation?: number;
}

export interface BackgroundBlurEffect extends EffectCommon {
  type: "background-blur";
  radius: number;
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
export interface NoiseEffect extends EffectCommon {
  type: "noise";
  /** 0..1 — how strongly the grain is mixed over the layer. */
  opacity: number;
  /** `feTurbulence` base frequency, in cycles per point. Higher is finer. */
  density: number;
  /** `feTurbulence` seed. Explicit and persisted: a grain that reshuffles on
   *  every render is a grain that makes two exports of one document differ. */
  seed: number;
  /** Grey grain (film) rather than per-channel colour speckle. */
  monochrome: boolean;
  blend: EffectBlendMode;
}

/**
 * A lit relief — Figma's "Texture".
 *
 * Grain and texture come from the same turbulence field and are still two
 * different things: grain is that field used as *colour*, texture is that field
 * used as a *height map* and then lit. So this is the same `feTurbulence` the
 * noise effect emits, handed to `feDiffuseLighting` with a distant light, which
 * is the standard SVG recipe for a surface and is expressible everywhere
 * turbulence already was (the CSS exporter embeds the identical filter as a
 * tiled data-URI, exactly as it does for grain).
 *
 * `depth` is `surfaceScale`, `roughness` is `numOctaves` — named for what a
 * designer is reaching for, stored as what the filter takes, so nothing has to
 * be guessed back out on the way to an export.
 */
export interface TextureEffect extends EffectCommon {
  type: "texture";
  /** `feTurbulence` base frequency — the size of the grain of the surface. */
  scale: number;
  /** `feDiffuseLighting` surfaceScale — how far the relief stands up. */
  depth: number;
  /** `feTurbulence` numOctaves: 1 is smooth swells, 4 is coarse tooth. */
  roughness: number;
  seed: number;
  /** The light's colour, which is what tints the lit surface. */
  color: Rgba;
  /** 0..1 — how strongly the lit surface is mixed over the layer. */
  opacity: number;
  blend: EffectBlendMode;
}

/**
 * Glass: a named recipe, not a new primitive.
 *
 * This replaces a one-shot "Liquid glass" button that expanded into a blur, a
 * gradient fill, two inner shadows and a grain and then forgot it had done so —
 * which meant there was no such thing as *a* glass effect to adjust, hide or
 * remove, only a scattering of primitives you had to recognise. The whole point
 * of an effect stack is that what you added is a thing you can still see.
 *
 * The fields are the ones Figma exposes on its Glass effect, and every one of
 * them is rendered by composing primitives:
 *
 *  - `blur`/`saturation` — the backdrop sample, drawn the way `background-blur`
 *    already is.
 *  - `refraction`/`depth` — the rim. A real lens magnifies and displaces what is
 *    behind it near its edge, so the renderer paints a second, magnified copy of
 *    the same backdrop masked to a band `depth` points wide at the silhouette's
 *    edge. Nothing exotic: a transform, a mask and a gradient.
 *  - `tint`/`tintOpacity` — the surface colour, painted as a shape over the
 *    backdrop with a top-to-bottom sheen so the surface reads as curved.
 *  - `lightIntensity`/`lightAngle` — the rim light, painted as a gradient stroke
 *    on the silhouette, bright where the light is and dark opposite it.
 *
 * A target that cannot do one of those parts says which part, rather than
 * dropping the effect or inventing its own glass.
 */
export interface GlassEffect extends EffectCommon {
  type: "glass";
  /** Backdrop blur radius, in points. */
  blur: number;
  /** Saturation lift on the backdrop; 1 leaves colour alone. */
  saturation: number;
  /** 0..1 — how hard the rim bends what is behind it. 0 is flat frosting. */
  refraction: number;
  /** Width of the refracting rim, in points. */
  depth: number;
  /** The glass's own colour. */
  tint: Rgba;
  /** 0..1, applied over `tint`'s own alpha. */
  tintOpacity: number;
  /** 0..1 — brightness of the specular rim. */
  lightIntensity: number;
  /** Degrees clockwise from 12 o'clock: where the light is coming from. */
  lightAngle: number;
}

/** The effects that sample what is painted behind the layer rather than the
 *  layer itself, and are therefore drawn beneath it. */
export function isBackdropEffect(effect: Effect): effect is BackgroundBlurEffect | GlassEffect {
  return effect.type === "background-blur" || effect.type === "glass";
}

// ---------------------------------------------------------------------------
// The pre-`effects` wire shapes
// ---------------------------------------------------------------------------

/**
 * `shadows`, `blur` and `noise` as documents written before the effect stack
 * carry them.
 *
 * These are not part of the decoded model any more — no renderer, exporter or
 * panel reads them — but they are still part of the *wire* format, because a
 * document stored last week has them and no other shape. `schema.ts` folds them
 * into `effects` on the way in (see `foldLegacyEffects`), which is why there is
 * no migration and no schema version bump: the same reasoning the `noise`
 * default was added under, and the same benefit — a build that has not run
 * anything still opens every stored document.
 */
export interface LegacyShadow {
  type: "drop" | "inner";
  color: Rgba;
  offsetX: number;
  offsetY: number;
  blur: number;
  spread: number;
  visible?: boolean;
}

export interface LegacyBlur {
  type: "layer" | "background";
  radius: number;
  saturation?: number;
}

export interface LegacyNoise {
  opacity: number;
  density: number;
  seed: number;
  monochrome: boolean;
  blend: EffectBlendMode;
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

/**
 * How the corner curve meets the straight edge: 0 is a circular arc, 1 is the
 * flattest superellipse the renderer draws (the "squircle" every Apple surface
 * is built from). One value for the whole node, because that is what the shape
 * is — smoothing is a property of *how* a corner is rounded, not of which
 * corner, and a per-corner tuple would let a box have two different curve
 * families meeting in the middle of an edge.
 *
 * Kept to `[0, 1]` rather than exposing the superellipse exponent directly:
 * the exponent is derived (see `superellipseExponent` in `render.ts`) so that
 * the corner's closest approach to the vertex does not move as this slides, and
 * a designer who could set the exponent could make a shape whose radius field
 * no longer describes it.
 */
export type CornerSmoothing = number;

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
  /**
   * Squircle-ness of the rounded corners; 0 is the circular arc every document
   * written before this field existed draws.
   *
   * Required on the decoded node, not optional, for the same reason `effects`
   * is — and the reason is sharper here than it looks. `updateNode` refuses any
   * patch key that is not already `in` the node, which is what stops a patch
   * inventing `characters` on a rectangle. An *optional* smoothing is absent
   * from every node in every stored document, so that guard would have refused
   * to ever set it: the inspector control would have thrown on first use and no
   * document could ever acquire a smoothed corner. The wire form still tolerates
   * the missing key (`.default(0)` in the schema), so nothing on disk changes.
   */
  cornerSmoothing: CornerSmoothing;
  /**
   * The layer's effect stack, applied in list order (see `Effect`).
   *
   * Required (never absent) on a decoded node even though every document
   * written before the stack existed lacks the key: the schema folds those
   * documents' `shadows`/`blur`/`noise` into this list on the way in and
   * defaults the rest to `[]`, so a renderer never has to invent one mid-frame.
   */
  effects: Effect[];
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
