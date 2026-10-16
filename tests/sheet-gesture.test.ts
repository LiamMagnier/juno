import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISMISS_FRACTION,
  EDGE_ZONE_PX,
  INTENT_SLOP_PX,
  dragOffset,
  gestureIntent,
  keyboardInset,
  pushSample,
  rubberBand,
  settleMs,
  shouldDismiss,
  shouldOpen,
  startsAtEdge,
  velocityOf,
} from "@/lib/sheet-gesture";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = (file: string) => readFileSync(path.join(root, file), "utf8");

// ——— The arithmetic (lib/sheet-gesture.ts) ———————————————————————————————

test("a touch says nothing until it passes the slop", () => {
  assert.equal(gestureIntent(INTENT_SLOP_PX - 1, 2, "y", 1), null);
  assert.equal(gestureIntent(0, 0, "x", 1), null);
});

test("a bottom sheet drags down, not up and not sideways", () => {
  assert.equal(gestureIntent(1, 30, "y", 1), "drag");
  assert.equal(gestureIntent(1, -30, "y", 1), "ignore");
  // Mostly sideways: a carousel or a horizontal scroll, never the sheet.
  assert.equal(gestureIntent(30, 20, "y", 1), "ignore");
});

test("a left drawer drags left to close; an edge pull drags right to open", () => {
  assert.equal(gestureIntent(-30, 4, "x", -1), "drag");
  assert.equal(gestureIntent(30, 4, "x", -1), "ignore");
  assert.equal(gestureIntent(30, 4, "x", 1), "drag");
});

test("pulling the wrong way gives a little and then resists", () => {
  assert.equal(rubberBand(0), 0);
  const small = Math.abs(rubberBand(-20));
  const large = Math.abs(rubberBand(-400));
  assert.ok(small > 0 && small < 20, "it gives, less than the finger");
  assert.ok(large < 64, "it never passes its limit");
  assert.ok(large > small, "it keeps giving, slower and slower");
  assert.equal(dragOffset(120), 120, "toward dismissal it follows the finger 1:1");
  assert.ok(dragOffset(-40) < 0 && dragOffset(-40) > -40);
});

test("velocity is read over the last stretch, so a pause then a flick reads as a flick", () => {
  let samples = [{ at: 0, t: 0 }];
  // A slow drag of 40px over 400ms…
  for (let t = 20; t <= 400; t += 20) samples = pushSample(samples, { at: t / 10, t });
  // …then a quick 60px flick in 60ms.
  for (let t = 420; t <= 460; t += 20) samples = pushSample(samples, { at: 40 + (t - 400), t });
  const v = velocityOf(samples);
  assert.ok(v > 0.5, `expected a flick, got ${v.toFixed(2)} px/ms`);
  assert.equal(velocityOf([]), 0);
  assert.equal(velocityOf([{ at: 3, t: 5 }]), 0);
});

test("a flick dismisses from a short pull; a slow drag must pass the fraction", () => {
  const size = 400;
  assert.equal(shouldDismiss({ offset: 30, size, velocity: 0.9 }), true, "flick");
  assert.equal(shouldDismiss({ offset: 30, size, velocity: 0.1 }), false, "short and slow");
  assert.equal(shouldDismiss({ offset: size * DISMISS_FRACTION, size, velocity: 0 }), true, "far enough");
  assert.equal(shouldDismiss({ offset: 0, size, velocity: 2 }), false, "never moved");
  assert.equal(shouldDismiss({ offset: -20, size, velocity: 0 }), false, "pulled the wrong way");
});

test("a flick back toward rest keeps the sheet, however far it was pulled", () => {
  assert.equal(shouldDismiss({ offset: 300, size: 400, velocity: -0.4 }), false);
});

test("an edge pull opens past 40% or on a flick, and a flick back cancels it", () => {
  assert.equal(shouldOpen({ progress: 0.5, velocity: 0 }), true);
  assert.equal(shouldOpen({ progress: 0.2, velocity: 0 }), false);
  assert.equal(shouldOpen({ progress: 0.15, velocity: 0.6 }), true);
  assert.equal(shouldOpen({ progress: 0.9, velocity: -0.6 }), false);
});

test("the settle finishes at the release speed, clamped so it never crawls or snaps", () => {
  assert.equal(settleMs(200, 0), 300, "no speed: the slow end of the clamp");
  assert.equal(settleMs(200, 1), 200);
  assert.equal(settleMs(10, 5), 140, "a fast short throw still reads as motion");
  assert.equal(settleMs(2000, 1, { min: 160, max: 260 }), 260);
});

