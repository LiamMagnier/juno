/**
 * THE VOICE LIGHT'S RENDERER: one WebGL program, shared by every glow on the
 * page, drawing a signed-distance light around the composer's own outline.
 *
 * Why a shader and not CSS. The light has to live ON the composer's edge and
 * OUTSIDE it, never over the text: a 1px tone on the border itself, a falloff
 * that hugs the 22px corners exactly, and nothing inside but a 2.5px rim. A
 * distance field gives all three from one number per pixel, follows the
 * outline around the corners by arc length rather than by a blob's radius,
 * dithers its gradients (a soft light on charcoal bands in 8 bits otherwise),
 * and adds light on the dark ground instead of laying a tint over it.
 *
 * Why shared. A page can hold one glow (the composer) or forty (the lab), and
 * a browser keeps about sixteen WebGL contexts. So one offscreen context draws
 * each glow in turn and copies the pixels into that glow's own 2D canvas —
 * a GPU-to-GPU copy — and only when its frame changed. A still glow costs
 * nothing: no draw, no copy, no composite.
 */

import type { ResolvedGlowPalette } from "@/components/voice/voice-glow-palette";

/**
 * The shapes the lab compares; production draws the winner.
 *
 * - `edge`: the composer's own edge lights from the bottom centre and the
 *   light spreads around the outline with the voice, a soft falloff outside;
 *   two voices at once part toward their own sides.
 * - `duet`: the same edge light, but each voice is anchored at its own
 *   bottom corner (you right, as your turns sit in the transcript; Alevr
 *   left), so two voices at once read as two.
 * - `horizon`: no edge; light pools beneath the composer, from the speaker's
 *   side.
 */
export type GlowVariant = "edge" | "duet" | "horizon";

export const GLOW_VARIANT_INDEX: Record<GlowVariant, number> = { edge: 0, horizon: 1, duet: 2 };

/** How far outside the composer the light may reach, in CSS px. */
export const GLOW_MARGIN = 44;

export interface GlowDrawParams {
  /** Device-pixel size of the target canvas. */
  width: number;
  height: number;
  dpr: number;
  /** The composer's border box inside the canvas, CSS px. */
  rect: [number, number, number, number];
  radius: number;
  variant: GlowVariant;
  /** frameVector(): you amp/lift, alevr amp/lift, muted, beam A amp/pos/mix, beam B amp/pos/mix. */
  frame: number[];
  palette: ResolvedGlowPalette;
  /** Reduced transparency: a crisp, solid edge and no falloff. */
  solid: boolean;
}

const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;

uniform vec2 uRes;
uniform float uDpr;
uniform vec4 uRect;
uniform float uRadius;
uniform float uVariant;
uniform vec2 uYou;
uniform vec2 uAlevr;
uniform float uMuted;
uniform vec3 uBeamA;
uniform vec3 uBeamB;
uniform vec3 uYouLine;
uniform vec3 uYouGlow;
uniform vec3 uYouHot;
uniform vec3 uAlevrLine;
uniform vec3 uAlevrGlow;
uniform vec3 uAlevrHot;
uniform vec3 uMutedCol;
uniform float uDark;
uniform float uAdditive;
uniform float uSolid;

const float PI = 3.14159265;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

// Arc length from the bottom centre along the outline to the point nearest p,
// right positive, left negative.
float arcPos(vec2 rel, vec2 b, float r) {
  float ax = abs(rel.x);
  float hx = b.x - r;
  float hy = b.y - r;
  float qr = 0.5 * PI * r;
  float s;
  if (ax <= hx) {
    s = rel.y >= 0.0 ? ax : hx + qr + 2.0 * hy + qr + (hx - ax);
  } else if (abs(rel.y) <= hy) {
    s = hx + qr + (hy - rel.y);
  } else {
    vec2 k = vec2(ax - hx, abs(rel.y) - hy);
    float th = atan(k.y, max(k.x, 1e-4));
    s = rel.y > 0.0 ? hx + r * (0.5 * PI - th) : hx + qr + 2.0 * hy + r * th;
  }
  return rel.x < 0.0 ? -s : s;
}

float gauss(float x) { return exp(-x * x); }

