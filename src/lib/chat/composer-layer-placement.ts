/**
 * WHERE A TYPED LAYER OPENED FROM THE COMPOSER GOES: never over the words
 * being written.
 *
 * The layers typing opens (the "/" palette, the @ palette, a token's popover)
 * open OUTSIDE the composer's box, at the x of the caret or token that opened
 * them (docs/rework/INTERACTION_SPEC.md C7, C10), since they follow the
 * words as they are typed and must not hide them. The composer's MENUS (the
 * +, the model chip, the home tray, the generation row) do not use this: they
 * open at their own trigger, over the composer (owner, 2026-10-04;
 * src/components/chat/composer-menu.tsx, "Where they open"). For the typed
 * layers:
 *
 *   on the home   below the composer: the greeting stays whole above it, and
 *                 the suggestions under it are disposable (they step aside);
 *   in the dock   above the composer: the transcript is there, the panel's
 *                 edge is below.
 *
 * A layer flips to the other side only when its preferred side has neither
 * the room it asks for nor at least as much room as the other side, and its
 * height is capped to the room it actually has, so a short window scrolls the
 * layer instead of pushing it over the words being written.
 *
 * Pure: rectangles in, a placement out, in viewport (position: fixed)
 * coordinates. tests/composer-layer-placement.test.ts holds the 1440 and 390
 * cases and the one invariant that matters: the layer and the composer never
 * overlap.
 */

export interface PlacementRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export type LayerSide = "below" | "above";

export interface LayerPlacementInput {
  /** The composer surface, as getBoundingClientRect() reports it. */
  composer: PlacementRect;
  viewport: { width: number; height: number };
  /**
   * The part of the viewport a layer may use vertically, e.g. a frame's inset.
   * Defaults to the whole viewport.
   */
  bounds?: { top: number; bottom: number };
  /** The x the layer is anchored to: the caret or a token's left edge. */
  anchorX: number;
  /** Where the layer sits against `anchorX`: its start edge (the usual) or its end edge. */
  align?: "start" | "end";
  /** Pulls a start-aligned layer left of the anchor, so its row text lines up with the caret. */
  inset?: number;
  /** The width the layer wants; narrowed to the viewport less `sideMargin` each side. */
  width: number;
  /** The height the layer would like before it scrolls. */
  need: number;
  prefer: LayerSide;
  /** Space between the composer's edge and the layer. */
  gap?: number;
  /** Space kept clear at the top and bottom of `bounds`. */
  edgeMargin?: number;
  /** Space kept clear at the left and right of the viewport. */
  sideMargin?: number;
}

export interface LayerPlacement {
  side: LayerSide;
  /** Fixed-position left edge. */
  left: number;
  width: number;
  /** Set when `side` is below: the layer's top edge. */
  top?: number;
  /** Set when `side` is above: distance from the viewport's bottom to the layer's bottom edge. */
  bottom?: number;
  /** The tallest the layer may be on its side. */
  maxHeight: number;
  /** transform-origin, so the layer grows out of what opened it. */
  origin: string;
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export function placeComposerLayer(input: LayerPlacementInput): LayerPlacement {
  const {
    composer,
    viewport,
    anchorX,
    align = "start",
    inset = 0,
    need,
    prefer,
    gap = 8,
    edgeMargin = 12,
    sideMargin = 12,
  } = input;
  const bounds = input.bounds ?? { top: 0, bottom: viewport.height };
  const top = Math.max(bounds.top, 0);
  const bottom = Math.min(bounds.bottom, viewport.height);

  const roomAbove = Math.max(0, composer.top - top - edgeMargin - gap);
  const roomBelow = Math.max(0, bottom - composer.bottom - edgeMargin - gap);

  const side: LayerSide =
    prefer === "below"
      ? roomBelow >= need || roomBelow >= roomAbove
        ? "below"
        : "above"
      : roomAbove >= need || roomAbove >= roomBelow
        ? "above"
        : "below";

  const width = Math.max(0, Math.min(input.width, viewport.width - 2 * sideMargin));
  const wanted = align === "end" ? anchorX - width : anchorX - inset;
  const left = clamp(wanted, sideMargin, Math.max(sideMargin, viewport.width - sideMargin - width));
  const originX = clamp(anchorX - left, 0, width);

  return side === "below"
    ? {
        side,
        left: Math.round(left),
        width: Math.round(width),
        top: Math.round(composer.bottom + gap),
        maxHeight: Math.floor(roomBelow),
        origin: `${Math.round(originX)}px 0px`,
      }
    : {
        side,
        left: Math.round(left),
        width: Math.round(width),
        bottom: Math.round(viewport.height - composer.top + gap),
        maxHeight: Math.floor(roomAbove),
        origin: `${Math.round(originX)}px 100%`,
      };
}

/** The side a composer in this frame opens its layers toward. */
export function preferredLayerSide(frame: "dock" | "landing" | "inline"): LayerSide {
  return frame === "landing" ? "below" : "above";
}
