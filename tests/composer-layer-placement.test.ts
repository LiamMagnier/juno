import test from "node:test";
import assert from "node:assert/strict";
import { placeComposerLayer, preferredLayerSide, type LayerPlacement, type PlacementRect } from "@/lib/chat/composer-layer-placement";

/*
 * Where a layer the composer opens goes (src/lib/chat/composer-layer-placement.ts).
 * Critique 1: "popovers never cover the draft". INTERACTION_SPEC C7, C10, MP1:
 * every layer opens outside the composer's box, below it on the home, above it
 * in the dock, and flips only when its side has neither the room nor the
 * larger share. The invariant every case below ends on: the layer and the
 * composer never overlap.
 */

function overlaps(layer: LayerPlacement, viewportHeight: number, composer: PlacementRect): boolean {
  const top = layer.side === "below" ? layer.top! : viewportHeight - layer.bottom! - layer.maxHeight;
  const bottom = layer.side === "below" ? layer.top! + layer.maxHeight : viewportHeight - layer.bottom!;
  const vertical = top < composer.bottom && bottom > composer.top;
  const horizontal = layer.left < composer.right && layer.left + layer.width > composer.left;
  return vertical && horizontal;
}

// The home at 1440 x 900: a 720 px composer centred under the greeting.
const HOME_1440: PlacementRect = { top: 357, bottom: 481, left: 485, right: 1207 };
// The dock at 1440 x 900: the composer near the panel's bottom edge.
const DOCK_1440: PlacementRect = { top: 744, bottom: 852, left: 548, right: 1268 };
// A phone, 390 x 844, home and dock.
const HOME_390: PlacementRect = { top: 292, bottom: 408, left: 16, right: 374 };
const DOCK_390: PlacementRect = { top: 700, bottom: 806, left: 16, right: 374 };

test("the home opens layers below and the dock above", () => {
  assert.equal(preferredLayerSide("landing"), "below");
  assert.equal(preferredLayerSide("dock"), "above");
  assert.equal(preferredLayerSide("inline"), "above");
});

test("1440 home: the @ palette opens below the composer at the caret and never over it", () => {
  const layer = placeComposerLayer({
    composer: HOME_1440,
    viewport: { width: 1440, height: 900 },
    anchorX: 620,
    inset: 20,
    width: 372,
    need: 320,
    prefer: "below",
  });
  assert.equal(layer.side, "below");
  assert.equal(layer.top, HOME_1440.bottom + 8);
  assert.equal(layer.left, 600);
  assert.ok(layer.maxHeight >= 320);
  assert.equal(overlaps(layer, 900, HOME_1440), false);
});

test("1440 dock: the model popover opens above, its end edge at the control", () => {
  const layer = placeComposerLayer({
    composer: DOCK_1440,
    viewport: { width: 1440, height: 900 },
    anchorX: 1176,
    align: "end",
    width: 344,
    need: 400,
    prefer: "above",
  });
  assert.equal(layer.side, "above");
  assert.equal(layer.left + layer.width, 1176);
  assert.equal(layer.bottom, 900 - DOCK_1440.top + 8);
  assert.equal(overlaps(layer, 900, DOCK_1440), false);
});

test("a short window caps the height to the room instead of covering the draft", () => {
  const composer: PlacementRect = { top: 300, bottom: 420, left: 100, right: 820 };
  const layer = placeComposerLayer({
    composer,
    viewport: { width: 1000, height: 560 },
    anchorX: 140,
    width: 300,
    need: 400,
    prefer: "below",
  });
  // Below has 120 px, above has 280: the layer flips to the side with more room and scrolls inside it.
  assert.equal(layer.side, "above");
  assert.ok(layer.maxHeight <= 300 - 12 - 8);
  assert.equal(overlaps(layer, 560, composer), false);
});

test("390: every layer is narrowed to the phone and kept off both edges", () => {
  for (const composer of [HOME_390, DOCK_390]) {
    const prefer = composer === HOME_390 ? "below" : "above";
    for (const [anchorX, align, width] of [
      [40, "start", 372],
      [300, "end", 344],
      [180, "start", 360],
    ] as const) {
      const layer = placeComposerLayer({ composer, viewport: { width: 390, height: 844 }, anchorX, align, width, need: 300, prefer });
      assert.ok(layer.left >= 12, `left ${layer.left}`);
      assert.ok(layer.left + layer.width <= 390 - 12, `right ${layer.left + layer.width}`);
      assert.equal(overlaps(layer, 844, composer), false);
    }
  }
});

test("placement is whole-pixel and grows out of its anchor", () => {
  const layer = placeComposerLayer({
    composer: { top: 357.4, bottom: 480.6, left: 485.5, right: 1206.5 },
    viewport: { width: 1440, height: 900 },
    anchorX: 640.3,
    width: 280.5,
    need: 240,
    prefer: "below",
  });
  for (const value of [layer.left, layer.width, layer.top!, layer.maxHeight]) assert.equal(value, Math.round(value));
  assert.match(layer.origin, /^\d+px 0px$/);
});