float hash(vec2 p) {
  p = fract(p * vec2(443.897, 441.423));
  p += dot(p, p.yx + 19.19);
  return fract((p.x + p.y) * p.x);
}

vec4 acc;

void lay(vec3 col, float a) {
  a = clamp(a, 0.0, 1.0);
  if (uAdditive > 0.5) {
    acc.rgb += col * a;
  } else {
    acc.rgb = col * a + acc.rgb * (1.0 - a);
    acc.a = a + acc.a * (1.0 - a);
  }
}

// One light: brightness amp, lit along the outline by 'along', with a 1px edge,
// an outer falloff F px long and a hairline rim inside.
void light(float amp, float along, float F, float d, float line, vec3 lineCol, vec3 glowCol, vec3 hotCol, float haloK, float lineK) {
  float k = amp * along;
  if (k < 0.0005) return;
  if (uSolid > 0.5) {
    // Reduced transparency: the lit stretch of the edge, solid and crisp.
    float on = step(0.32, k) * line;
    lay(lineCol, on);
    return;
  }
  // A tight exponential that reads as the edge emitting, and a short gaussian
  // shoulder that reads as light in the air; both gone well inside the canvas.
  float od = max(d, 0.0);
  float halo = d > 0.0 ? (0.7 * exp(-od / F) + 0.3 * gauss(od / (2.2 * F))) * (1.0 - smoothstep(22.0, 40.0, od)) : 0.0;
  float rim = d < -1.0 ? exp((d + 1.0) / 3.0) : 0.0;
  float hot = uDark * smoothstep(0.5, 1.0, k);
  vec3 edgeCol = mix(lineCol, hotCol, hot * 0.8);
  lay(glowCol, k * haloK * halo);
  lay(glowCol, k * (uAdditive > 0.5 ? 0.32 : 0.26) * rim);
  lay(edgeCol, k * lineK * line);
}

