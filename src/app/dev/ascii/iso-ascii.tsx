"use client";

import * as React from "react";

/*
 * The construction in an isometric view, drawn in text.
 *
 * Geometry: the same seven orbits (radius ×1.5 each) as circles on a plane,
 * the ℵ number line along the plane's x axis, one presence trajectory on the
 * fourth orbit. The plane is turned (yaw) and tilted, then projected
 * orthographically, so the rings become diagonal ellipses and the number line
 * a diagonal axis.
 *
 *   braille  each cell is a 2×4 grid of dots (U+2800–U+28FF): smooth, fine curves
 *   slope    one character per cell following the curve (· - / | \ ‾ _)
 *
 * Depth: points on the near half of a ring are brighter than the far half.
 * Motion: the rings draw on once, then the plane yaws very slowly and the
 * trajectory travels its orbit. Rendered to a canvas (one fillText per cell),
 * paused when reduced motion is asked for.
 */

const BASE = 0.075; // innermost radius as a fraction of the panel's width
const RATIO = 1.5;
const COUNT = 7;
const TILT = (58 * Math.PI) / 180; // plane tilt from the screen
const YAW0 = (-24 * Math.PI) / 180; // turns the number line within the plane
const ROLL = (-20 * Math.PI) / 180; // leans the whole plane on screen: the isometric diagonal
const PRESENCE = "151, 166, 230";
const INK = "232, 233, 235";

type Variant = "braille" | "slope" | "dots";

const BRAILLE_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
];

