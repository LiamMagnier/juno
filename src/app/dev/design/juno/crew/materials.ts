/**
 * Materials for the crew characters (three.js, client only).
 *
 *   PLUSH     real-time fur by shell texturing: the body mesh is drawn N
 *             times as instances, each pushed a little further out along its
 *             normal (plus gravity and the rig's secondary motion). A tileable
 *             strand field (Worley cells: a height and a distance to the
 *             strand's centre) decides, per shell, which fragments are fibre;
 *             strands taper to their tips, inner shells are shadowed (fur
 *             self-occlusion), tips catch a velvet sheen. Alpha-to-coverage on
 *             the MSAA buffer gives soft, antialiased fibres without sorting.
 *             Level of detail: fewer shells at small sizes.
 *   VELVET    the same shells, very short, very dense and with a strong
 *             sheen: flock.
 *   KNIT      a stitch height field wrapped around the body (cylindrical, the
 *             seam hidden by Tarini's two-lookup trick) as a derivative bump
 *             plus darker grooves.
 *   FELT      matte, fibrous bump and a faint mottle; soft sheen.
 *   VINYL     soft vinyl: smooth, satin clearcoat.
 *   CERAMIC   matte glaze with a fine speckle and orange-peel bump.
 *
 * Every body material evaluates the same albedo function in object space:
 * the body colour, then the pattern (two-tone dip, belly, spots, stripes, or
 * an uploaded image projected from the front), then the cheeks' blush, then
 * the desaturation that offline and paused use. Nothing recompiles when a
 * state changes: those are uniforms.
 *
 * Accessories use the same bump machinery (triplanar) for felt, knit, canvas
 * and velvet, and plain physical materials for metal, acetate and vinyl.
 */

import * as THREE from "three";
import { hashSeed, prng } from "./identity";

/* ——————————————————————————— Procedural textures ——————————————————————————— */

const texCache = new Map<string, THREE.Texture>();

function dataTexture(key: string, size: number, fill: (data: Uint8Array, size: number) => void, channels: "rg" | "r" | "rgba" = "rgba") {
  const hit = texCache.get(key);
  if (hit) return hit;
  const stride = 4;
  const data = new Uint8Array(size * size * stride);
  fill(data, size);
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.colorSpace = THREE.NoColorSpace;
  t.needsUpdate = true;
  void channels;
  texCache.set(key, t);
  return t;
}

/**
 * The strand field: a tileable jittered grid of strand roots. Per texel:
 *   R  the nearest strand's height (0.45..1, so strands end at different lengths)
 *   G  distance to that strand's centre, normalised to the cell (0 centre .. 1)
 *   B  a per-strand random, for colour variation along the fibres
 */
export function strandTexture(): THREE.Texture {
  return dataTexture("strands", 256, (data, size) => {
    const cells = 40;
    const r = prng(hashSeed("juno-fur"));
    const pts: { x: number; y: number; h: number; c: number }[] = [];
    for (let j = 0; j < cells; j++)
      for (let i = 0; i < cells; i++) pts.push({ x: (i + 0.15 + r() * 0.7) / cells, y: (j + 0.15 + r() * 0.7) / cells, h: 0.45 + Math.pow(r(), 0.6) * 0.55, c: r() });
    const cell = 1 / cells;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size;
        const v = (y + 0.5) / size;
        const ci = Math.floor(u * cells);
        const cj = Math.floor(v * cells);
        let best = 9;
        let bh = 0;
        let bc = 0;
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const ii = (ci + di + cells) % cells;
            const jj = (cj + dj + cells) % cells;
            const p = pts[jj * cells + ii];
            let dx = p.x - u;
            let dy = p.y - v;
            dx -= Math.round(dx);
            dy -= Math.round(dy);
            const d = Math.hypot(dx, dy);
            if (d < best) {
              best = d;
              bh = p.h;
              bc = p.c;
            }
          }
        const o = (y * size + x) * 4;
        data[o] = Math.round(bh * 255);
        data[o + 1] = Math.round(Math.min(1, best / (cell * 0.75)) * 255);
        data[o + 2] = Math.round(bc * 255);
        data[o + 3] = 255;
      }
    }
  });
}

