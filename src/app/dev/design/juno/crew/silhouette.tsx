/**
 * The flat silhouette of a crew character: the body's front outline in its
 * own colour, the two eyes, and the headwear's rough mass. It is what a face
 * shows before its render is ready (drawn at the same framing, so the swap is
 * a quiet fade) and what it keeps showing where WebGL is unavailable. Pure
 * SVG, server rendered, no three.js.
 */

import * as React from "react";
import { anchors, bodyField, frontOutline, outlinePath } from "./shapes";
import { furLengthOf, headroomOf, type AvatarConfig } from "./avatar2";
import { colorHex, featureInk, hexToOklch, oklchToHex } from "./palette";
import type { CrewState } from "./rig";

const cache = new Map<string, { body: string; eyes: { x: number; y: number; r: number }[]; ground: number; groundW: number }>();

function geometry(cfg: AvatarConfig, size: number) {
  const key = `${cfg.shape}|${cfg.stretch}|${cfg.eyes.gap}|${cfg.eyes.y}|${cfg.eyes.size}|${furLengthOf(cfg)}|${headroomOf(cfg)}|${size <= 28 ? size : 64}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const f = bodyField(cfg.shape, cfg.stretch);
  const fur = furLengthOf(cfg);
  const top = f.top + fur + headroomOf(cfg);
  const hgt = top - f.bottom;
  const half = f.halfWidth + fur;
  const ext = Math.max(hgt, half * 2);
  const fill = size <= 20 ? 0.9 : size <= 28 ? 0.88 : 0.84;
  const k = (64 * fill) / ext;
  const cy = f.bottom + hgt / 2;
  const map = (p: [number, number]): [number, number] => [32 + p[0] * k, 32 - (p[1] - cy) * k];
  const pts = frontOutline(cfg.shape, cfg.stretch, 64).map(([x, y]) => {
    const l = Math.hypot(x, y - (f.bottom + (f.top - f.bottom) * 0.45)) || 1;
    return [x + (x / l) * fur, y + ((y - (f.bottom + (f.top - f.bottom) * 0.45)) / l) * fur] as [number, number];
  });
  const body = outlinePath(pts, map);
  const a = anchors(cfg.shape, cfg.stretch, cfg.eyes);
  const boost = size <= 16 ? 1.5 : size <= 20 ? 1.4 : size <= 28 ? 1.26 : size <= 48 ? 1.14 : 1.04;
  const eyes = a.eyes.map((e) => {
    const [x, y] = map([e.p[0], e.p[1]]);
    return { x, y, r: a.eyeRadius * boost * k };
  });
  const g = { body, eyes, ground: 32 - (f.bottom - cy) * k, groundW: half * k * 1.1 };
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
        closed ? (
          <path key={i} d={`M${e.x - e.r} ${e.y}q${e.r} ${e.r * 0.9} ${e.r * 2} 0`} stroke={ink} strokeWidth={Math.max(0.9, e.r * 0.3)} fill="none" strokeLinecap="round" />
        ) : (
          <ellipse key={i} cx={e.x} cy={e.y} rx={e.r * 0.9} ry={e.r * (cfg.eyes.style === "oval" ? 1.15 : 0.95)} fill={cfg.eyes.style === "wide" || cfg.eyes.style === "googly" ? "#f7f5f0" : "#15110f"} opacity={off ? 0.5 : 1} />
        ),
      )}
    </svg>
  );
}
