/**
 * Sampling a motion animation, and the document a scrub draws.
 *
 * The scene model already carried animations, tracks and keyframes; what it
 * never had was an answer to "what does this document look like at t = 340 ms".
 * That answer lives here, and it is deliberately pure: same animation and same
 * time in, same document out, in the browser, in the WKWebView and in a Node
 * test. The timeline is the only thing that plays motion today, so if this
 * module were approximate the preview would be the *only* description of an
 * animation anyone ever sees, and it would be a wrong one.
 *
 * Two rules it will not break:
 *
 *  1. **A scrub is derived, never committed.** `derivePreviewDocument` returns a
 *     fresh document that is handed to the canvas and thrown away on the next
 *     frame. It never goes near `apply`, so a playhead cannot end up in the undo
 *     stack, in the store, or on the Mac bridge.
 *  2. **Nothing here invents a primitive.** Every property maps onto fields the
 *     scene model already has and `render.ts` already draws, so the preview is
 *     the same renderer the exports use, fed different numbers.
 *
 * It lives beside the panels rather than in `src/lib/design/` only because the
 * design library was owned elsewhere the round this was written. It has no React
 * import and no dependency on either panel; moving it to `src/lib/design/
 * motion.ts` is a rename, and it belongs there once an exporter needs it.
 */

import type {
  AnimatableProperty,
  DesignDocument,
  DesignNode,
  EasingCurve,
  Keyframe,
  MotionAnimation,
  MotionTrack,
  Rgba,
} from "@/lib/design/types";

/** What a keyframe can hold — the model's `Keyframe["value"]`, named. */
export type MotionValue = number | Rgba;

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

/**
 * The animatable properties, as the timeline offers them.
 *
 * `previewed` is the honest bit. A track always lands in the document and always
 * reaches the handoff bundle, but the canvas can only show what the SVG renderer
 * draws — and it does not draw layer blur, so a blur track is authored blind
 * here and takes effect in the HTML prototype export, which does emit
 * `filter: blur()`. Saying so in the panel is cheaper than letting someone drag
 * a keyframe and conclude the timeline is broken.
 *
 * `requires` is the same courtesy for tracks that need something on the layer to
 * act on: a stroke colour cannot animate on a layer with no stroke, and font
 * size means nothing on a rectangle.
 */
export interface AnimatablePropertyInfo {
  property: AnimatableProperty;
  label: string;
  /** Shown after the value field. Empty for unitless properties. */
  unit: string;
  /** Colour-valued rather than number-valued. */
  color: boolean;
  /** The canvas preview shows this property change. */
  previewed: boolean;
  /** What the layer must already have for the track to do anything. */
  requires?: "fill" | "stroke" | "text";
}

export const ANIMATABLE_PROPERTIES: AnimatablePropertyInfo[] = [
  { property: "x", label: "X", unit: "pt", color: false, previewed: true },
  { property: "y", label: "Y", unit: "pt", color: false, previewed: true },
  { property: "width", label: "Width", unit: "pt", color: false, previewed: true },
  { property: "height", label: "Height", unit: "pt", color: false, previewed: true },
  { property: "scale", label: "Scale", unit: "×", color: false, previewed: true },
  { property: "rotation", label: "Rotation", unit: "°", color: false, previewed: true },
  { property: "opacity", label: "Opacity", unit: "%", color: false, previewed: true },
  { property: "cornerRadius", label: "Corner radius", unit: "pt", color: false, previewed: true },
  { property: "fillColor", label: "Fill colour", unit: "", color: true, previewed: true, requires: "fill" },
  { property: "strokeColor", label: "Stroke colour", unit: "", color: true, previewed: true, requires: "stroke" },
  { property: "fontSize", label: "Font size", unit: "pt", color: false, previewed: true, requires: "text" },
  { property: "letterSpacing", label: "Letter spacing", unit: "pt", color: false, previewed: true, requires: "text" },
  { property: "blur", label: "Blur", unit: "pt", color: false, previewed: false },
];

export function propertyInfo(property: AnimatableProperty): AnimatablePropertyInfo {
  // Every member of the union has a row above; the fallback exists so a property
  // added to the model without a row here degrades to a usable label rather than
  // crashing the panel.
  return ANIMATABLE_PROPERTIES.find((entry) => entry.property === property) ?? { property, label: property, unit: "", color: false, previewed: false };
}

