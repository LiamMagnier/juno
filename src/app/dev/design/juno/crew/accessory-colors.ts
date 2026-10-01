/**
 * The colour an accessory wears when the person has not chosen one, chosen to
 * sit with the body (pure, no three.js).
 */

import type { AccessoryId } from "./avatar2";
import { complement, hexToOklch, oklchToHex, patternPartner } from "./palette";

export const GOLD = "#c9a660";
export const SILVER = "#b9bcc2";
export const INK = "#2c2d31";

function light(hex: string) {
  return hexToOklch(hex).l > 0.72;
}

export function defaultAccessoryColor(id: AccessoryId, bodyHex: string): string {
  const comp = complement(bodyHex);
  const lch = hexToOklch(bodyHex);
  switch (id) {
    case "cap":
    case "headband":
    case "bow":
    case "scarf":
    case "bandana":
    case "antenna":
      return comp;
    case "beanie":
      return lch.c < 0.04 ? "#c9486b" : oklchToHex({ l: Math.min(0.92, lch.l + 0.2), c: lch.c * 0.45, h: (lch.h + 40) % 360 });
    case "bucket":
      return light(bodyHex) ? "#8a5d47" : "#e8dcc6";
    case "sprout":
      return "#78b04a";
    case "flower":
      return lch.h > 330 || lch.h < 30 ? "#f0b545" : "#e9566d";
    case "round":
    case "monocle":
    case "hoops":
      return GOLD;
    case "square":
    case "shades":
      return INK;
    case "headphones":
      return light(bodyHex) ? "#3e4045" : "#f1f0ec";
    case "earbuds":
      return "#f6f6f4";
    default:
      return patternPartner(bodyHex);
  }
}
