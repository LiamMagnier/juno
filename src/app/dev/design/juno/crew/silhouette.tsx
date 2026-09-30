/**
 * The flat silhouette of a crew face: the body's front outline and its two
 * eyes, in the family's flat colour. It is what a face shows before its
 * render is ready (drawn at the same framing, so the swap is a quiet fade),
 * and what it keeps showing where WebGL is unavailable. Pure SVG, server
 * rendered, no three.js.
 */

import * as React from "react";
import { FAMILY, type AvatarConfig } from "./avatar";
import { eyePlacement, formParams, frontOutline, outlinePath, surfacePoint } from "./forms";
import type { CrewState } from "./rig";

/** Units to viewBox (64) at the engine's camera: 2.97 units fill the frame, the centre sits 0.14 above the middle. */
function framing(size: number) {
  const zoom = size <= 16 ? 1.13 : size <= 20 ? 1.1 : size <= 28 ? 1.06 : 1;
  const k = (64 / 2.97) * zoom;
  return { k, cx: 32, cy: 32 - 0.2 * k };
}

const cache = new Map<string, { body: string; eyes: { x: number; y: number; w: number; h: number }[]; ground: number }>();

function geometry(cfg: AvatarConfig, size: number) {
  const key = `${cfg.shape}|${JSON.stringify(cfg.proportions)}|${JSON.stringify(cfg.eyes)}|${size <= 72 ? size : 96}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const f = formParams(cfg.shape, cfg.proportions);
  const { k, cx, cy } = framing(size);
  const map = (p: [number, number]): [number, number] => [cx + p[0] * k, cy - p[1] * k];
  const body = outlinePath(frontOutline(f, 64), map);
  const boost = size <= 16 ? 1.72 : size <= 20 ? 1.56 : size <= 28 ? 1.32 : size <= 48 ? 1.14 : size <= 72 ? 1.06 : 1;
  const ep = eyePlacement(f, cfg.eyes, boost);
  const eyes = ep.dirs.map((d) => {
    const s = surfacePoint(f, d[0], d[1], d[2]);
    const [x, y] = map([s[0], s[1]]);
    const w = ep.radius * 2 * k;
    const h = (ep.radius * 2 + ep.length) * k;
    return { x, y, w, h };
  });
  const g = { body, eyes, ground: cy - f.ground * k };
  cache.set(key, g);
  return g;
}

export function Silhouette({ cfg, size, state = "available" }: { cfg: AvatarConfig; size: number; state?: CrewState }) {
  const g = geometry(cfg, size);
  const fam = FAMILY[cfg.color];
  const closed = state === "paused";
  const off = state === "offline";
  const eyeColor = cfg.eyes.style === "lit" ? fam.lit : fam.eye;
  return (
    <svg className="jcf__sil" viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false" data-state={state}>
      <ellipse cx={32} cy={g.ground} rx={20} ry={3.2} fill="currentColor" opacity={0.08} />
      <path d={g.body} fill={fam.flat} />
      {g.eyes.map((e, i) =>
        closed ? (
          <rect key={i} x={e.x - e.w * 0.7} y={e.y - 0.7} width={e.w * 1.4} height={1.4} rx={0.7} fill={eyeColor} opacity={0.8} />
        ) : (
          <rect key={i} x={e.x - e.w / 2} y={e.y - e.h / 2} width={e.w} height={e.h} rx={e.w / 2} fill={eyeColor} opacity={off ? 0.12 : 1} />
        ),
      )}
    </svg>
  );
}