/** Knit: stockinette V stitches. R = height, G = groove darkness. 4 x 4 stitches per tile. */
export function knitTexture(): THREE.Texture {
  return dataTexture("knit", 128, (data, size) => {
    const n = 4;
    const cw = size / n;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const cx = (x % cw) / cw; // 0..1 across the stitch
        const cy = (y % cw) / cw; // 0..1 along
        // Two slanted legs, left and right, each a soft ellipse.
        let h = 0;
        for (const side of [-1, 1]) {
          const lx = cx - 0.5 - side * 0.22;
          const ly = cy - 0.5;
          const a = side * 0.55;
          const rx = lx * Math.cos(a) - ly * Math.sin(a);
          const ry = lx * Math.sin(a) + ly * Math.cos(a);
          const d = Math.hypot(rx / 0.2, ry / 0.46);
          h = Math.max(h, Math.max(0, 1 - d * d));
        }
        // Fibre twist along each leg.
        const twist = 0.08 * Math.sin((cx * 3 + cy * 9) * Math.PI * 2);
        const hv = Math.min(1, Math.max(0, Math.sqrt(h) + twist * h));
        const o = (y * size + x) * 4;
        data[o] = Math.round(hv * 255);
        data[o + 1] = Math.round((1 - Math.min(1, h * 1.8)) * 255);
        data[o + 2] = 0;
        data[o + 3] = 255;
      }
  });
}

/** Felt and flock: short, crossing fibres. R = height, G = mottle. */
export function feltTexture(): THREE.Texture {
  return dataTexture("felt", 256, (data, size) => {
    const h = new Float32Array(size * size);
    const r = prng(hashSeed("juno-felt"));
    for (let i = 0; i < 2600; i++) {
      const x0 = r() * size;
      const y0 = r() * size;
      const a = r() * Math.PI * 2;
      const len = 4 + r() * 10;
      const k = 0.35 + r() * 0.65;
      for (let s = 0; s < len; s += 0.5) {
        const x = Math.floor(x0 + Math.cos(a) * s + size) % size;
        const y = Math.floor(y0 + Math.sin(a) * s + size) % size;
        h[y * size + x] += k;
      }
    }
    // Low-frequency mottle.
    const m = new Float32Array(size * size);
    for (let i = 0; i < 90; i++) {
      const cx = r() * size;
      const cy = r() * size;
      const rad = 10 + r() * 30;
      const k = r() - 0.5;
      for (let y = -rad; y <= rad; y++)
        for (let x = -rad; x <= rad; x++) {
          const d = Math.hypot(x, y) / rad;
          if (d > 1) continue;
          const xx = Math.floor(cx + x + size) % size;
          const yy = Math.floor(cy + y + size) % size;
          m[yy * size + xx] += k * (1 - d * d);
        }
    }
    for (let i = 0; i < size * size; i++) {
      data[i * 4] = Math.round(Math.min(1, h[i] * 0.55) * 255);
      data[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, 0.5 + m[i] * 0.5)) * 255);
      data[i * 4 + 2] = 0;
      data[i * 4 + 3] = 255;
    }
  });
}

/** Canvas weave for bucket hats and bandanas. R = height. */
export function weaveTexture(): THREE.Texture {
  return dataTexture("weave", 64, (data, size) => {
    const n = 8;
    const cw = size / n;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = Math.floor(x / cw);
        const j = Math.floor(y / cw);
        const fx = (x % cw) / cw;
        const fy = (y % cw) / cw;
        const over = (i + j) % 2 === 0;
        const hx = Math.sin(fx * Math.PI);
        const hy = Math.sin(fy * Math.PI);
        const v = over ? 0.5 + 0.5 * hy * (0.6 + 0.4 * hx) : 0.5 + 0.5 * hx * (0.6 + 0.4 * hy);
        const o = (y * size + x) * 4;
        data[o] = Math.round(v * 255);
        data[o + 1] = 128;
        data[o + 2] = 0;
        data[o + 3] = 255;
      }
  });
}