void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) / uDpr;
  vec2 b = uRect.zw * 0.5;
  vec2 c = uRect.xy + b;
  vec2 rel = p - c;
  float r = min(uRadius, min(b.x, b.y));
  float d = sdRoundBox(rel, b, r);
  float W = uRect.z;
  float hx = b.x - r;
  float qr = 0.5 * PI * r;
  float s = arcPos(rel, b, r);

  // The border band d in [-1, 0], antialiased in device pixels.
  float line = clamp((0.5 - abs(d + 0.5)) * uDpr + 0.5, 0.0, 1.0);

  acc = vec4(0.0);
  float haloK = uAdditive > 0.5 ? 0.6 : 0.5;
  float lineK = uAdditive > 0.5 ? 1.0 : 0.92;
  // Falloff length in px: at rest, and added at a full voice. On ivory the
  // same light reads louder, so it stays closer to the edge.
  float F0 = uDark > 0.5 ? 3.0 : 2.5;
  float F1 = uDark > 0.5 ? 11.0 : 10.0;

  float corner = hx + qr * 0.5;
  float aYou = 0.0;
  float aAlevr = 0.0;
  float bFrom = hx;
  float bTo = -hx;
  if (uVariant > 1.5) { aYou = corner; aAlevr = -corner; bFrom = corner; bTo = -corner; }
  else {
    // One voice is centred, like the glow it replaces. Two at once (you
    // talking over Alevr) part to make room for each other, yours toward your
    // side and Alevr's toward its own, and meet in the middle.
    float both = smoothstep(0.04, 0.3, min(uYou.x, uAlevr.x));
    aYou = both * 0.21 * W;
    aAlevr = -both * 0.21 * W;
  }

  if (uVariant > 0.5 && uVariant < 1.5) {
    // HORIZON: light pooled under the composer, from the speaker's side.
    float below = smoothstep(b.y * 0.15, b.y, rel.y) * (1.0 - smoothstep(b.x - r, b.x + 8.0, abs(rel.x)));
    float hF = 4.0;
    float hL = 0.35;
    float sy = 0.30 * W;
    float wa = W * (0.12 + 0.30 * uYou.y);
    float wb = W * (0.12 + 0.30 * uAlevr.y);
    light(uMuted, gauss(rel.x / (0.3 * W)) * below, 4.0, d, line, uMutedCol, uMutedCol, uMutedCol, 0.25, 0.5);
    light(uAlevr.x, gauss((rel.x + sy) / wb) * below, hF + 2.0 * F1 * uAlevr.y, d, line, uAlevrLine, uAlevrGlow, uAlevrHot, haloK * 1.35, lineK * hL);
    light(uYou.x, gauss((rel.x - sy) / wa) * below, hF + 2.0 * F1 * uYou.y, d, line, uYouLine, uYouGlow, uYouHot, haloK * 1.35, lineK * hL);
    float bw = max(0.07 * W, 18.0);
    for (int i = 0; i < 2; i++) {
      vec3 bm = i == 0 ? uBeamB : uBeamA;
      float al = gauss((rel.x - mix(0.42 * W, -0.42 * W, bm.y)) / bw) * below;
      float alE = gauss((rel.x - mix(0.42 * W, -0.42 * W, max(bm.y - 0.12, 0.0))) / bw) * below;
      light(bm.x * (1.0 - bm.z), alE, hF + 0.6 * F1, d, line, uYouLine, uYouGlow, uYouHot, haloK * 1.2, lineK * hL);
      light(bm.x * bm.z, al, hF + 0.6 * F1, d, line, uAlevrLine, uAlevrGlow, uAlevrHot, haloK * 1.2, lineK * hL);
    }
  } else {
    // EDGE and DUET: the composer's own outline lights.
    float sMuted = 0.32 * W;
    light(uMuted, gauss(s / sMuted), 3.0, d, line, uMutedCol, uMutedCol, uMutedCol, 0.18, 0.9);
    float spanBase = uVariant > 1.5 ? 0.06 : 0.08;
    float spanGain = uVariant > 1.5 ? 0.36 : 0.30;
    float sa = W * (spanBase + spanGain * uAlevr.y);
    float sy = W * (spanBase + spanGain * uYou.y);
    light(uAlevr.x, gauss((s - aAlevr) / sa), F0 + F1 * uAlevr.y, d, line, uAlevrLine, uAlevrGlow, uAlevrHot, haloK, lineK);
    light(uYou.x, gauss((s - aYou) / sy), F0 + F1 * uYou.y, d, line, uYouLine, uYouGlow, uYouHot, haloK, lineK);
    float bw = max(0.075 * W, 20.0);
    for (int i = 0; i < 2; i++) {
      vec3 bm = i == 0 ? uBeamB : uBeamA;
      // Ember trails the presence head by a beam's width, so the handoff
      // reads as one light passing to the next rather than two mixing.
      float al = gauss((s - mix(bFrom, bTo, bm.y)) / bw);
      float alE = gauss((s - mix(bFrom, bTo, max(bm.y - 0.12, 0.0))) / bw);
      light(bm.x * (1.0 - bm.z), alE, F0 + 0.4 * F1, d, line, uYouLine, uYouGlow, uYouHot, haloK, lineK);
      light(bm.x * bm.z, al, F0 + 0.4 * F1, d, line, uAlevrLine, uAlevrGlow, uAlevrHot, haloK, lineK);
    }
  }

  if (uAdditive > 0.5) {
    acc.a = clamp(max(acc.r, max(acc.g, acc.b)), 0.0, 1.0);
    acc.rgb = min(acc.rgb, vec3(acc.a));
  }
  if (acc.a > 0.004) {
    // Dither half a step either way so soft gradients do not band; keep the
    // colour premultiplied (never brighter than its alpha).
    float n = (hash(gl_FragCoord.xy) - 0.5) / 255.0;
    acc = clamp(acc + vec4(n), 0.0, 1.0);
    acc.rgb = min(acc.rgb, vec3(acc.a));
  }
  gl_FragColor = acc;
}
`;

type Uniforms = Record<
  | "uRes"
  | "uDpr"
  | "uRect"
  | "uRadius"
  | "uVariant"
  | "uYou"
  | "uAlevr"
  | "uMuted"
  | "uBeamA"
  | "uBeamB"
  | "uYouLine"
  | "uYouGlow"
  | "uYouHot"
  | "uAlevrLine"
  | "uAlevrGlow"
  | "uAlevrHot"
  | "uMutedCol"
  | "uDark"
  | "uAdditive"
  | "uSolid",
  WebGLUniformLocation | null
>;

class SharedGlowRenderer {
  readonly canvas: HTMLCanvasElement;
  private gl: WebGLRenderingContext;
  private u: Uniforms;
  lost = false;

  constructor(canvas: HTMLCanvasElement, gl: WebGLRenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    const program = link(gl);
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // One triangle that covers the viewport.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "aPos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const names = [
      "uRes", "uDpr", "uRect", "uRadius", "uVariant", "uYou", "uAlevr", "uMuted", "uBeamA", "uBeamB",
      "uYouLine", "uYouGlow", "uYouHot", "uAlevrLine", "uAlevrGlow", "uAlevrHot", "uMutedCol", "uDark", "uAdditive", "uSolid",
    ] as const;
    this.u = Object.fromEntries(names.map((n) => [n, gl.getUniformLocation(program, n)])) as Uniforms;
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      this.lost = true;
      if (shared === this) shared = null;
    });
  }

  /** Draw one glow and copy it into `target`. */
  draw(target: CanvasRenderingContext2D, p: GlowDrawParams): void {
    const { gl, u } = this;
    const w = Math.max(1, Math.min(4096, Math.round(p.width)));
    const h = Math.max(1, Math.min(4096, Math.round(p.height)));
    if (this.canvas.width < w || this.canvas.height < h) {
      this.canvas.width = Math.max(this.canvas.width, w);
      this.canvas.height = Math.max(this.canvas.height, h);
    }
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const f = p.frame;
    const pal = p.palette;
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uDpr, p.dpr);
    gl.uniform4f(u.uRect, p.rect[0], p.rect[1], p.rect[2], p.rect[3]);
    gl.uniform1f(u.uRadius, p.radius);
    gl.uniform1f(u.uVariant, GLOW_VARIANT_INDEX[p.variant]);
    gl.uniform2f(u.uYou, f[0], f[1]);
    gl.uniform2f(u.uAlevr, f[2], f[3]);
    gl.uniform1f(u.uMuted, f[4]);
    gl.uniform3f(u.uBeamA, f[5], f[6], f[7]);
    gl.uniform3f(u.uBeamB, f[8], f[9], f[10]);
    gl.uniform3fv(u.uYouLine, pal.you.line);
    gl.uniform3fv(u.uYouGlow, pal.you.glow);
    gl.uniform3fv(u.uYouHot, pal.you.hot);
    gl.uniform3fv(u.uAlevrLine, pal.alevr.line);
    gl.uniform3fv(u.uAlevrGlow, pal.alevr.glow);
    gl.uniform3fv(u.uAlevrHot, pal.alevr.hot);
    gl.uniform3fv(u.uMutedCol, pal.muted);
    gl.uniform1f(u.uDark, pal.dark ? 1 : 0);
    gl.uniform1f(u.uAdditive, pal.dark && !p.solid ? 1 : 0);
    gl.uniform1f(u.uSolid, p.solid ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    target.clearRect(0, 0, w, h);
    // The viewport sits at the bottom-left of the GL buffer, which is the
    // bottom-left of the canvas as an image.
    target.drawImage(this.canvas, 0, this.canvas.height - h, w, h, 0, 0, w, h);
  }
}

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("voice glow: no shader");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`voice glow: shader failed: ${log}`);
  }
  return shader;
}

function link(gl: WebGLRenderingContext): WebGLProgram {
  const program = gl.createProgram();
  if (!program) throw new Error("voice glow: no program");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERT));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`voice glow: link failed: ${gl.getProgramInfoLog(program)}`);
  }
  return program;
}

let shared: SharedGlowRenderer | null = null;
let unsupported = false;

/** The page's renderer, created on first use; null where WebGL is unavailable. */
export function glowRenderer(): SharedGlowRenderer | null {
  if (shared && !shared.lost) return shared;
  if (unsupported || typeof document === "undefined") return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const gl = canvas.getContext("webgl", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: "low-power",
    });
    if (!gl) {
      unsupported = true;
      return null;
    }
    shared = new SharedGlowRenderer(canvas, gl);
    return shared;
  } catch {
    unsupported = true;
    return null;
  }
}

export type { SharedGlowRenderer };