test("only the strip along the edge starts the drawer", () => {
  assert.equal(startsAtEdge(EDGE_ZONE_PX, 390, "left"), true);
  assert.equal(startsAtEdge(EDGE_ZONE_PX + 1, 390, "left"), false);
  assert.equal(startsAtEdge(380, 390, "right"), true);
  assert.equal(startsAtEdge(300, 390, "right"), false);
});

test("a bottom sheet rises by what the keyboard covers, and not for a toolbar or a zoom", () => {
  // iPhone portrait: 844 layout, the keyboard leaves 508 of visual viewport.
  assert.equal(keyboardInset({ layoutHeight: 844, viewportHeight: 508, viewportTop: 0 }), 336);
  // Safari panned the visual viewport to reveal the field: the sheet follows the visible bottom.
  assert.equal(keyboardInset({ layoutHeight: 844, viewportHeight: 508, viewportTop: 100 }), 236);
  // A toolbar settling, not a keyboard.
  assert.equal(keyboardInset({ layoutHeight: 844, viewportHeight: 800, viewportTop: 0 }), 0);
  // A pinch zoom shrinks the visual viewport too; the sheet stays where it is.
  assert.equal(keyboardInset({ layoutHeight: 844, viewportHeight: 400, viewportTop: 200, scale: 2 }), 0);
});

// ——— The wiring (source checks: these are DOM components) ————————————————

test("the viewport is edge to edge, so the safe-area paddings take effect", () => {
  assert.match(source("src/app/layout.tsx"), /viewportFit:\s*"cover"/);
});

test("every dialog is a bottom sheet on a phone unless it opts out, and the opt-outs are deliberate", () => {
  const dialog = source("src/components/ui/dialog.tsx");
  assert.match(dialog, /sheet = true/, "on by default");
  assert.match(dialog, /data-phone-sheet=\{sheet \? "" : undefined\}/);
  assert.match(dialog, /useSwipeDismiss\(/, "thrown down to dismiss");
  const css = source("src/components/ui/sheet.css");
  assert.match(css, /@media \(max-width: 639\.98px\)[\s\S]*\.ui-dialog\.ui-dialog\[data-phone-sheet\]/);
  assert.match(css, /--sheet-keyboard/, "rides above the keyboard");
  // The three that own the whole phone screen or sit under the keyboard.
  for (const file of [
    "src/components/settings/settings-modal.tsx",
    "src/components/research/report-fullscreen.tsx",
    "src/components/app/command-palette.tsx",
  ]) {
    assert.match(source(file), /sheet=\{false\}/, file);
  }
});

test("the sheet motion keeps a fade and drops its travel under reduced motion", () => {
  const css = source("src/components/ui/sheet.css");
  for (const name of ["ui-sheet-rise", "ui-sheet-sink"]) {
    const frame = css.match(new RegExp(`@keyframes ${name} \\{[\\s\\S]*?\\n\\}`))?.[0] ?? "";
    assert.match(frame, /var\(--motion-shift, 1\)/, `${name} multiplies its travel by --motion-shift`);
  }
});

test("the phone drawer opens from an edge pull and the Code v2 sheet uses the shared gesture", () => {
  const shell = source("src/components/app/app-shell.tsx");
  assert.match(shell, /useEdgeSwipeOpen\(/);
  assert.match(shell, /<SheetContent[^>]*edgeSwipe/);
  const primitives = source("src/components/code/v2/primitives.tsx");
  assert.match(primitives, /useSwipeDismiss\(/);
  assert.doesNotMatch(primitives, /onPointerMove=\{onPointerMove\}/, "the old one-off drag is gone");
});

test("small touch targets reach 44px without moving their neighbours", () => {
  const tailwind = source("tailwind.config.ts");
  assert.match(tailwind, /"\.hit-44"[\s\S]*pointer: coarse[\s\S]*2\.75rem/);
  assert.match(source("src/components/ui/button.tsx"), /"icon-sm": "[^"]*hit-44/);
  const pressable = source("src/components/ui/pressable.tsx");
  assert.match(pressable, /size: "sm", class: "[^"]*hit-44/);
  assert.match(pressable, /size: "md", class: "[^"]*hit-44/);
  assert.match(source("src/components/code/v2/code-v2.css"), /\.cv2-nav-tick::before/);
});