export function IsoAscii({ variant, width, height }: { variant: Variant; width: number; height: number }) {
  const ref = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const fontPx = variant === "braille" ? 12 : variant === "dots" ? 13 : 10;
    const font = `${fontPx}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.font = font;
    const cw = ctx.measureText("M").width;
    const ch = variant === "slope" ? fontPx * 1.2 : fontPx * 1.18;
    const cols = Math.floor(width / cw);
    const rows = Math.floor(height / ch);
    const sx = variant === "slope" ? 1 : 2;
    const sy = variant === "slope" ? 1 : 4;

    const cx = width * 0.5;
    const cy = height * 0.46;
    const unit = width;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const start = performance.now();
    let frame = 0;

    // Project a point on the plane (x, y in units of panel width) to screen px, with depth.
    const project = (x: number, y: number, yaw: number) => {
      const xr = x * Math.cos(yaw) - y * Math.sin(yaw);
      const yr = x * Math.sin(yaw) + y * Math.cos(yaw);
      // Tilt about the screen's x axis: the plane's y recedes.
      const sy2 = yr * Math.cos(TILT);
      const depth = yr * Math.sin(TILT); // >0 nearer the viewer
      // Roll in screen space, so rings become diagonal ellipses.
      const rx2 = xr * Math.cos(ROLL) - sy2 * Math.sin(ROLL);
      const ry2 = xr * Math.sin(ROLL) + sy2 * Math.cos(ROLL);
      return { px: cx + rx2 * unit, py: cy + ry2 * unit, depth };
    };

    const draw = (now: number) => {
      const t = reduce ? 99 : (now - start) / 1000;
      const yaw = YAW0 + (reduce ? 0 : Math.max(0, t - 2.4) * 0.018);
      ctx.clearRect(0, 0, width, height);
      ctx.font = font;
      ctx.textBaseline = "top";

      // Sub-cell buffers: brightness (0..1) and whether presence blue.
      const gw = cols * sx;
      const gh = rows * sy;
      const lum = new Float32Array(gw * gh);
      const blue = new Uint8Array(gw * gh);
      const dirX = new Float32Array(gw * gh);
      const dirY = new Float32Array(gw * gh);
      const plot = (px: number, py: number, v: number, isBlue = false, dx = 0, dy = 0) => {
        const gx = Math.floor((px / width) * gw);
        const gy = Math.floor((py / height) * gh);
        if (gx < 0 || gy < 0 || gx >= gw || gy >= gh) return;
        const i = gy * gw + gx;
        if (v > lum[i]) {
          lum[i] = v;
          dirX[i] = dx;
          dirY[i] = dy;
        }
        if (isBlue) blue[i] = 1;
      };

      // Draw-on progress per ring (the homepage's 110ms stagger, ~1.6s each).
      const progress = (k: number) => Math.min(1, Math.max(0, (t - 0.15 - k * 0.11) / 1.6));
      const ease = (p: number) => 1 - Math.pow(1 - p, 4);

      // The number line along the plane's x axis, with ℵ ticks.
      const axisP = ease(progress(0));
      const R = (k: number) => BASE * RATIO ** k;
      const axisLen = R(COUNT - 1) * 1.05;
      for (let s = -1; s <= 1; s += 0.0015) {
        if (Math.abs(s) > axisP) continue;
        const a = project(s * axisLen, 0, yaw);
        plot(a.px, a.py, 0.24, false, 1, 0);
      }

      for (let k = 0; k < COUNT; k++) {
        const p = ease(progress(k + 1));
        if (p <= 0) continue;
        const r = R(k);
        const steps = Math.ceil(900 + r * 9000);
        const faint = k >= 5;
        for (let s = 0; s < steps * p; s++) {
          const a = (s / steps) * Math.PI * 2;
          const pt = project(r * Math.cos(a), r * Math.sin(a), yaw);
          const n = project(r * Math.cos(a + 0.01), r * Math.sin(a + 0.01), yaw);
          // Near half bright, far half dim; outer rings fainter overall.
          const near = 0.5 + 0.5 * Math.tanh(pt.depth / (r * 0.6));
          const v = (faint ? 0.3 : 0.62) * (0.35 + 0.65 * near);
          plot(pt.px, pt.py, v, false, n.px - pt.px, n.py - pt.py);
        }
      }

      // The trajectory travels the fourth orbit; its node leads.
      const rT = R(3);
      const tp = ease(Math.min(1, Math.max(0, (t - 0.9) / 1.4)));
      const lead = reduce ? 0.35 : (t * 0.05) % 1;
      const span = 0.22 * tp;
      for (let s = 0; s <= 1; s += 0.002) {
        const a = (lead - span * (1 - s)) * Math.PI * 2;
        const pt = project(rT * Math.cos(a), rT * Math.sin(a), yaw);
        const n = project(rT * Math.cos(a + 0.01), rT * Math.sin(a + 0.01), yaw);
        plot(pt.px, pt.py, 0.35 + 0.65 * s, true, n.px - pt.px, n.py - pt.py);
      }

      if (variant === "dots") {
        // A true dot matrix: every lit sub-cell is a dot, sized and lit by its
        // brightness (near side of a ring bigger and brighter).
        const dw = cw / 2;
        const dh = ch / 4;
        for (let gy = 0; gy < gh; gy++) {
          for (let gx = 0; gx < gw; gx++) {
            const i = gy * gw + gx;
            const v = lum[i];
            if (!v) continue;
            const x = gx * dw + dw / 2;
            const y = gy * dh + dh / 2;
            const rad = 0.55 + v * 1.25;
            if (blue[i]) {
              ctx.shadowColor = `rgba(${PRESENCE}, 0.8)`;
              ctx.shadowBlur = 10;
              ctx.fillStyle = `rgba(${PRESENCE}, ${Math.min(1, v + 0.2)})`;
            } else {
              ctx.shadowBlur = 0;
              ctx.fillStyle = `rgba(${INK}, ${Math.min(1, v * 1.15)})`;
            }
            ctx.beginPath();
            ctx.arc(x, y, blue[i] ? rad + 0.35 : rad, 0, Math.PI * 2);
            ctx.fill();
          }
        }
        ctx.shadowBlur = 0;
      }

      // Compose cells.
      for (let r = 0; r < rows && variant !== "dots"; r++) {
        for (let c = 0; c < cols; c++) {
          let bits = 0;
          let best = 0;
          let isBlue = false;
          let dx = 0;
          let dy = 0;
          for (let yy = 0; yy < sy; yy++) {
            for (let xx = 0; xx < sx; xx++) {
              const i = (r * sy + yy) * gw + (c * sx + xx);
              const v = lum[i];
              if (v > 0) {
                if (variant === "braille") bits |= BRAILLE_BITS[yy][xx];
                if (v > best) {
                  best = v;
                  dx = dirX[i];
                  dy = dirY[i];
                }
                if (blue[i]) isBlue = true;
              }
            }
          }
          if (!best) continue;
          let glyph: string;
          if (variant === "braille") glyph = String.fromCharCode(0x2800 + bits);
          else {
            const ang = Math.atan2(dy * (cw / ch), dx);
            const o = ((ang % Math.PI) + Math.PI) % Math.PI; // 0..π
            glyph = o < Math.PI / 8 || o > (7 * Math.PI) / 8 ? "-" : o < (3 * Math.PI) / 8 ? "\\" : o < (5 * Math.PI) / 8 ? "|" : "/";
            if (best < 0.16) glyph = "·";
          }
          ctx.fillStyle = isBlue ? `rgba(${PRESENCE}, ${Math.min(1, best + 0.15)})` : `rgba(${INK}, ${best})`;
          if (isBlue) {
            ctx.shadowColor = `rgba(${PRESENCE}, 0.55)`;
            ctx.shadowBlur = 8;
          }
          ctx.fillText(glyph, c * cw, r * ch);
          if (isBlue) ctx.shadowBlur = 0;
        }
      }

      // ℵ marks where the first rings cross the number line (the near side).
      ctx.font = `10px "JetBrains Mono", ui-monospace, monospace`;
      for (let k = 0; k < 5; k++) {
        if (progress(k + 1) < 0.6) continue;
        const a = project(R(k), 0, yaw);
        ctx.fillStyle = "rgba(149, 151, 156, 0.85)";
        ctx.fillText(`ℵ${"₀₁₂₃₄"[k]}`, a.px + 6, a.py - 14);
      }

      if (!reduce) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [variant, width, height]);

  return <canvas ref={ref} className="iso-ascii" style={{ width, height }} aria-hidden="true" />;
}
