/**
 * Motion, in a file that runs.
 *
 * Animation reached no export target at all. `exportReact` and `exportSwiftUI`
 * pushed a note saying the animations were "described in the handoff bundle",
 * and `exportHtmlPrototype` — the one target that actually executes — emitted no
 * keyframes whatsoever, so the timeline inside the editor was the only place in
 * the entire product where a keyframe could be seen moving. Nothing about that
 * failed: every export succeeded, and the motion was simply absent from all of
 * them.
 *
 * These check the translation itself, because CSS agrees with this model on
 * most points and differs on a few, and the differences are where fidelity gets
 * lost silently:
 *
 *  - a keyframe's easing governs the segment that STARTS at it, which is a
 *    per-stop `animation-timing-function`, and the last keyframe governs nothing;
 *  - a track that starts late or ends early HOLDS its end values, where CSS
 *    would otherwise tween from the element's static style;
 *  - `rotation` and `scale` are one CSS property, and a spring is not a CSS
 *    timing function at all — both are reported rather than approximated
 *    quietly.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { exportHtmlPrototype } from "../src/lib/design/export";
import { PAGE_ID, run, signInDocument } from "./design-fixtures";
import type { DesignDocument, EasingCurve, MotionAnimation } from "../src/lib/design/types";

const linear: EasingCurve = { type: "linear" };

function animated(animation: MotionAnimation, extra: Parameters<typeof run>[1] = []): DesignDocument {
  return run(signInDocument(), [{ op: "createAnimation", animation }, ...extra]).document;
}

/** A fade on the button, with nothing else in the document. */
function fade(overrides: Partial<MotionAnimation> = {}): MotionAnimation {
  return {
    id: "anim1",
    name: "Fade in",
    durationMs: 400,
    loop: false,
    tracks: [
      {
        nodeId: "button",
        property: "opacity",
        keyframes: [
          { time: 0, value: 0, easing: { type: "ease-out" } },
          { time: 400, value: 1, easing: linear },
        ],
      },
    ],
    ...overrides,
  };
}