export function isColorProperty(property: AnimatableProperty): boolean {
  return propertyInfo(property).color;
}

/**
 * Whether a track on this property would have anything to act on.
 *
 * The timeline uses it to explain, rather than to forbid: a layer can gain a
 * stroke after the track was authored, and the track is still valid data in the
 * meantime.
 */
export function propertyApplies(node: DesignNode, property: AnimatableProperty): boolean {
  switch (propertyInfo(property).requires) {
    case "fill":
      return node.fills.length === 0 || node.fills[0].type === "solid";
    case "stroke":
      return node.strokes.length > 0 && node.strokes[0].paint.type === "solid";
    case "text":
      return node.type === "text";
    default:
      return true;
  }
}

/**
 * The layer's current value for a property — what a new keyframe is seeded with.
 *
 * Seeding matters more than it looks: a keyframe that arrives at 0 would slam
 * the layer to the origin the moment it is placed, and the first thing anyone
 * would do is type the value back in by hand.
 */
export function readNodeProperty(node: DesignNode, property: AnimatableProperty): MotionValue | null {
  switch (property) {
    case "x":
      return node.x;
    case "y":
      return node.y;
    case "width":
      return node.width;
    case "height":
      return node.height;
    case "scale":
      return 1;
    case "rotation":
      return node.rotation;
    case "opacity":
      return node.opacity;
    case "cornerRadius":
      return typeof node.cornerRadius === "number" ? node.cornerRadius : node.cornerRadius[0];
    case "blur":
      return node.blur?.radius ?? 0;
    case "fillColor": {
      const paint = node.fills[0];
      return paint && paint.type === "solid" ? paint.color : { r: 0, g: 0, b: 0, a: 1 };
    }
    case "strokeColor": {
      const stroke = node.strokes[0];
      return stroke && stroke.paint.type === "solid" ? stroke.paint.color : { r: 0, g: 0, b: 0, a: 1 };
    }
    case "fontSize":
      return node.type === "text" ? node.typography.fontSize : null;
    case "letterSpacing":
      return node.type === "text" ? node.typography.letterSpacing : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

/** CSS's own control points for the named curves, so a keyframe eased
 *  "ease-in-out" here and exported as the CSS keyword describe one curve. */
const NAMED_BEZIERS: Record<string, [number, number, number, number]> = {
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
};

/**
 * Progress of a cubic Bézier timing function at `t`.
 *
 * The curve is parametric, so `t` (the x we want) is not the parameter: x has to
 * be inverted first. Newton converges in a handful of steps for the curves a
 * timing function can express; bisection finishes the pathological ones, where
 * the derivative is flat enough that Newton walks off.
 */
function bezierProgress(x1: number, y1: number, x2: number, y2: number, t: number): number {
  const curve = (a: number, b: number, u: number) => {
    const c = 3 * a;
    const bTerm = 3 * (b - a) - c;
    const aTerm = 1 - c - bTerm;
    return ((aTerm * u + bTerm) * u + c) * u;
  };
  const slope = (a: number, b: number, u: number) => {
    const c = 3 * a;
    const bTerm = 3 * (b - a) - c;
    const aTerm = 1 - c - bTerm;
    return (3 * aTerm * u + 2 * bTerm) * u + c;
  };

  let u = t;
  for (let i = 0; i < 8; i++) {
    const error = curve(x1, x2, u) - t;
    if (Math.abs(error) < 1e-6) return curve(y1, y2, u);
    const d = slope(x1, x2, u);
    if (Math.abs(d) < 1e-6) break;
    u -= error / d;
  }

  let low = 0;
  let high = 1;
  u = t;
  for (let i = 0; i < 24; i++) {
    const x = curve(x1, x2, u);
    if (Math.abs(x - t) < 1e-6) break;
    if (x < t) low = u;
    else high = u;
    u = (low + high) / 2;
  }
  return curve(y1, y2, u);
}

/**
 * A spring's displacement from 0 to 1 after `elapsedMs`.
 *
 * Springs are the one easing in this model that is not a shape over normalised
 * time — a stiff spring settles in 200 ms whether the segment is 200 ms or two
 * seconds long — so this is solved in real time against the segment's own
 * duration, from rest, releasing towards 1. All three damping regimes are
 * closed-form; no integration, so scrubbing backwards gives the same number as
 * scrubbing forwards, which a stepped simulation would not.
 *
 * A spring does not arrive exactly at its target, and an underdamped one passes
 * it on the way. That is the point of using one, and it means the value at the
 * next keyframe's time is *near* that keyframe's value rather than equal to it.
 */
function springProgress(stiffness: number, damping: number, mass: number, elapsedMs: number): number {
  const m = Math.max(1e-4, mass);
  const k = Math.max(1e-4, stiffness);
  const t = Math.max(0, elapsedMs) / 1000;
  const omega = Math.sqrt(k / m);
  const zeta = damping / (2 * Math.sqrt(k * m));

  if (zeta < 1) {
    const omegaD = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * t) * (Math.cos(omegaD * t) + ((zeta * omega) / omegaD) * Math.sin(omegaD * t));
  }
  if (Math.abs(zeta - 1) < 1e-6) {
    return 1 - Math.exp(-omega * t) * (1 + omega * t);
  }
  const root = omega * Math.sqrt(zeta * zeta - 1);
  const r1 = -omega * zeta + root;
  const r2 = -omega * zeta - root;
  return 1 - (r2 * Math.exp(r1 * t) - r1 * Math.exp(r2 * t)) / (r2 - r1);
}

/**
 * Eased progress across one segment.
 *
 * `t` is normalised position in the segment (0..1) and `segmentMs` is how long
 * the segment really lasts — only a spring needs the second one, and it needs it
 * badly.
 */
export function easedProgress(easing: EasingCurve, t: number, segmentMs: number): number {
  const clamped = Math.max(0, Math.min(1, t));
  switch (easing.type) {
    case "linear":
      return clamped;
    case "cubic-bezier":
      return bezierProgress(easing.x1, easing.y1, easing.x2, easing.y2, clamped);
    case "spring":
      return springProgress(easing.stiffness, easing.damping, easing.mass, clamped * segmentMs);
    default: {
      const points = NAMED_BEZIERS[easing.type];
      return points ? bezierProgress(points[0], points[1], points[2], points[3], clamped) : clamped;
    }
  }
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

/** Keyframes in time order. The model does not require the array to be sorted,
 *  and dragging one past its neighbour is the ordinary way to unsort it. */
export function sortedKeyframes(keyframes: Keyframe[]): Keyframe[] {
  return [...keyframes].sort((a, b) => a.time - b.time);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Blend two keyframe values.
 *
 * A track whose keyframes disagree about their type — a number and a colour on
 * one property — holds the earlier value rather than blending nonsense. The
 * schema permits it (a keyframe value is `number | Rgba` regardless of the
 * track's property), so the sampler has to have an answer.
 */
export function mixValues(from: MotionValue, to: MotionValue, progress: number): MotionValue {
  if (typeof from === "number" && typeof to === "number") return from + (to - from) * progress;
  if (typeof from === "object" && typeof to === "object") {
    return {
      r: clamp01(from.r + (to.r - from.r) * progress),
      g: clamp01(from.g + (to.g - from.g) * progress),
      b: clamp01(from.b + (to.b - from.b) * progress),
      a: clamp01(from.a + (to.a - from.a) * progress),
    };
  }
  return from;
}

/**
 * The value a track holds at `timeMs`.
 *
 * Outside the keyframes the track holds its end values rather than extrapolating
 * — an animation that flew off to infinity before its first keyframe would be
 * useless to scrub — and an empty track has no value at all, which is different
 * from having zero.
 */
export function sampleTrack(track: MotionTrack, timeMs: number): MotionValue | null {
  const frames = sortedKeyframes(track.keyframes);
  if (frames.length === 0) return null;
  if (timeMs <= frames[0].time) return frames[0].value;

  const last = frames[frames.length - 1];
  if (timeMs >= last.time) return last.value;

  let index = 0;
  while (index < frames.length - 1 && frames[index + 1].time <= timeMs) index++;
  const from = frames[index];
  const to = frames[index + 1];
  const span = to.time - from.time;
  // Two keyframes at the same instant are a step, not a division by zero.
  if (span <= 0) return to.value;

  return mixValues(from.value, to.value, easedProgress(from.easing, (timeMs - from.time) / span, span));
}

// ---------------------------------------------------------------------------
// The preview document
// ---------------------------------------------------------------------------

/**
 * Write one sampled value onto a copy of a layer.
 *
 * Every case maps onto a field the renderer already reads. Where a property
 * cannot land — a colour tween onto a gradient fill, a font size onto a
 * rectangle — the layer comes back untouched rather than being coerced into
 * something the author did not ask for.
 */
function applyMotionValue(node: DesignNode, property: AnimatableProperty, value: MotionValue): DesignNode {
  if (property === "fillColor") {
    if (typeof value === "number") return node;
    const paint = node.fills[0];
    if (paint && paint.type !== "solid") return node;
    const next = paint ? { ...paint, color: value } : { type: "solid" as const, color: value };
    return { ...node, fills: [next, ...node.fills.slice(1)] };
  }
  if (property === "strokeColor") {
    if (typeof value === "number") return node;
    const stroke = node.strokes[0];
    if (!stroke || stroke.paint.type !== "solid") return node;
    return { ...node, strokes: [{ ...stroke, paint: { ...stroke.paint, color: value } }, ...node.strokes.slice(1)] };
  }
  if (typeof value !== "number") return node;

  switch (property) {
    case "x":
      return { ...node, x: value };
    case "y":
      return { ...node, y: value };
    // A hug- or fill-sized layer ignores its own width, so a size tween on one
    // would draw nothing at all. The preview pins the mode; the stored document
    // keeps whatever the layer was authored with.
    case "width":
      return { ...node, width: Math.max(0, value), widthMode: "fixed" };
    case "height":
      return { ...node, height: Math.max(0, value), heightMode: "fixed" };
    case "rotation":
      return { ...node, rotation: value };
    case "opacity":
      return { ...node, opacity: clamp01(value) };
    case "cornerRadius":
      return { ...node, cornerRadius: Math.max(0, value) };
    case "blur":
      return { ...node, blur: value > 0 ? { type: node.blur?.type ?? "layer", radius: value } : null };
    case "scale": {
      // Scale about the centre, which is where a designer means it. There is no
      // scale field in the model — this is the transform expressed in the
      // geometry the renderer draws, so it survives export like any other size.
      const factor = Math.max(0, value);
      const width = node.width * factor;
      const height = node.height * factor;
      return {
        ...node,
        x: node.x + (node.width - width) / 2,
        y: node.y + (node.height - height) / 2,
        width,
        height,
        widthMode: "fixed",
        heightMode: "fixed",
      };
    }
    case "fontSize":
      return node.type === "text" ? { ...node, typography: { ...node.typography, fontSize: Math.max(1, value) } } : node;
    case "letterSpacing":
      return node.type === "text" ? { ...node, typography: { ...node.typography, letterSpacing: value } } : node;
    default:
      return node;
  }
}

/**
 * The document as the animation has it at `timeMs`.
 *
 * Shallow all the way down: only the layers a track names are copied, so
 * scrubbing a two-track animation over a thousand-layer document rebuilds two
 * objects per frame. The result is a real `DesignDocument` — the canvas lays it
 * out and renders it with exactly the code it uses for the committed one — but
 * it is never handed to a transaction, and its `revision` is left as-is so
 * nothing downstream can mistake it for a saved state.
 */
export function derivePreviewDocument(doc: DesignDocument, animation: MotionAnimation, timeMs: number): DesignDocument {
  let nodes: DesignDocument["nodes"] | null = null;

  for (const track of animation.tracks) {
    const current = (nodes ?? doc.nodes)[track.nodeId];
    if (!current) continue;
    const value = sampleTrack(track, timeMs);
    if (value === null) continue;
    const next = applyMotionValue(current, track.property, value);
    if (next === current) continue;
    if (!nodes) nodes = { ...doc.nodes };
    nodes[track.nodeId] = next;
  }

  return nodes ? { ...doc, nodes } : doc;
}

/** Where the playhead should wrap: the animation's own duration, or the last
 *  keyframe when someone has dragged one past the end. */
export function animationSpanMs(animation: MotionAnimation): number {
  const lastKeyframe = animation.tracks.reduce(
    (latest, track) => track.keyframes.reduce((inner, frame) => Math.max(inner, frame.time), latest),
    0
  );
  return Math.max(animation.durationMs, lastKeyframe);
}
