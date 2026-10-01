/**
 * The flat silhouette of a crew character: the body's front outline in its
 * own colour, the two eyes, and the headwear's rough mass. It is what a face
 * shows before its render is ready (drawn at the same framing, so the swap is
 * a quiet fade) and what it keeps showing where WebGL is unavailable. Pure
 * SVG, server rendered, no three.js.
 */

import * as React from "react";
import { furLengthOf, headroomOf, type AvatarConfig } from "./avatar2";
import { halfWidthAt } from "./fit";
import { SHAPE_DATA } from "./kit-data";
import type { ShapeId } from "./kit";
import { colorHex, featureInk, hexToOklch, oklchToHex } from "./palette";
import type { CrewState } from "./rig";

const cache = new Map<string, { body: string; eyes: { x: number; y: number; r: number }[]; ground: number; groundW: number }>();

function geometry(cfg: AvatarConfig, size: number) {
  const key = `${cfg.shape}|${cfg.stretch}|${cfg.eyes.gap}|${cfg.eyes.y}|${cfg.eyes.size}|${furLengthOf(cfg)}|${headroomOf(cfg)}|${size <= 28 ? size : 64}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const shape = cfg.shape as ShapeId;
  const d = SHAPE_DATA[shape];
  const sy = 1 + 0.16 * cfg.stretch;
  const sxz = 1 / Math.sqrt(sy);
  const fur = furLengthOf(cfg) * 0.9;
  const bodyTop = d.bounds.top * sy + fur;
  const top = bodyTop + Math.min(headroomOf(cfg), d.bounds.top * (size <= 28 ? 0.1 : 0.26));
  const bottom = d.bounds.bottom;
  const hgt = top - bottom;
  const half = d.bounds.halfWidth * sxz + fur;
  const ext = Math.max(hgt, half * 2);
  const fill = size <= 20 ? 0.9 : size <= 28 ? 0.88 : 0.84;
  const k = (64 * fill) / ext;
  const cy = bottom + hgt / 2;
  const map = (x: number, y: number): [number, number] => [32 + x * k, 32 - (y - cy) * k];
  const c = d.bounds.top * 0.45 * sy;
  const pts = d.outline.map(([x, y]) => {
    const X = x * sxz;
    const Y = y * sy;
    const l = Math.hypot(X, Y - c) || 1;
    return map(X + (X / l) * fur, Y + ((Y - c) / l) * fur);
  });
  const body = `M${pts.map(([x, y]) => `${x.toFixed(2)} ${y.toFixed(2)}`).join("L")}Z`;
  const f = d.face;
  const ey = (f.y[0] + (f.y[1] - f.y[0]) * cfg.eyes.y) * f.top;
  const hw = f.hw ?? halfWidthAt(shape, ey);
  const ex = (f.gap[0] + (f.gap[1] - f.gap[0]) * cfg.eyes.gap) * hw;
  const boost = size <= 16 ? 1.5 : size <= 20 ? 1.42 : size <= 28 ? 1.24 : size <= 48 ? 1.12 : 1.04;
  const er = (f.r[0] + (f.r[1] - f.r[0]) * cfg.eyes.size) * f.top * boost;
  const eyes = [-1, 1].map((s) => {
    const [x, y] = map(s * ex * sxz, ey * sy);
    return { x, y, r: er * k };
  });
  const g = { body, eyes, ground: 32 - (bottom - cy) * k, groundW: half * k * 1.1 };
  cache.set(key, g);
  return g;
}

export function Silhouette({ cfg, size, state = "available" }: { cfg: AvatarConfig; size: number; state?: CrewState }) {
  const g = geometry(cfg, size);
  const hex = colorHex(cfg.color);
  const lch = hexToOklch(hex);
  // The flat colour sits a little darker than the albedo, the way the lit body reads on average.
  const flat = oklchToHex({ l: lch.l * 0.94, c: lch.c * 0.95, h: lch.h });
  const closed = state === "paused";
  const off = state === "offline";
  const ink = featureInk(hex);
  return (
    <svg className="jcf__sil" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false" data-state={state}>
      <ellipse cx={32} cy={g.ground} rx={g.groundW} ry={Math.max(1.6, g.groundW * 0.14)} fill="currentColor" opacity={0.07} />
      <path d={g.body} fill={flat} />
      {g.eyes.map((e, i) =>
        closed || cfg.eyes.style === "sleepy" ? (
          <path key={i} d={`M${e.x - e.r} ${e.y}q${e.r} ${e.r * 0.9} ${e.r * 2} 0`} stroke={ink} strokeWidth={Math.max(0.9, e.r * 0.3)} fill="none" strokeLinecap="round" />
        ) : (
          <ellipse key={i} cx={e.x} cy={e.y} rx={e.r * 0.9} ry={e.r * (cfg.eyes.style === "oval" ? 1.15 : 0.95)} fill={cfg.eyes.style === "wide" || cfg.eyes.style === "googly" ? "#f7f5f0" : "#15110f"} opacity={off ? 0.5 : 1} />
        ),
      )}
    </svg>
  );
}