/** Satin stitch for embroidered eyes and features: parallel threads. R = height. */
export function stitchTexture(): THREE.Texture {
  return dataTexture("stitch", 64, (data, size) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const t = ((x + y * 0.35) / size) * 10;
        const f = t - Math.floor(t);
        const v = Math.pow(Math.sin(f * Math.PI), 0.7);
        const o = (y * size + x) * 4;
        data[o] = Math.round(v * 255);
        data[o + 1] = 128;
        data[o + 2] = 0;
        data[o + 3] = 255;
      }
  });
}

let heartGeo: THREE.BufferGeometry | null = null;
/** A soft, puffy heart (for the happy reaction). */
export function heartGeometry(): THREE.BufferGeometry {
  if (heartGeo) return heartGeo;
  const s = new THREE.Shape();
  s.moveTo(0, -0.42);
  s.bezierCurveTo(-0.08, -0.34, -0.5, -0.06, -0.5, 0.18);
  s.bezierCurveTo(-0.5, 0.42, -0.26, 0.52, -0.12, 0.46);
  s.bezierCurveTo(-0.04, 0.43, 0, 0.36, 0, 0.3);
  s.bezierCurveTo(0, 0.36, 0.04, 0.43, 0.12, 0.46);
  s.bezierCurveTo(0.26, 0.52, 0.5, 0.42, 0.5, 0.18);
  s.bezierCurveTo(0.5, -0.06, 0.08, -0.34, 0, -0.42);
  const g = new THREE.ExtrudeGeometry(s, { depth: 0.16, bevelEnabled: true, bevelThickness: 0.12, bevelSize: 0.1, bevelSegments: 5, curveSegments: 16 });
  g.center();
  g.computeVertexNormals();
  heartGeo = g;
  return g;
}

/* ——————————————————————————— Shared GLSL ——————————————————————————— */

/*
 * The albedo function every body material shares. Object space: the body
 * rests on y = uBounds.x, its top at uBounds.y.
 */
