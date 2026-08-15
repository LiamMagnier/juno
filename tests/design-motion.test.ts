/**
 * Motion: the arithmetic a timeline is only as honest as.
 *
 * The scene model has carried animations, tracks and keyframes since the
 * document schema was written, but nothing ever *played* one — so none of the
 * questions a timeline asks had a tested answer. These are those questions:
 * where a track sits between two keyframes, what a spring does when the segment
 * it eases is longer than the spring takes to settle, and what the canvas is
 * handed while someone drags the playhead.
 *
 * The preview matters most. It is derived, never committed, so nothing here may
 * mutate the document it was given — a scrub that edited the scene would be an
 * edit nobody authored and undo has never heard of.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ANIMATABLE_PROPERTIES,
  animationSpanMs,
  derivePreviewDocument,
  easedProgress,
  isColorProperty,
  mixValues,
  propertyApplies,
  readNodeProperty,
  sampleTrack,
  sortedKeyframes,
} from "../src/components/design/motion-model";
import { applyTransaction, invertTransaction } from "../src/lib/design/operations";
import { renderPageSvg } from "../src/lib/design/render";
import type { EasingCurve, Keyframe, MotionAnimation, MotionTrack, Rgba } from "../src/lib/design/types";
import { PAGE_ID, run, signInDocument, transaction } from "./design-fixtures";

const LINEAR: EasingCurve = { type: "linear" };

function frame(time: number, value: number | Rgba, easing: EasingCurve = LINEAR): Keyframe {
  return { time, value, easing };
}

function track(nodeId: string, property: MotionTrack["property"], keyframes: Keyframe[]): MotionTrack {
  return { nodeId, property, keyframes };
}

function animation(tracks: MotionTrack[], overrides: Partial<MotionAnimation> = {}): MotionAnimation {
  return { id: "anim1", name: "Fade in", durationMs: 1000, loop: false, tracks, ...overrides };
}

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

test("every easing the model can hold starts at 0 and lands on 1", () => {
  const curves: EasingCurve[] = [
    { type: "linear" },
    { type: "ease-in" },
    { type: "ease-out" },
    { type: "ease-in-out" },
    { type: "cubic-bezier", x1: 0.68, y1: -0.55, x2: 0.27, y2: 1.55 },
  ];
  for (const easing of curves) {
    assert.ok(Math.abs(easedProgress(easing, 0, 300)) < 1e-6, `${easing.type} must start at rest`);
    assert.ok(Math.abs(easedProgress(easing, 1, 300) - 1) < 1e-6, `${easing.type} must arrive`);
  }
});

test("a cubic bezier with the identity control points is linear", () => {
  const identity: EasingCurve = { type: "cubic-bezier", x1: 0, y1: 0, x2: 1, y2: 1 };
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
    assert.ok(Math.abs(easedProgress(identity, t, 500) - t) < 1e-4);
  }
});

test("ease-in lags linear and ease-out leads it", () => {
  // The named curves are CSS's own control points, because the exporter writes
  // the keyword out and whatever reads it will use exactly those.
  assert.ok(easedProgress({ type: "ease-in" }, 0.5, 400) < 0.5);
  assert.ok(easedProgress({ type: "ease-out" }, 0.5, 400) > 0.5);
});

test("a bezier that overshoots reports progress above 1", () => {
  const back: EasingCurve = { type: "cubic-bezier", x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 };
  assert.ok(easedProgress(back, 0.6, 400) > 1, "an anticipation curve has to be allowed past its target");
});

test("a spring is solved in real time, not across the segment", () => {
  // The whole reason `easedProgress` takes a duration. A stiff spring settles in
  // its own time; stretching the segment to two seconds must not stretch the
  // spring with it, or "spring" would just be another named curve.
  const spring: EasingCurve = { type: "spring", stiffness: 180, damping: 12, mass: 1 };
  const short = easedProgress(spring, 0.5, 200);
  const long = easedProgress(spring, 0.5, 2000);
  assert.notEqual(short, long);
  assert.ok(Math.abs(long - 1) < Math.abs(short - 1), "the longer segment gives the spring time to settle");
});

test("an underdamped spring overshoots and a critically damped one does not", () => {
  const bouncy: EasingCurve = { type: "spring", stiffness: 200, damping: 8, mass: 1 };
  const samples = Array.from({ length: 101 }, (_, i) => easedProgress(bouncy, i / 100, 1000));
  assert.ok(Math.max(...samples) > 1.05, "a light damping ratio is chosen precisely for the overshoot");

  // ζ = damping / 2√(km) = 2·√200 / 2√200 = 1.
  const critical: EasingCurve = { type: "spring", stiffness: 200, damping: 2 * Math.sqrt(200), mass: 1 };
  const criticalSamples = Array.from({ length: 101 }, (_, i) => easedProgress(critical, i / 100, 1000));
  assert.ok(Math.max(...criticalSamples) <= 1 + 1e-9, "critical damping is the fastest approach without overshoot");
  for (let i = 1; i < criticalSamples.length; i++) {
    assert.ok(criticalSamples[i] >= criticalSamples[i - 1] - 1e-9, "and it is monotone");
  }
});

test("an overdamped spring crawls towards its target without passing it", () => {
  const heavy: EasingCurve = { type: "spring", stiffness: 100, damping: 60, mass: 1 };
  const samples = Array.from({ length: 101 }, (_, i) => easedProgress(heavy, i / 100, 1000));
  assert.ok(Math.abs(samples[0]) < 1e-9);
  assert.ok(Math.max(...samples) <= 1 + 1e-9);
  // ζ = 3: a second is not enough for it, and it is still short at the end of
  // the segment. That is what the author asked for by damping it this hard.
  assert.ok(samples[100] > 0.8 && samples[100] < 1);
});

test("a segment boundary reads its keyframe exactly, however far short the spring fell", () => {
  // The consequence of the test above, and the reason it is not a bug: a spring
  // eases *within* a segment, and the next keyframe's own value takes over the
  // instant the playhead reaches it. An animation cannot drift off its keyframes
  // by choosing a slow spring.
  const t = track("email", "x", [
    frame(0, 0, { type: "spring", stiffness: 100, damping: 60, mass: 1 }),
    frame(400, 100),
    frame(900, 250),
  ]);
  assert.equal(sampleTrack(t, 400), 100);
});

test("scrubbing backwards reads the same numbers as scrubbing forwards", () => {
  // Closed form, not integration. A stepped spring simulation would give a
  // different answer depending on which way the playhead arrived, and dragging
  // back and forth over one keyframe would make the canvas drift.
  const spring: EasingCurve = { type: "spring", stiffness: 170, damping: 26, mass: 1 };
  const forwards = Array.from({ length: 51 }, (_, i) => easedProgress(spring, i / 50, 600));
  const backwards = Array.from({ length: 51 }, (_, i) => easedProgress(spring, (50 - i) / 50, 600)).reverse();
  assert.deepEqual(forwards, backwards);
});

// ---------------------------------------------------------------------------
// Sampling a track
// ---------------------------------------------------------------------------

test("an empty track has no value, which is not the same as zero", () => {
  assert.equal(sampleTrack(track("email", "opacity", []), 0), null);
});

test("a track holds its end values outside its keyframes", () => {
  const t = track("email", "x", [frame(200, 10), frame(800, 90)]);
  assert.equal(sampleTrack(t, 0), 10);
  assert.equal(sampleTrack(t, 200), 10);
  assert.equal(sampleTrack(t, 800), 90);
  assert.equal(sampleTrack(t, 5000), 90, "extrapolating past the last keyframe would fly off the canvas");
});

test("a linear segment interpolates on the segment, not on the animation", () => {
  const t = track("email", "x", [frame(200, 10), frame(700, 110)]);
  assert.equal(sampleTrack(t, 450), 60);
});

test("keyframes are sampled in time order however they were stored", () => {
  // Dragging a keyframe past its neighbour is the ordinary way to unsort the
  // array, and the operation stores whatever order it was handed.
  const t = track("email", "x", [frame(700, 110), frame(200, 10)]);
  assert.equal(sampleTrack(t, 450), 60);
  assert.deepEqual(
    sortedKeyframes(t.keyframes).map((k) => k.time),
    [200, 700]
  );
});

test("two keyframes at the same instant are a step, not a division by zero", () => {
  const t = track("email", "opacity", [frame(0, 0), frame(500, 0), frame(500, 1), frame(900, 1)]);
  assert.equal(sampleTrack(t, 499), 0);
  assert.equal(sampleTrack(t, 500), 1);
  assert.ok(Number.isFinite(sampleTrack(t, 500) as number));
});

test("a segment between a number and a colour holds rather than blending nonsense", () => {
  // The schema types a keyframe value as `number | Rgba` whatever the track's
  // property is, so the sampler has to have an answer for the mismatch.
  const t = track("email", "opacity", [frame(0, 0.5), frame(400, { r: 1, g: 0, b: 0, a: 1 })]);
  assert.equal(sampleTrack(t, 200), 0.5);
});

test("colour channels stay in gamut even when the easing overshoots", () => {
  const white: Rgba = { r: 1, g: 1, b: 1, a: 1 };
  const black: Rgba = { r: 0, g: 0, b: 0, a: 1 };
  const mixed = mixValues(black, white, 1.4) as Rgba;
  assert.deepEqual(mixed, { r: 1, g: 1, b: 1, a: 1 });
});

test("a spring-eased colour segment still lands on the target colour", () => {
  const t = track("button", "fillColor", [
    frame(0, { r: 0, g: 0, b: 0, a: 1 }, { type: "spring", stiffness: 200, damping: 20, mass: 1 }),
    frame(600, { r: 1, g: 0, b: 0, a: 1 }),
  ]);
  assert.deepEqual(sampleTrack(t, 600), { r: 1, g: 0, b: 0, a: 1 });
});

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

test("the property table names a colour property exactly when it holds a colour", () => {
  for (const info of ANIMATABLE_PROPERTIES) {
    assert.equal(isColorProperty(info.property), info.color);
    const seeded = readNodeProperty(signInDocument().nodes["button"], info.property);
    if (seeded === null) continue;
    assert.equal(typeof seeded === "object", info.color, `${info.property} must seed the type it animates`);
  }
});

test("a new keyframe is seeded from the layer, not from zero", () => {
  const doc = signInDocument();
  assert.equal(readNodeProperty(doc.nodes["card"], "cornerRadius"), 16);
  assert.equal(readNodeProperty(doc.nodes["email"], "height"), 44);
  assert.equal(readNodeProperty(doc.nodes["email"], "scale"), 1, "scale has no field, so its rest value is 1");
  assert.deepEqual(readNodeProperty(doc.nodes["button"], "fillColor"), { r: 0.2, g: 0.3, b: 0.9, a: 1 });
});

test("a property that cannot act on a layer says so instead of pretending", () => {
  const doc = signInDocument();
  assert.equal(propertyApplies(doc.nodes["title"], "fontSize"), true);
  assert.equal(propertyApplies(doc.nodes["email"], "fontSize"), false, "a rectangle has no typography");
  assert.equal(propertyApplies(doc.nodes["email"], "strokeColor"), false, "nothing to tint without a stroke");
  assert.equal(readNodeProperty(doc.nodes["email"], "fontSize"), null);
});

// ---------------------------------------------------------------------------
// The preview document
// ---------------------------------------------------------------------------

test("a scrub never touches the document it was given", () => {
  const doc = signInDocument();
  const before = JSON.stringify(doc);
  const preview = derivePreviewDocument(doc, animation([track("email", "x", [frame(0, 0), frame(1000, 200)])]), 500);
  assert.equal(JSON.stringify(doc), before, "the committed scene is the one thing a playhead may not write to");
  assert.equal(preview.nodes["email"].x, 100);
  assert.notEqual(preview.nodes["email"], doc.nodes["email"]);
  assert.equal(preview.nodes["card"], doc.nodes["card"], "layers no track names are shared, not copied");
});

test("a scrub over an animation with nothing to say hands back the same document", () => {
  const doc = signInDocument();
  assert.equal(derivePreviewDocument(doc, animation([]), 250), doc);
  assert.equal(derivePreviewDocument(doc, animation([track("gone", "x", [frame(0, 5)])]), 250), doc);
});

test("opacity is clamped, because a spring will ask for 1.08", () => {
  const doc = signInDocument();
  const bounce = animation([
    track("email", "opacity", [frame(0, 0, { type: "spring", stiffness: 200, damping: 8, mass: 1 }), frame(1000, 1)]),
  ]);
  for (let t = 0; t <= 1000; t += 10) {
    const value = derivePreviewDocument(doc, bounce, t).nodes["email"].opacity;
    assert.ok(value >= 0 && value <= 1, `opacity ${value} at ${t}ms is outside what a document may hold`);
  }
});

test("scale grows a layer about its centre", () => {
  const doc = signInDocument();
  const node = doc.nodes["email"];
  const preview = derivePreviewDocument(doc, animation([track("email", "scale", [frame(0, 2)])]), 0).nodes["email"];
  assert.equal(preview.width, node.width * 2);
  assert.equal(preview.height, node.height * 2);
  assert.equal(preview.x + preview.width / 2, node.x + node.width / 2);
  assert.equal(preview.y + preview.height / 2, node.y + node.height / 2);
});

test("a size tween pins the sizing mode so a filled layer actually moves", () => {
  const doc = signInDocument();
  assert.equal(doc.nodes["email"].widthMode, "fill", "the fixture's field fills its card");
  const preview = derivePreviewDocument(doc, animation([track("email", "width", [frame(0, 100)])]), 0).nodes["email"];
  assert.equal(preview.width, 100);
  assert.equal(preview.widthMode, "fixed", "a fill-sized layer ignores its own width, and the tween would draw nothing");
  assert.equal(doc.nodes["email"].widthMode, "fill", "and the stored layer keeps what it was authored with");
});

test("a colour tween lands on the fill the renderer draws", () => {
  const doc = signInDocument();
  const preview = derivePreviewDocument(
    doc,
    animation([
      track("button", "fillColor", [frame(0, { r: 0, g: 0, b: 0, a: 1 }), frame(1000, { r: 1, g: 1, b: 1, a: 1 })]),
    ]),
    500
  );
  const paint = preview.nodes["button"].fills[0];
  assert.equal(paint.type, "solid");
  assert.deepEqual(paint.type === "solid" ? paint.color : null, { r: 0.5, g: 0.5, b: 0.5, a: 1 });
  assert.ok(renderPageSvg(preview, PAGE_ID).svg.includes("rgba(128, 128, 128, 1)"), "and the one renderer draws it");
});

test("a tween with nothing to land on leaves the layer alone", () => {
  const doc = signInDocument();
  const stroked = derivePreviewDocument(doc, animation([track("email", "strokeColor", [frame(0, { r: 1, g: 0, b: 0, a: 1 })])]), 0);
  assert.equal(stroked.nodes["email"].strokes.length, 0, "a stroke colour must not conjure a stroke");
  const sized = derivePreviewDocument(doc, animation([track("email", "fontSize", [frame(0, 40)])]), 0);
  assert.equal(sized.nodes["email"], doc.nodes["email"]);
});

test("the preview is a document the renderer and the schema both accept", () => {
  const doc = signInDocument();
  const preview = derivePreviewDocument(
    doc,
    animation([
      track("email", "x", [frame(0, 0), frame(1000, 120)]),
      track("email", "opacity", [frame(0, 1), frame(1000, 0.25)]),
      track("card", "cornerRadius", [frame(0, 16), frame(1000, 0)]),
    ]),
    600
  );
  assert.ok(renderPageSvg(preview, PAGE_ID).svg.startsWith("<svg"));
  assert.equal(preview.revision, doc.revision, "a scrub is not a revision");
});

test("the playhead runs to the last keyframe even when it was dragged past the duration", () => {
  const long = animation([track("email", "x", [frame(0, 0), frame(2500, 40)])], { durationMs: 1000 });
  assert.equal(animationSpanMs(long), 2500);
  assert.equal(animationSpanMs(animation([track("email", "x", [frame(0, 0)])])), 1000);
});

// ---------------------------------------------------------------------------
// Authoring through the operation layer
// ---------------------------------------------------------------------------

test("replacing an animation through createAnimation is invertible", () => {
  // The timeline edits a name, a duration, the loop flag and a removed track by
  // writing the whole animation back under its own id — there is no narrower
  // operation, and this is the property that makes that safe.
  const doc = signInDocument();
  const original = animation([track("email", "opacity", [frame(0, 0), frame(1000, 1)])]);
  const created = run(doc, [{ op: "createAnimation", animation: original }]);

  const renamed = { ...original, name: "Fade out", durationMs: 400, loop: true, tracks: [] };
  const operations = [{ op: "createAnimation" as const, animation: renamed }];
  const applied = applyTransaction(created.document, transaction(operations, { baseRevision: created.document.revision }));
  assert.equal(applied.document.animations["anim1"].name, "Fade out");
  assert.deepEqual(applied.document.animations["anim1"].tracks, []);

  const undone = applyTransaction(
    applied.document,
    invertTransaction(applied, transaction(operations, { baseRevision: created.document.revision }), "2026-01-01T00:00:02.000Z")
  );
  assert.deepEqual(undone.document.animations["anim1"], original, "undo has to hand the whole animation back");
});

test("keyframe edits go through setKeyframes and come back", () => {
  const doc = signInDocument();
  const created = run(doc, [{ op: "createAnimation", animation: animation([]) }]);
  const first = track("email", "opacity", [frame(0, 0), frame(1000, 1)]);
  const withTrack = run(created.document, [{ op: "setKeyframes", animationId: "anim1", track: first }]);
  assert.equal(withTrack.document.animations["anim1"].tracks.length, 1);

  const moved = { ...first, keyframes: [frame(0, 0), frame(600, 1)] };
  const operations = [{ op: "setKeyframes" as const, animationId: "anim1", track: moved }];
  const applied = applyTransaction(withTrack.document, transaction(operations, { baseRevision: withTrack.document.revision }));
  assert.equal(sampleTrack(applied.document.animations["anim1"].tracks[0], 300), 0.5);

  const undone = applyTransaction(
    applied.document,
    invertTransaction(applied, transaction(operations, { baseRevision: withTrack.document.revision }), "2026-01-01T00:00:02.000Z")
  );
  assert.deepEqual(undone.document.animations["anim1"].tracks[0], first);
});

test("an interaction that plays an animation survives the round trip", () => {
  const doc = signInDocument();
  const created = run(doc, [
    { op: "createAnimation", animation: animation([track("button", "scale", [frame(0, 1), frame(200, 0.96)])]) },
    {
      op: "createInteraction",
      interaction: {
        id: "int1",
        sourceNodeId: "button",
        trigger: { type: "press" },
        action: { type: "play-animation", animationId: "anim1", reverse: false },
        transition: { kind: "instant", durationMs: 200, delayMs: 0, easing: { type: "ease-out" }, matchStableIds: true },
      },
    },
  ]);
  assert.equal(created.document.interactions["int1"].action.type, "play-animation");

  // Deleting the animation must take the interaction that played it with it —
  // an interaction pointing at nothing is a prototype that fails silently.
  const removed = run(created.document, [{ op: "deleteAnimation", animationId: "anim1" }]);
  assert.equal(removed.document.interactions["int1"], undefined);
});

/**
 * `applyMotionValue` wrote the new size onto the scaled node alone, so a scale
 * track on a card grew the card and left its children at full size in their
 * original places — the commonest UI motion there is, drawn wrong.
 */
test("scaling a container scales what is inside it", () => {
  const doc = signInDocument();
  const card = doc.nodes["card"];
  const title = doc.nodes["title"];
  assert.ok(card && title, "the fixture has a card with a title inside it");

  const preview = derivePreviewDocument(
    doc,
    animation([track("card", "scale", [frame(0, 1), frame(1000, 2)])]),
    1000
  );

  assert.equal(preview.nodes["card"].width, card.width * 2, "the container takes the factor");
  assert.equal(preview.nodes["title"].width, title.width * 2, "and so does its child");
  assert.equal(preview.nodes["title"].height, title.height * 2);
  // Child coordinates are parent-relative, so the offset scales by the same factor.
  assert.equal(preview.nodes["title"].x, title.x * 2);
  assert.equal(preview.nodes["title"].y, title.y * 2);
  // Type scales with its box, as it does when you scale a frame in Figma.
  const previewTitle = preview.nodes["title"];
  if (previewTitle.type === "text" && title.type === "text") {
    assert.equal(previewTitle.typography.fontSize, title.typography.fontSize * 2);
  }
  assert.equal(JSON.stringify(doc.nodes["title"]), JSON.stringify(title), "and the committed scene is untouched");
});