test("the HTML prototype emits real keyframes and binds them to the animated layer", () => {
  const result = exportHtmlPrototype(animated(fade()), PAGE_ID);

  assert.match(result.content, /@keyframes juno-k0 \{/, "the animation became a keyframes rule");
  assert.match(result.content, /0% \{ opacity: 0;/);
  assert.match(result.content, /100% \{ opacity: 1;/);

  // And the element carries the shorthand, so it actually runs.
  assert.match(result.content, /animation-name: juno-k0;/);
  assert.match(result.content, /animation-duration: 400ms;/);
  assert.match(result.content, /animation-iteration-count: 1;/);
  assert.match(result.content, /class="juno-a0"/);

  // Still standalone and still inert — the whole point of this export.
  assert.ok(!/src="https?:/.test(result.content), "no remote resources");
  assert.ok(!result.content.includes("eval("), "nothing evaluates");
});

test("a keyframe's easing becomes the stop's timing function, and the last one claims nothing", () => {
  const result = exportHtmlPrototype(
    animated(
      fade({
        tracks: [
          {
            nodeId: "button",
            property: "opacity",
            keyframes: [
              { time: 0, value: 0, easing: { type: "ease-in-out" } },
              { time: 200, value: 0.5, easing: { type: "cubic-bezier", x1: 0.2, y1: 0, x2: 0.4, y2: 1 } },
              { time: 400, value: 1, easing: { type: "ease-in" } },
            ],
          },
        ],
      })
    ),
    PAGE_ID
  );

  assert.match(result.content, /0% \{ opacity: 0; animation-timing-function: ease-in-out; \}/);
  assert.match(result.content, /50% \{ opacity: 0.5; animation-timing-function: cubic-bezier\(0.2, 0, 0.4, 1\); \}/);
  // There is no segment after the last keyframe; declaring its easing there
  // would apply the curve to whatever the animation does next.
  assert.match(result.content, /100% \{ opacity: 1; \}/);
  assert.ok(!/100% \{ opacity: 1; animation-timing-function/.test(result.content));

  // The shorthand stays linear so it cannot compose with the per-stop curves.
  assert.match(result.content, /animation-timing-function: linear;/);
});

test("a track that starts late or ends early holds its end values", () => {
  const result = exportHtmlPrototype(
    animated(
      fade({
        durationMs: 800,
        tracks: [
          {
            nodeId: "button",
            property: "opacity",
            keyframes: [
              { time: 200, value: 0.25, easing: linear },
              { time: 600, value: 1, easing: linear },
            ],
          },
        ],
      })
    ),
    PAGE_ID
  );

  // Without these two synthesised stops CSS tweens from the element's own
  // computed opacity, so a fade authored to begin at 200ms starts at 0.
  assert.match(result.content, /0% \{ opacity: 0.25; \}/);
  assert.match(result.content, /25% \{ opacity: 0.25;/);
  assert.match(result.content, /75% \{ opacity: 1;/);
  assert.match(result.content, /100% \{ opacity: 1; \}/);
});

test("each animatable property lands on the CSS property that expresses it", () => {
  const doc = animated({
    id: "anim1",
    name: "Everything",
    durationMs: 100,
    loop: false,
    tracks: [
      { nodeId: "button", property: "x", keyframes: [{ time: 0, value: 0, easing: linear }, { time: 100, value: 40, easing: linear }] },
      { nodeId: "button", property: "y", keyframes: [{ time: 0, value: 0, easing: linear }, { time: 100, value: 10, easing: linear }] },
      { nodeId: "button", property: "width", keyframes: [{ time: 0, value: 279, easing: linear }, { time: 100, value: 300, easing: linear }] },
      { nodeId: "button", property: "cornerRadius", keyframes: [{ time: 0, value: 8, easing: linear }, { time: 100, value: 24, easing: linear }] },
      {
        nodeId: "button",
        property: "fillColor",
        keyframes: [
          { time: 0, value: { r: 1, g: 0, b: 0, a: 1 }, easing: linear },
          { time: 100, value: { r: 0, g: 0, b: 1, a: 1 }, easing: linear },
        ],
      },
      { nodeId: "buttonLabel", property: "fontSize", keyframes: [{ time: 0, value: 16, easing: linear }, { time: 100, value: 20, easing: linear }] },
      {
        nodeId: "buttonLabel",
        property: "fillColor",
        keyframes: [
          { time: 0, value: { r: 0, g: 0, b: 0, a: 1 }, easing: linear },
          { time: 100, value: { r: 1, g: 1, b: 1, a: 1 }, easing: linear },
        ],
      },
    ],
  });
  const content = exportHtmlPrototype(doc, PAGE_ID).content;

  // Nodes are absolutely positioned, so x and y are `left` and `top` — not a
  // transform, which would collide with rotation and scale.
  assert.match(content, /left: \d/);
  assert.match(content, /top: \d/);
  assert.match(content, /width: 300px/);
  assert.match(content, /border-radius: 24px/);
  // A shape's fill is its background; a text layer's fill is its glyph colour,
  // exactly as the static CSS decides.
  assert.match(content, /background-color: rgba\(255, 0, 0, 1\)/);
  assert.match(content, /color: rgba\(255, 255, 255, 1\)/);
  assert.match(content, /font-size: 20px/);
});

test("a hover animation waits for a hover instead of running on load", () => {
  const result = exportHtmlPrototype(animated(fade({ state: "hover" })), PAGE_ID);
  assert.match(result.content, /animation-play-state: paused;/);
  assert.match(result.content, /\.juno-a0:hover \{ animation-play-state: running; \}/);

  // An animation nothing triggers has to run, or the file never shows it.
  const onLoad = exportHtmlPrototype(animated(fade()), PAGE_ID);
  assert.match(onLoad.content, /animation-play-state: running;/);
});

test("a play-animation interaction is represented rather than reported unsupported", () => {
  const doc = animated(fade(), [
    {
      op: "createInteraction",
      interaction: {
        id: "i1",
        sourceNodeId: "buttonLabel",
        trigger: { type: "click" },
        action: { type: "play-animation", animationId: "anim1", reverse: true },
        transition: { kind: "instant", durationMs: 0, delayMs: 0, easing: linear, matchStableIds: false },
      },
    },
  ]);
  const result = exportHtmlPrototype(doc, PAGE_ID);

  assert.match(result.content, /data-play-animation="a0"/);
  assert.match(result.content, /data-play-reverse="1"/);
  assert.match(result.content, /data-juno-animation="a0"/);
  // Something has to start it, so it waits rather than running on load.
  assert.match(result.content, /animation-play-state: paused;/);
  // The runtime binds it alongside the navigation links.
  assert.match(result.content, /\[data-play-animation\]'\)/);
  assert.ok(
    !result.unsupported.some((line) => /play-animation interaction not represented/.test(line)),
    "this action used to be dropped on the floor"
  );
});

test("a spring and a shared transform are reported, not silently approximated", () => {
  const spring = exportHtmlPrototype(
    animated(
      fade({
        tracks: [
          {
            nodeId: "button",
            property: "scale",
            keyframes: [
              { time: 0, value: 1, easing: { type: "spring", stiffness: 320, damping: 22, mass: 1 } },
              { time: 400, value: 1.05, easing: linear },
            ],
          },
        ],
      })
    ),
    PAGE_ID
  );
  assert.match(spring.content, /transform: scale\(1\)/);
  assert.ok(spring.unsupported.some((line) => /spring has no CSS timing function/.test(line)));

  // Rotation and scale are one `transform`; keyframed at different instants,
  // one of them has to be filled in.
  const shared = exportHtmlPrototype(
    animated(
      fade({
        tracks: [
          { nodeId: "button", property: "rotation", keyframes: [{ time: 0, value: 0, easing: linear }, { time: 400, value: 12, easing: linear }] },
          {
            nodeId: "button",
            property: "scale",
            keyframes: [
              { time: 0, value: 1, easing: linear },
              { time: 200, value: 1.2, easing: linear },
              { time: 400, value: 1, easing: linear },
            ],
          },
        ],
      })
    ),
    PAGE_ID
  );
  assert.match(shared.content, /transform: rotate\(6deg\) scale\(1.2\)/, "the missing rotation is filled in at the shared stop");
  assert.ok(shared.unsupported.some((line) => /one CSS `transform`/.test(line)));
});

test("a rotation the document already carries survives an animation that only scales", () => {
  // `transform` replaces the static transform wholesale, so a layer rotated in
  // the document and only scaled by the animation used to spring upright the
  // instant the animation applied.
  const doc = run(signInDocument(), [
    { op: "updateNode", nodeId: "button", patch: { rotation: 15 } },
    {
      op: "createAnimation",
      animation: fade({
        tracks: [
          {
            nodeId: "button",
            property: "scale",
            keyframes: [{ time: 0, value: 1, easing: linear }, { time: 400, value: 1.1, easing: linear }],
          },
        ],
      }),
    },
  ]).document;

  assert.match(exportHtmlPrototype(doc, PAGE_ID).content, /transform: rotate\(15deg\) scale\(1\)/);
});

test("a single-keyframe track is a value, not motion, and produces no rule", () => {
  const result = exportHtmlPrototype(
    animated(
      fade({
        tracks: [{ nodeId: "button", property: "opacity", keyframes: [{ time: 0, value: 0.5, easing: linear }] }],
      })
    ),
    PAGE_ID
  );
  assert.ok(!result.content.includes("@keyframes"), "one keyframe cannot describe a change");
  assert.ok(!result.content.includes('data-juno-animation="'), "and no element claims to be animated");
});

test("a prototype with no animations carries no motion machinery at all", () => {
  const result = exportHtmlPrototype(signInDocument(), PAGE_ID);
  assert.ok(!result.content.includes("@keyframes"));
  assert.ok(!result.content.includes("prefers-reduced-motion"), "a guard for motion that does not exist is noise");
});

test("the reader's reduced-motion preference stops the animations the file still describes", () => {
  const result = exportHtmlPrototype(animated(fade()), PAGE_ID);
  assert.match(
    result.content,
    /@media \(prefers-reduced-motion: reduce\) \{ \[data-juno-animation\] \{ animation: none !important; \} \}/
  );
  // The keyframes stay: the document still says what the motion is.
  assert.match(result.content, /@keyframes juno-k0/);
});