const ALBEDO_GLSL = /* glsl */ `
uniform vec3 uBase;
uniform vec3 uPat;
uniform int uPatKind;
uniform float uPatScale;
uniform float uPatSeed;
uniform sampler2D uImage;
uniform vec4 uImageBox;
uniform float uImageTint;
uniform vec4 uBlush0;
uniform vec4 uBlush1;
uniform vec3 uBlushCol;
uniform float uDesat;
uniform vec4 uBounds;
varying vec3 vJP;
varying vec3 vJN;

vec3 jcHash3(vec3 p) {
  p = vec3(dot(p, vec3(127.1, 311.7, 74.7)), dot(p, vec3(269.5, 183.3, 246.1)), dot(p, vec3(113.5, 271.9, 124.6)));
  return fract(sin(p) * 43758.5453123);
}
float jcSpots(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  float best = 9.0;
  float rad = 0.0;
  for (int z = -1; z <= 1; z++)
  for (int y = -1; y <= 1; y++)
  for (int x = -1; x <= 1; x++) {
    vec3 g = vec3(float(x), float(y), float(z));
    vec3 h = jcHash3(i + g + uPatSeed);
    vec3 o = g + 0.2 + h * 0.6 - f;
    float d = length(o);
    if (d < best) { best = d; rad = 0.22 + 0.16 * h.x; }
  }
  return best - rad;
}
vec3 jcAlbedo(vec3 p, vec3 n) {
  vec3 col = uBase;
  float h = uBounds.y - uBounds.x;
  float fy = (p.y - uBounds.x) / h;
  float ang = atan(p.x, p.z);
  if (uPatKind == 1) {
    // Two-tone: the lower part dipped in the second colour, with a soft wave.
    float edge = mix(0.3, 0.55, uPatScale) + 0.035 * sin(ang * 3.0 + uPatSeed);
    col = mix(uPat, col, smoothstep(edge - 0.012, edge + 0.012, fy));
  } else if (uPatKind == 2) {
    // Belly: an oval on the front.
    vec2 q = vec2(p.x / (uBounds.z * mix(0.42, 0.62, uPatScale)), (fy - 0.3) / mix(0.2, 0.3, uPatScale));
    float front = smoothstep(0.0, 0.25, n.z);
    col = mix(col, uPat, (1.0 - smoothstep(0.94, 1.02, length(q))) * front);
  } else if (uPatKind == 3) {
    float s = jcSpots(p * mix(4.6, 2.4, uPatScale));
    col = mix(uPat, col, smoothstep(-0.015, 0.015, s));
  } else if (uPatKind == 4) {
    float rows = floor(mix(9.0, 4.0, uPatScale));
    float t = fy * rows + 0.04 * sin(ang * 2.0 + uPatSeed);
    col = mix(col, uPat, smoothstep(0.47, 0.53, abs(fract(t) - 0.5) * 2.0));
  } else if (uPatKind == 5) {
    vec2 uv = vec2((p.x - uImageBox.x) / uImageBox.z, (p.y - uImageBox.y) / uImageBox.w);
    vec3 img = texture2D(uImage, clamp(uv, 0.001, 0.999)).rgb;
    float l = dot(img, vec3(0.2126, 0.7152, 0.0722));
    vec3 tinted = mix(img, uBase * (0.5 + l * 1.2), uImageTint);
    float front = smoothstep(-0.35, 0.25, n.z);
    col = mix(col, tinted, front);
  }
  // Cheeks.
  float b0 = 1.0 - smoothstep(uBlush0.w * 0.35, uBlush0.w, distance(p, uBlush0.xyz));
  float b1 = 1.0 - smoothstep(uBlush1.w * 0.35, uBlush1.w, distance(p, uBlush1.xyz));
  col = mix(col, uBlushCol, max(b0, b1) * 0.7);
  return col;
}
vec3 jcDesat(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  return mix(c, vec3(l) * 1.02, uDesat);
}
`;

/** Derivative bump (no tangents needed): perturb the view-space normal by a height field H. */
const BUMP_GLSL = /* glsl */ `
vec3 jcBump(vec3 nrm, float H, float fd) {
  vec3 sX = dFdx(-vViewPosition);
  vec3 sY = dFdy(-vViewPosition);
  vec3 R1 = cross(sY, nrm);
  vec3 R2 = cross(nrm, sX);
  float det = dot(sX, R1) * fd;
  vec2 dH = vec2(dFdx(H), dFdy(H));
  vec3 g = sign(det) * (dH.x * R1 + dH.y * R2);
  return normalize(abs(det) * nrm - g);
}
`;

export interface AlbedoUniforms {
  uBase: { value: THREE.Color };
  uPat: { value: THREE.Color };
  uPatKind: { value: number };
  uPatScale: { value: number };
  uPatSeed: { value: number };
  uImage: { value: THREE.Texture | null };
  uImageBox: { value: THREE.Vector4 };
  uImageTint: { value: number };
  uBlush0: { value: THREE.Vector4 };
  uBlush1: { value: THREE.Vector4 };
  uBlushCol: { value: THREE.Color };
  uDesat: { value: number };
  uBounds: { value: THREE.Vector4 };
}

let blankTex: THREE.Texture | null = null;
function blank() {
  blankTex ??= new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
  blankTex.needsUpdate = true;
  return blankTex;
}

function albedoUniforms(): AlbedoUniforms {
  return {
    uBase: { value: new THREE.Color() },
    uPat: { value: new THREE.Color() },
    uPatKind: { value: 0 },
    uPatScale: { value: 0.5 },
    uPatSeed: { value: 0 },
    uImage: { value: blank() },
    uImageBox: { value: new THREE.Vector4(-1, -1, 2, 2) },
    uImageTint: { value: 0.3 },
    uBlush0: { value: new THREE.Vector4(0, -99, 0, 0.001) },
    uBlush1: { value: new THREE.Vector4(0, -99, 0, 0.001) },
    uBlushCol: { value: new THREE.Color("#f0a0a0") },
    uDesat: { value: 0 },
    uBounds: { value: new THREE.Vector4(-1, 1, 1, 1) },
  };
}

/* ——————————————————————————— Fur ——————————————————————————— */

export interface FurUniforms extends AlbedoUniforms {
  uShells: { value: number };
  uFurLen: { value: number };
  uFreq: { value: number };
  uCover: { value: number };
  uGravity: { value: number };
  uLag: { value: THREE.Vector3 };
  uStrands: { value: THREE.Texture };
  uAO: { value: number };
  uTip: { value: number };
  uFeat0: { value: THREE.Vector4 };
  uFeat1: { value: THREE.Vector4 };
  uFeat2: { value: THREE.Vector4 };
  uSquashInv: { value: THREE.Vector3 };
}

export interface FurMaterial {
  mat: THREE.MeshPhysicalMaterial;
  u: FurUniforms;
}

/**
 * The fur (and velvet flock) material, for an InstancedBufferGeometry whose
 * instances are the shells. Instance 0 is the skin (solid); instance i of N
 * sits at height h = i / (N - 1) of the fur length.
 */
export function makeFurMaterial(velvet: boolean): FurMaterial {
  const u: FurUniforms = {
    ...albedoUniforms(),
    uShells: { value: 24 },
    uFurLen: { value: 0.07 },
    uFreq: { value: 2.2 },
    uCover: { value: 0.8 },
    uGravity: { value: 0.35 },
    uLag: { value: new THREE.Vector3() },
    uStrands: { value: strandTexture() },
    uAO: { value: 0.42 },
    uTip: { value: 0.12 },
    uFeat0: { value: new THREE.Vector4(0, -99, 0, 0.001) },
    uFeat1: { value: new THREE.Vector4(0, -99, 0, 0.001) },
    uFeat2: { value: new THREE.Vector4(0, -99, 0, 0.001) },
    uSquashInv: { value: new THREE.Vector3(1, 1, 1) },
  };
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    sheen: velvet ? 1 : 0.85,
    sheenRoughness: velvet ? 0.32 : 0.46,
    sheenColor: new THREE.Color(1, 1, 1),
    // Shells blend inner to outer (instances draw in order) with premultiplied "over":
    // the skin is opaque, each shell adds fibre, and the silhouette's fuzz fades into
    // whatever the page is. Depth is tested but not written, so the opaque parts drawn
    // first (eyes, accessories) stay in front where they are in front.
    transparent: true,
    premultipliedAlpha: true,
    depthWrite: false,
    side: THREE.FrontSide,
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
uniform float uShells;
uniform float uFurLen;
uniform float uGravity;
uniform vec3 uLag;
uniform vec3 uSquashInv;
varying vec3 vJP;
varying vec3 vJN;
varying float vJH;`,
      )
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
float jcH = float(gl_InstanceID) / max(1.0, uShells - 1.0);
vJH = jcH;
vJP = position;
vJN = normal;
float jcL = uFurLen * jcH;
// Out along the normal; gravity and the rig's lag bend the upper part of each fibre.
transformed += normal * jcL;
vec3 jcBend = vec3(0.0, -uGravity, 0.0) + uLag;
transformed += jcBend * (jcH * jcH) * uFurLen * 1.6 * uSquashInv;`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
${ALBEDO_GLSL}
uniform float uFreq;
uniform float uCover;
uniform sampler2D uStrands;
uniform float uAO;
uniform float uTip;
uniform vec4 uFeat0;
uniform vec4 uFeat1;
uniform vec4 uFeat2;
varying float vJH;
float jcStrand(vec2 uv, float h, out float tone) {
  vec4 s = texture2D(uStrands, uv);
  tone = s.b;
  float len = s.r;
  float rad = mix(1.0, 0.18, clamp(h / len, 0.0, 1.0)) * uCover;
  return (1.0 - smoothstep(rad - 0.12, rad + 0.04, s.g)) * step(h, len);
}`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
float jcTone = 0.5;
float jcAlpha = 1.0;
{
  // Features (eyes, mouth) sit in the fur: it parts around them.
  float m0 = smoothstep(uFeat0.w * 0.92, uFeat0.w * 1.45, distance(vJP, uFeat0.xyz));
  float m1 = smoothstep(uFeat1.w * 0.92, uFeat1.w * 1.45, distance(vJP, uFeat1.xyz));
  float m2 = smoothstep(uFeat2.w * 0.8, uFeat2.w * 1.3, distance(vJP, uFeat2.xyz));
  float room = min(m0, min(m1, m2));
  float h = vJH / max(0.05, room);
  vec3 w = pow(abs(normalize(vJN)), vec3(4.0));
  w /= (w.x + w.y + w.z);
  vec3 P = vJP * uFreq;
  float t0; float t1; float t2;
  float a = jcStrand(P.zy, h, t0) * w.x + jcStrand(P.xz + 0.37, h, t1) * w.y + jcStrand(P.xy + 0.71, h, t2) * w.z;
  jcTone = t0 * w.x + t1 * w.y + t2 * w.z;
  jcAlpha = vJH < 0.001 ? 1.0 : a;
}
vec3 jcCol = jcAlbedo(vJP, normalize(vJN));
// Fibres vary a little in tone; deep in the pile it is darker (self-occlusion), tips are a touch lighter.
jcCol *= mix(0.88, 1.08, jcTone);
float jcOcc = mix(uAO, 1.0, pow(vJH, 0.7));
jcCol *= jcOcc * (1.0 + uTip * smoothstep(0.6, 1.0, vJH));
diffuseColor.rgb = jcDesat(jcCol);
diffuseColor.a = jcAlpha;
if (jcAlpha < 0.01) discard;`,
      );
  };
  mat.customProgramCacheKey = () => (velvet ? "jc-fur-velvet-1" : "jc-fur-1");
  return { mat, u };
}

/* ——————————————————————————— Solid body ——————————————————————————— */

export type SolidKind = "knit" | "felt" | "vinyl" | "ceramic";

export interface SolidUniforms extends AlbedoUniforms {
  uBumpTex: { value: THREE.Texture };
  uBumpK: { value: number };
  uGroove: { value: number };
  uKnitCols: { value: number };
  uKnitRows: { value: number };
  uSpeckle: { value: number };
}

export interface SolidMaterial {
  mat: THREE.MeshPhysicalMaterial;
  u: SolidUniforms;
  base: { roughness: number; clearcoat: number; sheen: number };
}

const SOLID_SPEC: Record<SolidKind, { roughness: number; clearcoat: number; clearcoatRoughness: number; sheen: number; sheenRoughness: number; bump: number }> = {
  knit: { roughness: 0.95, clearcoat: 0, clearcoatRoughness: 0.5, sheen: 0.6, sheenRoughness: 0.5, bump: 0.022 },
  felt: { roughness: 1, clearcoat: 0, clearcoatRoughness: 0.5, sheen: 0.7, sheenRoughness: 0.55, bump: 0.006 },
  vinyl: { roughness: 0.42, clearcoat: 0.35, clearcoatRoughness: 0.32, sheen: 0, sheenRoughness: 0.5, bump: 0.0015 },
  ceramic: { roughness: 0.62, clearcoat: 0.12, clearcoatRoughness: 0.55, sheen: 0, sheenRoughness: 0.5, bump: 0.0022 },
};

export function makeSolidMaterial(kind: SolidKind): SolidMaterial {
  const spec = SOLID_SPEC[kind];
  const u: SolidUniforms = {
    ...albedoUniforms(),
    uBumpTex: { value: kind === "knit" ? knitTexture() : feltTexture() },
    uBumpK: { value: spec.bump },
    uGroove: { value: kind === "knit" ? 0.3 : kind === "felt" ? 0.08 : 0 },
    uKnitCols: { value: 24 },
    uKnitRows: { value: 10 },
    uSpeckle: { value: kind === "ceramic" ? 1 : 0 },
  };
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    roughness: spec.roughness,
    metalness: 0,
    clearcoat: Math.max(1e-4, spec.clearcoat),
    clearcoatRoughness: spec.clearcoatRoughness,
    sheen: Math.max(1e-4, spec.sheen),
    sheenRoughness: spec.sheenRoughness,
    sheenColor: new THREE.Color(1, 1, 1),
  });
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vJP;\nvarying vec3 vJN;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvJP = position;\nvJN = normal;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        /* glsl */ `#include <common>
${ALBEDO_GLSL}
uniform sampler2D uBumpTex;
uniform float uBumpK;
uniform float uGroove;
uniform float uKnitCols;
uniform float uKnitRows;
uniform float uSpeckle;
float jcHeight = 0.0;
float jcMottle = 0.5;
${BUMP_GLSL}`,
      )
      .replace(
        "#include <color_fragment>",
        /* glsl */ `#include <color_fragment>
{
  vec3 n0 = normalize(vJN);
  ${
    kind === "knit"
      ? `// Stitches wrap around the body; Tarini's two lookups hide the seam.
  float a = atan(vJP.x, vJP.z) / 6.28318530718;
  float a1 = fract(a);
  float a2 = fract(a + 0.5);
  float ua = fwidth(a1) <= fwidth(a2) + 1e-5 ? a1 : a2;
  vec2 uv = vec2(ua * uKnitCols * 0.25, (vJP.y - uBounds.x) * uKnitRows * 0.25);
  vec4 t = texture2D(uBumpTex, uv);
  // Fade the stitches out as they approach the pixel size (no moire at small sizes).
  float fade = 1.0 - smoothstep(0.08, 0.2, max(fwidth(uv.x), fwidth(uv.y)));
  jcHeight = t.r * fade;
  jcMottle = mix(0.5, 1.0 - t.g, fade);`
      : `vec3 w = pow(abs(n0), vec3(4.0));
  w /= (w.x + w.y + w.z);
  vec3 P = vJP * 1.6;
  vec4 t = texture2D(uBumpTex, P.zy) * w.x + texture2D(uBumpTex, P.xz) * w.y + texture2D(uBumpTex, P.xy) * w.z;
  jcHeight = t.r;
  jcMottle = t.g;`
  }
  vec3 col = jcAlbedo(vJP, n0);
  col *= 1.0 - uGroove * (${kind === "knit" ? "jcMottle" : "(1.0 - jcHeight) * 0.6 + (jcMottle - 0.5) * 0.5"});
  if (uSpeckle > 0.0) {
    vec3 h = jcHash3(floor(vJP * 90.0));
    col = mix(col, col * 0.45, step(0.985, h.x));
  }
  diffuseColor.rgb = jcDesat(col);
}`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        /* glsl */ `#include <normal_fragment_maps>
normal = jcBump(normal, jcHeight * uBumpK, faceDirection);`,
      );
  };
  mat.customProgramCacheKey = () => `jc-solid-${kind}-1`;
  return { mat, u, base: { roughness: spec.roughness, clearcoat: spec.clearcoat, sheen: spec.sheen } };
}

/* ——————————————————————————— Accessory materials ——————————————————————————— */

export type AccMaterialKind = "felt" | "knit" | "canvas" | "velvet" | "vinyl" | "metal" | "acetate" | "thread" | "lens" | "gloss";

export interface AccMaterial {
  mat: THREE.MeshPhysicalMaterial;
  desat: { value: number };
}

/**
 * A material for an accessory part. Soft goods get a triplanar bump of their
 * own texture; hard goods are plain physical materials. Every accessory
 * desaturates with the body (offline).
 */
export function makeAccMaterial(kind: AccMaterialKind, color: THREE.ColorRepresentation, scale = 1): AccMaterial {
  const desat = { value: 0 };
  const c = new THREE.Color(color);
  let mat: THREE.MeshPhysicalMaterial;
  switch (kind) {
    case "metal":
      mat = new THREE.MeshPhysicalMaterial({ color: c, metalness: 1, roughness: 0.28, clearcoat: 1e-4 });
      break;
    case "acetate":
      mat = new THREE.MeshPhysicalMaterial({ color: c, metalness: 0, roughness: 0.22, clearcoat: 1, clearcoatRoughness: 0.08 });
      break;
    case "gloss":
      mat = new THREE.MeshPhysicalMaterial({ color: c, metalness: 0, roughness: 0.12, clearcoat: 1, clearcoatRoughness: 0.04 });
      break;
    case "lens":
      mat = new THREE.MeshPhysicalMaterial({ color: c, metalness: 0, roughness: 0.06, clearcoat: 1, clearcoatRoughness: 0.02, transparent: true, opacity: 0.88 });
      break;
    case "vinyl":
      mat = new THREE.MeshPhysicalMaterial({ color: c, metalness: 0, roughness: 0.4, clearcoat: 0.4, clearcoatRoughness: 0.3 });
      break;
    case "velvet":
      mat = new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.9, sheen: 1, sheenRoughness: 0.3, sheenColor: new THREE.Color(1, 1, 1).lerp(c, 0.3), clearcoat: 1e-4 });
      break;
    case "thread":
      mat = new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.75, sheen: 0.4, sheenRoughness: 0.4, clearcoat: 1e-4 });
      break;
    default:
      mat = new THREE.MeshPhysicalMaterial({ color: c, roughness: kind === "canvas" ? 0.92 : 1, sheen: kind === "canvas" ? 0.2 : 0.65, sheenRoughness: 0.5, clearcoat: 1e-4 });
  }
  const bumpTex = kind === "knit" ? knitTexture() : kind === "felt" || kind === "velvet" ? feltTexture() : kind === "canvas" ? weaveTexture() : kind === "thread" ? stitchTexture() : null;
  // Relief height in body units.
  const bumpK = kind === "knit" ? 0.012 : kind === "canvas" ? 0.0035 : kind === "thread" ? 0.003 : kind === "felt" ? 0.0028 : kind === "velvet" ? 0.001 : 0;
  const freq = (kind === "knit" ? 7 : kind === "canvas" ? 9 : kind === "thread" ? 14 : 3) * scale;
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uDesat = desat;
    if (bumpTex) shader.uniforms.uBumpTex = { value: bumpTex };
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vJP;\nvarying vec3 vJN;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvJP = position;\nvJN = normal;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uDesat;
varying vec3 vJP;
varying vec3 vJN;
${bumpTex ? `uniform sampler2D uBumpTex;\nfloat jcHeight = 0.0;\n${BUMP_GLSL}` : ""}`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
${
  bumpTex
    ? `{
  vec3 w = pow(abs(normalize(vJN)), vec3(4.0));
  w /= (w.x + w.y + w.z);
  vec3 P = vJP * ${freq.toFixed(2)};
  vec4 t = texture2D(uBumpTex, P.zy) * w.x + texture2D(uBumpTex, P.xz) * w.y + texture2D(uBumpTex, P.xy) * w.z;
  jcHeight = t.r;
  ${kind === "knit" ? "diffuseColor.rgb *= 1.0 - 0.28 * (1.0 - t.g);" : kind === "felt" ? "diffuseColor.rgb *= 0.94 + 0.12 * t.g;" : ""}
}`
    : ""
}
{
  float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(l) * 1.02, uDesat);
}`,
      );
    if (bumpTex)
      shader.fragmentShader = shader.fragmentShader.replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
normal = jcBump(normal, jcHeight * ${(bumpK / Math.max(0.2, scale)).toFixed(5)}, faceDirection);`,
      );
  };
  mat.customProgramCacheKey = () => `jc-acc-${kind}-${freq.toFixed(2)}-${bumpK}`;
  return { mat, desat };
}
