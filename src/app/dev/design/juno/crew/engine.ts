/**
 * The crew renderer: one WebGLRenderer for every face on the page.
 *
 * Loaded lazily (face.tsx imports it with a dynamic import), so a page pays
 * for three.js only when it shows a face and no cached sprite covers it.
 *
 *   ONE CONTEXT. A single offscreen WebGL canvas. Faces are drawn into
 *   regions of it with viewport and scissor (the three.js "multiple
 *   elements" technique) and each region is copied into the face's own 2D
 *   canvas or cached image in the same frame. The page therefore composites
 *   faces like any other image: they scroll with the compositor, sit under
 *   sheets and popovers, clip inside scrollers, and cost nothing while still.
 *   (A fixed overlay canvas would have to redraw on every scroll frame and
 *   still trail the page by a frame, and it would paint over menus.)
 *
 *   SPRITES (<= 28 px: sidebar rows, tokens, bylines). Rendered once per
 *   (config, state, size, pixel ratio, theme, facing) at twice the device
 *   resolution and downsampled, then cached in memory and in localStorage,
 *   so a returning visit shows every small face without loading three.js.
 *
 *   LIVE VIEWS (>= 32 px: thread header, roster, profile, editor). Rendered
 *   on demand only: a frame is drawn when a spring is moving (a state change,
 *   the pointer's gaze, a blink, an arrival, a drag) and the loop stops when
 *   everything has settled. Offscreen views (IntersectionObserver) and hidden
 *   tabs (requestAnimationFrame) do no work. The one sanctioned loop
 *   (thinking/working in the focused context) draws at 30 fps, because its
 *   motion is slower than the eye can tell apart at 60.
 */

import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { avatarKey, effectiveTexture, FAMILY, formKey, type AvatarConfig } from "./avatar";
import { eyePlacement, formParams, surfaceNormal, surfacePoint, type FormParams } from "./forms";
import { Rig, restingPose, type CrewState, type Facing, type Pose } from "./rig";
import { imageTexture, imageTextureSync, proceduralTexture, TEXTURE_SCALE, type TextureId } from "./textures";
import { prefersReduced, readStore, resolveTheme, spriteDpr, spriteKey, writeStore, type Theme } from "./sprite-store";

export type { Theme };

/* ——————————————————————————— Look ——————————————————————————— */

/** Camera and light, per theme. Dark is its own lighting, not a darker copy. */
const LOOK = {
  light: { exposure: 0.96, env: 0.46, key: 2.7, keyColor: 0xfff7ef, rim: 1.1, rimColor: 0xffffff, shadow: 0.95 },
  dark: { exposure: 0.92, env: 0.4, key: 2.5, keyColor: 0xfff5ec, rim: 1.9, rimColor: 0xdfe6ff, shadow: 1 },
} as const;

const FOV = 20;
const CAM_DIST = 8.3;
const CAM_HEIGHT = 1.35;
const LOOK_AT_Y = -0.14;

/** Optical compensation for small faces: bigger eyes, a closer camera, a lighter shadow. */
function smallTuning(size: number) {
  if (size <= 16) return { eye: 1.72, zoom: 1.13, shadow: 0.55, detail: 20 };
  if (size <= 20) return { eye: 1.56, zoom: 1.1, shadow: 0.65, detail: 22 };
  if (size <= 28) return { eye: 1.32, zoom: 1.06, shadow: 0.8, detail: 26 };
  if (size <= 48) return { eye: 1.14, zoom: 1, shadow: 1, detail: 32 };
  if (size <= 72) return { eye: 1.06, zoom: 1, shadow: 1, detail: 32 };
  return { eye: 1, zoom: 1, shadow: 1, detail: 48 };
}

/* ——————————————————————————— Geometry ——————————————————————————— */

const geoCache = new Map<string, THREE.BufferGeometry>();

/**
 * A body mesh: a subdivided cube, welded, pushed out to the direction sphere
 * (the "spherified cube", which spreads vertices evenly without poles), then
 * each vertex moved onto the form's surface along its direction.
 */
function bodyGeometry(f: FormParams, key: string, detail: number): THREE.BufferGeometry {
  const k = `${key}|${detail}`;
  const hit = geoCache.get(k);
  if (hit) return hit;
  let g: THREE.BufferGeometry = new THREE.BoxGeometry(2, 2, 2, detail, detail, detail);
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  g = mergeVertices(g);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const p: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const sx = x * Math.sqrt(1 - (y * y) / 2 - (z * z) / 2 + (y * y * z * z) / 3);
    const sy = y * Math.sqrt(1 - (z * z) / 2 - (x * x) / 2 + (z * z * x * x) / 3);
    const sz = z * Math.sqrt(1 - (x * x) / 2 - (y * y) / 2 + (x * x * y * y) / 3);
    surfacePoint(f, sx, sy, sz, p);
    pos.setXYZ(i, p[0], p[1], p[2]);
  }
  g.computeVertexNormals();
  addTangents(g);
  g.computeBoundingSphere();
  if (geoCache.size > 120) {
    const first = geoCache.keys().next().value;
    if (first) {
      geoCache.get(first)?.dispose();
      geoCache.delete(first);
    }
  }
  geoCache.set(k, g);
  return g;
}

/** Tangents that run around the vertical axis, so anisotropic metal reads as lathe-turned. */
function addTangents(g: THREE.BufferGeometry) {
  const n = g.attributes.normal as THREE.BufferAttribute;
  const t = new Float32Array(n.count * 4);
  for (let i = 0; i < n.count; i++) {
    const nx = n.getX(i);
    const nz = n.getZ(i);
    // cross((0,1,0), n) = (nz, 0, -nx)
    let tx = nz;
    let tz = -nx;
    const l = Math.hypot(tx, tz);
    if (l < 1e-4) {
      tx = 1;
      tz = 0;
    } else {
      tx /= l;
      tz /= l;
    }
    t[i * 4] = tx;
    t[i * 4 + 1] = 0;
    t[i * 4 + 2] = tz;
    t[i * 4 + 3] = 1;
  }
  g.setAttribute("tangent", new THREE.BufferAttribute(t, 4));
}

let shadowTex: THREE.Texture | null = null;
/** The contact shadow: a wide soft falloff plus a tight core where the body meets the ground. */
function shadowTexture() {
  if (shadowTex) return shadowTex;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  const wide = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  wide.addColorStop(0, "rgba(0,0,0,0.34)");
  wide.addColorStop(0.45, "rgba(0,0,0,0.16)");
  wide.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = wide;
  ctx.fillRect(0, 0, 256, 256);
  const core = ctx.createRadialGradient(128, 128, 0, 128, 128, 58);
  core.addColorStop(0, "rgba(0,0,0,0.5)");
  core.addColorStop(0.6, "rgba(0,0,0,0.18)");
  core.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, 256, 256);
  shadowTex = new THREE.CanvasTexture(c);
  shadowTex.colorSpace = THREE.NoColorSpace;
  return shadowTex;
}

/* ——————————————————————————— Materials ——————————————————————————— */

const texCache = new Map<string, THREE.Texture>();

function canvasTexture(key: string, canvas: HTMLCanvasElement, mirrored: boolean) {
  let t = texCache.get(key);
  if (!t) {
    t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = mirrored ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
    t.anisotropy = 4;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    if (texCache.size > 48) {
      const first = texCache.keys().next().value;
      if (first) {
        texCache.get(first)?.dispose();
        texCache.delete(first);
      }
    }
    texCache.set(key, t);
  }
  return t;
}

interface BodyUniforms {
  uDesat: { value: number };
  uTriMap: { value: THREE.Texture | null };
  uTriScale: { value: number };
  uTriSharp: { value: number };
  uTriOffset: { value: THREE.Vector2 };
  uEyeC0: { value: THREE.Vector3 };
  uEyeC1: { value: THREE.Vector3 };
  uEyeX0: { value: THREE.Vector3 };
  uEyeX1: { value: THREE.Vector3 };
  uEyeY0: { value: THREE.Vector3 };
  uEyeY1: { value: THREE.Vector3 };
  uEyeR: { value: number };
  uEyeL: { value: number };
  uEyeOpen: { value: number };
  uEyeRound: { value: number };
  uEyeCol: { value: THREE.Color };
  uEyeBody: { value: THREE.Color };
  uEyeOn: { value: number };
  uEyeGlow: { value: number };
  uEyeRough: { value: number };
  uEyeDepth: { value: number };
  uEyeWall: { value: number };
  uEyeBezel: { value: THREE.Color };
  uEyeBezelK: { value: number };
}

/*
 * The eyes are carved into the body, not stuck on it. In the body's own
 * shader, each eye is a capsule described by a signed distance on the
 * surface: inside it the glaze becomes the eye's colour (a dark enamel inlay,
 * or a warm light for lit eyes), and a height field around its edge bends the
 * normal so the upper wall falls into shadow and the lower lip catches the
 * key light, exactly as a slot cut into a stone would. It is resolution
 * independent (crisp at 20 px and at 256 px), blinks and gazes by changing
 * uniforms, and never recompiles.
 */
const EYE_GLSL = `
uniform vec3 uEyeC0; uniform vec3 uEyeC1;
uniform vec3 uEyeX0; uniform vec3 uEyeX1;
uniform vec3 uEyeY0; uniform vec3 uEyeY1;
uniform float uEyeR; uniform float uEyeL; uniform float uEyeOpen; uniform float uEyeRound;
uniform vec3 uEyeCol; uniform vec3 uEyeBody; uniform float uEyeOn; uniform float uEyeGlow; uniform float uEyeRough;
uniform float uEyeDepth; uniform float uEyeWall; uniform vec3 uEyeBezel; uniform float uEyeBezelK;
float jcEyeSd(vec3 p, vec3 c, vec3 ax, vec3 ay) {
  vec3 d = p - c;
  vec3 nrm = cross(ax, ay);
  if (abs(dot(d, nrm)) > uEyeR * 3.0) return 1.0;
  float u = dot(d, ax);
  float v = dot(d, ay);
  float o = clamp(uEyeOpen, 0.0, 1.3);
  float sy = mix(0.16, 1.0, min(o, 1.0)) * max(o, 1.0);
  float wid = uEyeR * (1.0 + (1.0 - min(o, 1.0)) * 0.38);
  float hl = uEyeL * 0.5 * (1.0 - uEyeRound);
  vec2 q = vec2(u, max(abs(v / sy) - hl, 0.0));
  return (length(q) - wid) * mix(sy, 1.0, 0.5);
}
`;

function patchBody(mat: THREE.MeshPhysicalMaterial, triplanar: boolean): BodyUniforms {
  const u: BodyUniforms = {
    uDesat: { value: 0 },
    uTriMap: { value: null },
    uTriScale: { value: 0.4 },
    uTriSharp: { value: 4 },
    uTriOffset: { value: new THREE.Vector2(0.5, 0.5) },
    uEyeC0: { value: new THREE.Vector3() },
    uEyeC1: { value: new THREE.Vector3() },
    uEyeX0: { value: new THREE.Vector3(1, 0, 0) },
    uEyeX1: { value: new THREE.Vector3(1, 0, 0) },
    uEyeY0: { value: new THREE.Vector3(0, 1, 0) },
    uEyeY1: { value: new THREE.Vector3(0, 1, 0) },
    uEyeR: { value: 0.07 },
    uEyeL: { value: 0.08 },
    uEyeOpen: { value: 1 },
    uEyeRound: { value: 0 },
    uEyeCol: { value: new THREE.Color() },
    uEyeBody: { value: new THREE.Color() },
    uEyeOn: { value: 1 },
    uEyeGlow: { value: 0 },
    uEyeRough: { value: 0.24 },
    uEyeDepth: { value: 0.04 },
    uEyeWall: { value: 0.035 },
    uEyeBezel: { value: new THREE.Color("#1d1e21") },
    uEyeBezelK: { value: 0 },
  };
  const transmission = THREE.ShaderChunk.transmission_fragment.replace("material.transmission = transmission;", "material.transmission = transmission * (1.0 - jcMask);");
  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vJcPos;\nvarying vec3 vJcNrm;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvJcPos = position;\nvJcNrm = normal;");
    shader.fragmentShader = shader.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
uniform float uDesat;
uniform sampler2D uTriMap;
uniform float uTriScale;
uniform float uTriSharp;
uniform vec2 uTriOffset;
varying vec3 vJcPos;
varying vec3 vJcNrm;
${EYE_GLSL}`,
      )
      .replace(
        "#include <map_fragment>",
        `#include <map_fragment>
${
  triplanar
    ? `{
  vec3 tw = pow(abs(normalize(vJcNrm)), vec3(uTriSharp));
  tw /= (tw.x + tw.y + tw.z);
  vec4 tX = texture2D(uTriMap, vec2(vJcPos.z * sign(vJcNrm.x), vJcPos.y) * uTriScale + uTriOffset);
  vec4 tY = texture2D(uTriMap, vec2(vJcPos.x, vJcPos.z * sign(vJcNrm.y)) * uTriScale + uTriOffset);
  vec4 tZ = texture2D(uTriMap, vec2(vJcPos.x * sign(vJcNrm.z), vJcPos.y) * uTriScale + uTriOffset);
  diffuseColor.rgb *= (tX * tw.x + tY * tw.y + tZ * tw.z).rgb;
}`
    : ""
}
float jcSd = min(jcEyeSd(vJcPos, uEyeC0, uEyeX0, uEyeY0), jcEyeSd(vJcPos, uEyeC1, uEyeX1, uEyeY1));
float jcAA = max(fwidth(jcSd), 1e-6) * 0.75;
float jcMask = 1.0 - smoothstep(-jcAA, jcAA, jcSd);
float jcH = -uEyeDepth * 0.8 * (1.0 - smoothstep(-uEyeWall, 0.0, jcSd)) - uEyeDepth * 0.2 * (1.0 - smoothstep(0.0, uEyeWall * 0.7, jcSd));
vec3 jcFloor = mix(uEyeBody, uEyeCol, uEyeOn);
// Lit eyes sit behind a thin dark bezel, so the light reads on a pale glaze too.
jcFloor = mix(jcFloor, uEyeBezel, uEyeBezelK * smoothstep(-uEyeWall * 0.62, -uEyeWall * 0.36, jcSd));
diffuseColor.rgb = mix(diffuseColor.rgb, jcFloor, jcMask);
diffuseColor.rgb = mix(diffuseColor.rgb, vec3(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722))) * 1.04, uDesat);`,
      )
      .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, uEyeRough, jcMask);")
      .replace("#include <metalnessmap_fragment>", "#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.0, jcMask);")
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
{
  vec3 sX = dFdx(-vViewPosition);
  vec3 sY = dFdy(-vViewPosition);
  vec3 R1 = cross(sY, normal);
  vec3 R2 = cross(normal, sX);
  float det = dot(sX, R1) * faceDirection;
  vec2 dH = vec2(dFdx(jcH), dFdy(jcH));
  vec3 g = sign(det) * (dH.x * R1 + dH.y * R2);
  normal = normalize(abs(det) * normal - g);
}`,
      )
      .replace("#include <emissivemap_fragment>", "#include <emissivemap_fragment>\ntotalEmissiveRadiance += uEyeCol * uEyeGlow * jcMask * (1.0 - uEyeBezelK * smoothstep(-uEyeWall * 0.62, -uEyeWall * 0.36, jcSd));")
      .replace("#include <transmission_fragment>", transmission);
  };
  mat.customProgramCacheKey = () => (triplanar ? "jc-body-tri-3" : "jc-body-3");
  return u;
}

interface BodyMaterial {
  mat: THREE.MeshPhysicalMaterial;
  u: BodyUniforms;
  base: { roughness: number; clearcoat: number; color: THREE.Color };
}

const MIN = 1e-4; // keep features that change the shader (clearcoat, sheen) above zero so state changes never recompile

function makeBodyMaterial(cfg: AvatarConfig, tex: THREE.Texture | null, texScale: number, image: boolean): BodyMaterial {
  const fam = FAMILY[cfg.color];
  const color = new THREE.Color(tex ? "#ffffff" : fam.base);
  const m = new THREE.MeshPhysicalMaterial({ color });
  switch (cfg.material) {
    case "glass":
      m.color = new THREE.Color("#ffffff").lerp(new THREE.Color(fam.base), 0.12);
      m.roughness = 0.64;
      m.transmission = 1;
      m.thickness = 1.2;
      m.ior = 1.4;
      m.attenuationColor = new THREE.Color("#ffffff").lerp(new THREE.Color(fam.base), 0.6);
      m.attenuationDistance = 3.2;
      m.clearcoat = 0.7;
      m.clearcoatRoughness = 0.18;
      m.specularIntensity = 0.8;
      break;
    case "felt":
      m.roughness = 0.98;
      m.sheen = 1;
      m.sheenRoughness = 0.42;
      m.sheenColor = new THREE.Color(fam.sheen);
      m.clearcoat = MIN;
      break;
    case "stone":
      m.roughness = 0.74;
      m.clearcoat = 0.08;
      m.clearcoatRoughness = 0.55;
      break;
    case "metal":
      if (!tex) m.color = new THREE.Color(fam.metal);
      m.metalness = 1;
      m.roughness = 0.56;
      m.anisotropy = 0.55;
      m.clearcoat = MIN;
      m.envMapIntensity = 1.35;
      break;
    case "wood":
      m.roughness = 0.58;
      m.clearcoat = 0.3;
      m.clearcoatRoughness = 0.42;
      break;
    case "ceramic":
    default:
      m.roughness = 0.6;
      m.clearcoat = 0.08;
      m.clearcoatRoughness = 0.5;
  }
  const u = patchBody(m, !!tex);
  if (tex) {
    u.uTriMap.value = tex;
    u.uTriScale.value = texScale;
    u.uTriSharp.value = image ? 6 : 4;
  }
  const lit = cfg.eyes.style === "lit";
  u.uEyeCol.value.set(lit ? fam.lit : fam.eye);
  u.uEyeRough.value = lit ? 0.5 : 0.36;
  u.uEyeRound.value = cfg.eyes.style === "round" ? 1 : 0;
  u.uEyeBezelK.value = lit ? 1 : 0;
  return { mat: m, u, base: { roughness: m.roughness, clearcoat: m.clearcoat, color: m.color.clone() } };
}

/* ——————————————————————————— Model ——————————————————————————— */

const grey = new THREE.Color();

interface Morph {
  from: Float32Array;
  fromN: Float32Array;
  to: THREE.BufferGeometry;
  t0: number;
}

/** One avatar in the scene graph: shadow, then base (squash) → pivot (turn) → content. */
class Model {
  root = new THREE.Group();
  private base = new THREE.Group();
  private pivot = new THREE.Group();
  private content = new THREE.Group();
  private body: THREE.Mesh;
  private core: THREE.Mesh | null = null;
  private shadow: THREE.Mesh;
  cfg: AvatarConfig | null = null;
  key = "";
  form: FormParams | null = null;
  private bodyMat: BodyMaterial | null = null;
  private detail = 32;
  private morph: Morph | null = null;
  private working: THREE.BufferGeometry | null = null;
  private famBase = new THREE.Color();
  shadowOpacity = 1;
  /** Resolves when textures the config needs have loaded. */
  ready: Promise<void> = Promise.resolve();
  private loadToken = 0;
  onChange?: () => void;

  constructor() {
    this.body = new THREE.Mesh();
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, color: 0x000000, toneMapped: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = -1;
    this.root.add(this.shadow, this.base);
    this.base.add(this.pivot);
    this.pivot.add(this.content);
    this.content.add(this.body);
  }

  /** Configure. `morphAt` (ms) morphs from the current form instead of switching. */
  set(cfg: AvatarConfig, detail: number, morphAt?: number) {
    const key = avatarKey(cfg);
    if (key === this.key && detail === this.detail) return;
    const prev = this.cfg;
    const formChanged = !prev || formKey(prev) !== formKey(cfg) || detail !== this.detail;
    const lookChanged = !prev || avatarKey({ ...prev, shape: cfg.shape, proportions: cfg.proportions }) !== avatarKey(cfg);
    this.cfg = cfg;
    this.key = key;
    this.famBase.set(cfg.material === "metal" ? FAMILY[cfg.color].metal : cfg.material === "wood" ? FAMILY[cfg.color].wood : FAMILY[cfg.color].base);
    const f = formParams(cfg.shape, cfg.proportions);
    if (formChanged) {
      const geo = bodyGeometry(f, formKey(cfg), detail);
      if (morphAt !== undefined && this.form && detail === this.detail && this.body.geometry) {
        const cur = (this.working && this.morph ? this.working : this.body.geometry) as THREE.BufferGeometry;
        const from = new Float32Array((cur.attributes.position as THREE.BufferAttribute).array as Float32Array);
        const fromN = new Float32Array((cur.attributes.normal as THREE.BufferAttribute).array as Float32Array);
        if (from.length === (geo.attributes.position as THREE.BufferAttribute).array.length) {
          if (!this.working || (this.working.attributes.position as THREE.BufferAttribute).count !== (geo.attributes.position as THREE.BufferAttribute).count) {
            this.working?.dispose();
            this.working = geo.clone();
          }
          this.morph = { from, fromN, to: geo, t0: morphAt };
          this.body.geometry = this.working;
        } else this.body.geometry = geo;
      } else {
        this.morph = null;
        this.body.geometry = geo;
      }
      this.form = f;
      this.detail = detail;
      if (this.core) this.core.geometry = geo;
      this.shadow.scale.set(f.a * 2.5, f.c * 2.4, 1);
      this.shadow.position.y = f.ground + 0.002;
      // Pivot a little below the centre: a head on a neck, not a ball on a stick.
      this.base.position.y = f.ground;
      this.pivot.position.y = -f.ground * 0.7;
      this.content.position.y = -this.pivot.position.y - f.ground;
    }
    if (lookChanged) {
      this.bodyMat?.mat.dispose();
      const tex = effectiveTexture(cfg);
      const token = ++this.loadToken;
      const detailId: TextureId | null = cfg.material === "felt" ? "fibre" : cfg.material === "ceramic" ? "glaze" : null;
      if (tex.kind === "procedural" || (detailId && tex.kind === "none")) {
        const id: TextureId = tex.kind === "procedural" ? tex.id : detailId!;
        const seed = tex.kind === "procedural" ? (tex.seed ?? 1) : 1;
        const t = canvasTexture(`${id}|${cfg.color}|${seed}`, proceduralTexture(id, cfg.color, seed), false);
        this.bodyMat = makeBodyMaterial(cfg, t, TEXTURE_SCALE[id], false);
        this.ready = Promise.resolve();
      } else if (tex.kind === "image") {
        const tint = tex.tint ?? 0.3;
        const sync = imageTextureSync(tex.assetUrl, cfg.color, tint);
        this.bodyMat = sync ? makeBodyMaterial(cfg, canvasTexture(`img|${key}`, sync, true), 1 / (2 * f.a), true) : makeBodyMaterial(cfg, null, 1, true);
        this.ready = sync
          ? Promise.resolve()
          : imageTexture(tex.assetUrl, cfg.color, tint)
              .then((canvas) => {
                if (token !== this.loadToken || !this.cfg) return;
                const t = canvasTexture(`img|${avatarKey(this.cfg)}`, canvas, true);
                this.bodyMat?.mat.dispose();
                this.bodyMat = makeBodyMaterial(this.cfg, t, 1 / (2 * f.a), true);
                this.body.material = this.bodyMat.mat;
                this.onChange?.();
              })
              .catch(() => undefined);
      } else {
        this.bodyMat = makeBodyMaterial(cfg, null, 1, false);
        this.ready = Promise.resolve();
      }
      this.body.material = this.bodyMat.mat;
      // Frosted glass carries a softly coloured heart that the glass diffuses.
      if (cfg.material === "glass") {
        if (!this.core) {
          this.core = new THREE.Mesh(this.body.geometry, new THREE.MeshStandardMaterial({ roughness: 0.55 }));
          this.content.add(this.core);
        }
        const cm = this.core.material as THREE.MeshStandardMaterial;
        cm.color = new THREE.Color(FAMILY[cfg.color].base);
        cm.emissive = new THREE.Color(FAMILY[cfg.color].base);
        cm.emissiveIntensity = 0.22;
        this.core.scale.setScalar(0.64);
        this.core.geometry = bodyGeometry(f, formKey(cfg), detail);
      } else if (this.core) {
        this.content.remove(this.core);
        (this.core.material as THREE.Material).dispose();
        this.core = null;
      }
    }
  }

  /** Whether a shape morph is in progress. */
  morphing(now: number) {
    return !!this.morph && now - this.morph.t0 < 320;
  }

  private stepMorph(now: number) {
    const m = this.morph;
    if (!m || !this.working) return;
    const t = Math.min(1, (now - m.t0) / 280);
    const e = 1 - Math.pow(1 - t, 3);
    const pos = this.working.attributes.position as THREE.BufferAttribute;
    const nor = this.working.attributes.normal as THREE.BufferAttribute;
    const to = (m.to.attributes.position as THREE.BufferAttribute).array as Float32Array;
    const toN = (m.to.attributes.normal as THREE.BufferAttribute).array as Float32Array;
    const pa = pos.array as Float32Array;
    const na = nor.array as Float32Array;
    for (let i = 0; i < pa.length; i++) {
      pa[i] = m.from[i] + (to[i] - m.from[i]) * e;
      na[i] = m.fromN[i] + (toN[i] - m.fromN[i]) * e;
    }
    pos.needsUpdate = true;
    nor.needsUpdate = true;
    this.working.computeBoundingSphere();
    if (t >= 1) {
      this.body.geometry = m.to;
      if (this.core) this.core.geometry = m.to;
      this.morph = null;
    }
  }

  pose(p: Pose, size: number, now: number) {
    const cfg = this.cfg;
    const f = this.form;
    const bm = this.bodyMat;
    if (!cfg || !f || !bm) return;
    this.stepMorph(now);
    const tune = smallTuning(size);
    this.root.position.y = p.lift;
    this.root.scale.setScalar(p.scale);
    this.shadow.position.y = f.ground + 0.002 - p.lift;
    const lifted = Math.max(0, p.lift);
    const sm = this.shadow.material as THREE.MeshBasicMaterial;
    sm.opacity = Math.max(0, (1 - lifted * 1.6) * this.shadowOpacity * tune.shadow);
    this.shadow.scale.set(f.a * 2.5 * (1 + lifted * 0.5), f.c * 2.4 * (1 + lifted * 0.5), 1);
    this.base.scale.set(1 + (1 - p.squash) * 0.5, p.squash, 1 + (1 - p.squash) * 0.5);
    this.pivot.rotation.set(p.pitch, p.yaw, p.roll, "YXZ");

    // Eyes: positions and axes on the surface (object space), for the carved-eye shader.
    const u = bm.u;
    const ep = eyePlacement(f, cfg.eyes, tune.eye, p.eyeX, p.eyeY);
    const C = [u.uEyeC0.value, u.uEyeC1.value];
    const X = [u.uEyeX0.value, u.uEyeX1.value];
    const Y = [u.uEyeY0.value, u.uEyeY1.value];
    for (let i = 0; i < 2; i++) {
      const d = ep.dirs[i];
      const s = surfacePoint(f, d[0], d[1], d[2]);
      const n = surfaceNormal(f, d[0], d[1], d[2]);
      C[i].set(s[0], s[1], s[2]);
      // x = up × n, y = n × x: the eye stands upright on the surface.
      X[i].set(n[2], 0, -n[0]).normalize();
      Y[i].set(n[1] * X[i].z - n[2] * X[i].y, n[2] * X[i].x - n[0] * X[i].z, n[0] * X[i].y - n[1] * X[i].x).normalize();
    }
    u.uEyeR.value = ep.radius;
    u.uEyeL.value = ep.length;
    u.uEyeOpen.value = Math.max(0.06, p.eyeOpen);
    u.uEyeDepth.value = ep.radius * 0.55;
    u.uEyeWall.value = ep.radius * 0.5;
    u.uEyeOn.value = p.eyesOn;
    const lit = cfg.eyes.style === "lit";
    u.uEyeGlow.value = lit ? 1.6 * p.eyesOn * (0.5 + 0.5 * Math.min(1, p.eyeOpen)) * (1 - p.desat * 0.5) : 0;
    // Eyes out: the slot stays (identity), its floor goes back toward the glaze.
    u.uEyeBody.value.copy(this.famBase).multiplyScalar(lit ? 0.3 : 0.74);

    // Colour: desaturation and matte are uniforms; nothing here recompiles.
    u.uDesat.value = p.desat;
    bm.mat.roughness = bm.base.roughness + (0.86 - bm.base.roughness) * p.matte;
    bm.mat.clearcoat = Math.max(bm.base.clearcoat > 0 ? MIN : 0, bm.base.clearcoat * (1 - p.matte));
    if (this.core) {
      const cm = this.core.material as THREE.MeshStandardMaterial;
      cm.emissiveIntensity = 0.22 * (1 - p.desat);
      grey.copy(this.famBase);
      const l = 0.2126 * grey.r + 0.7152 * grey.g + 0.0722 * grey.b;
      cm.color.copy(this.famBase).lerp(grey.setRGB(l, l, l), p.desat);
    }
  }

  dispose() {
    this.bodyMat?.mat.dispose();
    (this.shadow.material as THREE.Material).dispose();
    if (this.core) (this.core.material as THREE.Material).dispose();
    this.working?.dispose();
  }
}

/* ——————————————————————————— Views ——————————————————————————— */

export interface LiveOptions {
  cfg: AvatarConfig;
  state: CrewState;
  size: number;
  facing: Facing;
  /** The thinking/working loop is allowed (focused context). */
  loop: boolean;
  /** Follow the pointer when it comes near. */
  gaze: boolean;
  /** Morph shape changes (the editor) instead of cross-fading them. */
  morph?: boolean;
}

export interface LiveHandle {
  update(next: Partial<LiveOptions>): void;
  blink(): void;
  arrive(): void;
  drag(yaw: number, pitch: number): void;
  release(vYaw: number, vPitch: number): void;
  dispose(): void;
}

class LiveView {
  ctx: CanvasRenderingContext2D;
  model = new Model();
  rig: Rig;
  opts: LiveOptions;
  visible = false;
  seen = false;
  dirty = true;
  lastDraw = 0;
  pointerInside = false;
  alpha = 1;
  onFirst?: () => void;
  px: number;
  reduced: boolean;
  constructor(
    public canvas: HTMLCanvasElement,
    public ghost: HTMLCanvasElement | null,
    opts: LiveOptions,
    public dpr: number,
  ) {
    this.opts = opts;
    this.px = Math.round(opts.size * dpr);
    canvas.width = this.px;
    canvas.height = this.px;
    if (ghost) {
      ghost.width = this.px;
      ghost.height = this.px;
    }
    this.ctx = canvas.getContext("2d")!;
    this.reduced = prefersReduced(canvas);
    this.rig = new Rig({ state: opts.state, facing: opts.facing, small: opts.size <= 28, reduced: this.reduced, loop: opts.loop && opts.size >= 32 });
    this.model.set(opts.cfg, smallTuning(opts.size).detail);
  }
  theme(): Theme {
    return resolveTheme(this.canvas);
  }
  /** Copy what is on screen into the ghost and fade it out: the reduced-motion (and material-swap) transition. */
  crossfade(ms: number) {
    const g = this.ghost;
    if (!g || !this.seen) return;
    const gctx = g.getContext("2d");
    if (!gctx) return;
    gctx.clearRect(0, 0, g.width, g.height);
    gctx.drawImage(this.canvas, 0, 0);
    g.style.transition = "none";
    g.style.opacity = "1";
    void g.offsetWidth;
    g.style.transition = `opacity ${ms}ms cubic-bezier(0.2, 0, 0, 1)`;
    g.style.opacity = "0";
  }
}


/* ——————————————————————————— Engine ——————————————————————————— */

interface SpriteRequest {
  key: string;
  cfg: AvatarConfig;
  state: CrewState;
  size: number;
  dpr: number;
  theme: Theme;
  facing: Facing;
  resolve: (url: string) => void;
  reject: (e: unknown) => void;
}

export interface EngineStats {
  frames: number;
  renders: number;
  sprites: number;
  lastFrameMs: number;
}

class Engine {
  ok = false;
  private renderer!: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
  private key = new THREE.DirectionalLight(0xffffff, 1.7);
  private rim = new THREE.DirectionalLight(0xffffff, 0.8);
  private slot = new THREE.Group();
  private W = 1024;
  private H = 512;
  private views = new Set<LiveView>();
  private raf = 0;
  private last = 0;
  private io: IntersectionObserver | null = null;
  private byCanvas = new Map<Element, LiveView>();
  private sprites: SpriteRequest[] = [];
  private spriteCache = new Map<string, Promise<string>>();
  private spriteModel = new Model();
  private pointer: { x: number; y: number } | null = null;
  stats: EngineStats = { frames: 0, renders: 0, sprites: 0, lastFrameMs: 0 };

  constructor() {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = this.W;
      canvas.height = this.H;
      this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, premultipliedAlpha: true, preserveDrawingBuffer: false, powerPreference: "low-power" });
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(this.W, this.H, false);
      this.renderer.setClearColor(0x000000, 0);
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.toneMapping = THREE.NeutralToneMapping;
      this.renderer.setScissorTest(true);
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment();
      this.scene.environment = pmrem.fromScene(room, 0.04).texture;
      room.dispose?.();
      pmrem.dispose();
      this.key.position.set(-3.2, 4.6, 3.0);
      this.rim.position.set(3.4, 2.2, -3.4);
      this.scene.add(this.key, this.rim, this.slot);
      this.ok = true;
    } catch {
      this.ok = false;
      return;
    }
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const v = this.byCanvas.get(e.target);
          if (!v) continue;
          v.visible = e.isIntersecting;
          if (v.visible) {
            v.dirty = true;
            // A single blink the first time the face comes into view.
            if (!v.seen) v.rig.blink(performance.now() + 380);
            this.schedule();
          }
        }
      },
      { rootMargin: "64px" },
    );
    window.addEventListener("pointermove", this.onPointer, { passive: true });
    document.addEventListener("pointerleave", this.onLeave);
    const mq = matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", () => this.invalidateTheme());
    const rm = matchMedia("(prefers-reduced-motion: reduce)");
    rm.addEventListener("change", () => {
      for (const v of this.views) {
        v.reduced = prefersReduced(v.canvas);
        v.rig.update({ reduced: v.reduced }, performance.now());
      }
    });
    new MutationObserver(() => this.invalidateTheme()).observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ["data-theme", "data-rm"] });
  }

  private invalidateTheme() {
    for (const v of this.views) {
      v.dirty = true;
      const r = prefersReduced(v.canvas);
      if (r !== v.reduced) {
        v.reduced = r;
        v.rig.update({ reduced: r }, performance.now());
      }
    }
    this.schedule();
    window.dispatchEvent(new Event("jcf-theme"));
  }

  /* ———— pointer gaze ———— */

  private onPointer = (e: PointerEvent) => {
    if (e.pointerType === "touch") return;
    this.pointer = { x: e.clientX, y: e.clientY };
    this.updateGaze();
  };
  private onLeave = () => {
    this.pointer = null;
    this.updateGaze();
  };
  private updateGaze() {
    const now = performance.now();
    let any = false;
    for (const v of this.views) {
      if (!v.visible || !v.opts.gaze || v.opts.size < 28) continue;
      const p = this.pointer;
      if (!p) {
        v.rig.gaze(0, 0);
        v.pointerInside = false;
        any = true;
        continue;
      }
      const r = v.canvas.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height * 0.46;
      const dx = Math.max(r.left - p.x, 0, p.x - r.right);
      const dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
      const near = Math.hypot(dx, dy) <= 160;
      const inside = dx === 0 && dy === 0;
      if (inside && !v.pointerInside) v.rig.blink(now);
      v.pointerInside = inside;
      const reach = Math.max(120, r.width * 1.2);
      if (near) v.rig.gaze((p.x - cx) / reach, (p.y - cy) / reach);
      else v.rig.gaze(0, 0);
      any = true;
    }
    if (any) this.schedule();
  }

  /* ———— live views ———— */

  mount(canvas: HTMLCanvasElement, ghost: HTMLCanvasElement | null, opts: LiveOptions, onFirst?: () => void): LiveHandle {
    const dpr = spriteDpr();
    const v = new LiveView(canvas, ghost, opts, dpr);
    v.onFirst = onFirst;
    v.model.onChange = () => {
      v.dirty = true;
      this.schedule();
    };
    this.views.add(v);
    this.byCanvas.set(canvas, v);
    this.io?.observe(canvas);
    this.schedule();
    return {
      update: (next) => {
        const now = performance.now();
        const prev = v.opts;
        v.opts = { ...prev, ...next };
        if (next.cfg && avatarKey(next.cfg) !== avatarKey(prev.cfg)) {
          const shapeOnly = formKey(next.cfg) !== formKey(prev.cfg) && avatarKey({ ...prev.cfg, shape: next.cfg.shape, proportions: next.cfg.proportions }) === avatarKey(next.cfg);
          if (shapeOnly && v.opts.morph && !v.reduced) {
            v.model.set(next.cfg, smallTuning(v.opts.size).detail, now);
          } else {
            v.crossfade(v.reduced ? 160 : 200);
            v.model.set(next.cfg, smallTuning(v.opts.size).detail);
          }
        }
        if (next.state && next.state !== prev.state && v.reduced) v.crossfade(160);
        v.rig.update({ state: v.opts.state, facing: v.opts.facing, loop: v.opts.loop && v.opts.size >= 32 }, now);
        v.dirty = true;
        this.schedule();
      },
      blink: () => {
        if (v.rig.blink(performance.now())) this.schedule();
      },
      arrive: () => {
        v.rig.arrive(performance.now());
        v.dirty = true;
        this.schedule();
      },
      drag: (yaw, pitch) => {
        v.rig.drag(yaw, pitch);
        this.schedule();
      },
      release: (vy, vp) => {
        v.rig.release(vy, vp);
        this.schedule();
      },
      dispose: () => {
        this.io?.unobserve(canvas);
        this.views.delete(v);
        this.byCanvas.delete(canvas);
        v.model.dispose();
      },
    };
  }

  private schedule() {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    const t0 = performance.now();
    const dt = Math.min(1 / 30, Math.max(0.001, (now - (this.last || now - 16)) / 1000));
    this.last = now;
    let again = false;
    const batch: LiveView[] = [];
    for (const v of this.views) {
      if (!v.visible) continue;
      const moving = v.rig.step(dt, now) || v.model.morphing(now);
      if (moving || v.rig.pending(now)) again = true;
      if (!moving && !v.dirty) continue;
      // The slow loop draws at 30 fps.
      if (!v.dirty && v.rig.loopOnly(now) && now - v.lastDraw < 32) continue;
      batch.push(v);
    }
    if (batch.length) this.renderLive(batch, now);
    if (this.sprites.length) this.renderSprites();
    this.stats.frames++;
    this.stats.lastFrameMs = performance.now() - t0;
    if (again || this.sprites.length) this.schedule();
    else this.last = 0;
  };

  private ensureSize(w: number, h: number) {
    if (w <= this.W && h <= this.H) return;
    this.W = Math.min(4096, Math.max(this.W, nextPow2(w)));
    this.H = Math.min(4096, Math.max(this.H, nextPow2(h)));
    this.renderer.setSize(this.W, this.H, false);
  }

  /** Shelf-pack square regions of the atlas. Returns [x, y] per size, or null where it overflows. */
  private pack(sizes: number[]): ([number, number] | null)[] {
    const out: ([number, number] | null)[] = [];
    const maxW = 2048;
    let x = 0;
    let y = 0;
    let row = 0;
    for (const s of sizes) {
      if (x + s > maxW) {
        x = 0;
        y += row;
        row = 0;
      }
      if (y + s > 2048) {
        out.push(null);
        continue;
      }
      out.push([x, y]);
      x += s;
      row = Math.max(row, s);
    }
    this.ensureSize(Math.min(maxW, Math.max(...sizes.map((s, i) => (out[i] ? out[i]![0] + s : 0)))), y + row);
    return out;
  }

  private draw(model: Model, theme: Theme, size: number, x: number, y: number, px: number) {
    const look = LOOK[theme];
    const tune = smallTuning(size);
    this.renderer.toneMappingExposure = look.exposure;
    this.scene.environmentIntensity = look.env;
    this.key.intensity = look.key;
    this.key.color.setHex(look.keyColor);
    this.rim.intensity = look.rim;
    this.rim.color.setHex(look.rimColor);
    model.shadowOpacity = look.shadow;
    const dist = CAM_DIST / tune.zoom;
    this.camera.position.set(0, CAM_HEIGHT / tune.zoom, dist);
    this.camera.lookAt(0, LOOK_AT_Y, 0);
    this.camera.updateMatrixWorld();
    this.slot.clear();
    this.slot.add(model.root);
    const gy = this.H - y - px;
    this.renderer.setViewport(x, gy, px, px);
    this.renderer.setScissor(x, gy, px, px);
    this.renderer.render(this.scene, this.camera);
    this.stats.renders++;
  }

  private renderLive(batch: LiveView[], now: number) {
    batch.sort((a, b) => b.px - a.px);
    const spots = this.pack(batch.map((v) => v.px));
    const pose = {} as Pose;
    batch.forEach((v, i) => {
      const spot = spots[i];
      if (!spot) return;
      v.rig.sample(now, pose);
      v.model.pose(pose, v.opts.size, now);
      this.draw(v.model, v.theme(), v.opts.size, spot[0], spot[1], v.px);
      v.alpha = pose.opacity;
    });
    const src = this.renderer.domElement;
    batch.forEach((v, i) => {
      const spot = spots[i];
      if (!spot) {
        v.dirty = true;
        return;
      }
      v.ctx.clearRect(0, 0, v.px, v.px);
      v.ctx.globalAlpha = v.alpha;
      v.ctx.drawImage(src, spot[0], spot[1], v.px, v.px, 0, 0, v.px, v.px);
      v.ctx.globalAlpha = 1;
      v.dirty = false;
      if (!v.seen) {
        v.seen = true;
        v.onFirst?.();
      }
      v.lastDraw = now;
    });
  }

  /* ———— sprites ———— */

  sprite(cfg: AvatarConfig, state: CrewState, size: number, theme: Theme, facing: Facing): Promise<string> {
    const dpr = spriteDpr();
    const key = spriteKey(cfg, state, size, dpr, theme, facing);
    const hit = this.spriteCache.get(key);
    if (hit) return hit;
    const stored = readStore(key);
    if (stored) {
      const p = Promise.resolve(stored);
      this.spriteCache.set(key, p);
      return p;
    }
    const p = new Promise<string>((resolve, reject) => {
      this.sprites.push({ key, cfg, state, size, dpr, theme, facing, resolve, reject });
      this.schedule();
    });
    this.spriteCache.set(key, p);
    if (this.spriteCache.size > 600) {
      const first = this.spriteCache.keys().next().value;
      if (first) this.spriteCache.delete(first);
    }
    return p;
  }

  private spriteBusy = false;
  private renderSprites() {
    if (this.spriteBusy) return;
    const batch = this.sprites.splice(0, 32);
    if (!batch.length) return;
    // Textures that load asynchronously (uploaded images) must be ready before a sprite is cached.
    const needsWait = batch.some((r) => r.cfg.texture.kind === "image");
    if (needsWait) {
      this.spriteBusy = true;
      const m = new Model();
      Promise.all(
        batch.map((r) => {
          if (r.cfg.texture.kind !== "image") return Promise.resolve();
          m.set(r.cfg, 24);
          return m.ready;
        }),
      ).finally(() => {
        m.dispose();
        this.spriteBusy = false;
        this.drawSprites(batch);
        this.schedule();
      });
      return;
    }
    this.drawSprites(batch);
  }

  private drawSprites(batch: SpriteRequest[]) {
    // Small sprites are drawn at twice the device resolution and downsampled; large ones rely on MSAA.
    const sizes = batch.map((r) => Math.round(r.size * r.dpr * (r.size <= 64 ? 2 : 1)));
    const spots = this.pack(sizes);
    const pose = {} as Pose;
    batch.forEach((r, i) => {
      const spot = spots[i];
      if (!spot) {
        this.sprites.push(r);
        return;
      }
      this.spriteModel.set(r.cfg, smallTuning(r.size).detail);
      Object.assign(pose, restingPose(r.state, r.facing, r.size <= 28));
      this.spriteModel.pose(pose, r.size, 0);
      this.draw(this.spriteModel, r.theme, r.size, spot[0], spot[1], sizes[i]);
      // Downsample now, while the drawing buffer is valid.
      const out = Math.round(r.size * r.dpr);
      const c = document.createElement("canvas");
      c.width = out;
      c.height = out;
      const ctx = c.getContext("2d")!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(this.renderer.domElement, spot[0], spot[1], sizes[i], sizes[i], 0, 0, out, out);
      const url = c.toDataURL("image/png");
      if (r.size <= 48) writeStore(r.key, url);
      this.stats.sprites++;
      r.resolve(url);
    });
  }

  /** Warm the shader programs for a set of configs so the first live frame does not stall. */
  async warm(cfgs: AvatarConfig[]) {
    if (!this.ok) return;
    const models = cfgs.map((c) => {
      const m = new Model();
      m.set(c, 16);
      m.pose(restingPose("available"), 64, 0);
      this.slot.add(m.root);
      return m;
    });
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch {
      /* compile on first draw instead */
    }
    this.slot.clear();
    for (const m of models) m.dispose();
  }
}

function nextPow2(n: number) {
  let p = 256;
  while (p < n) p *= 2;
  return p;
}

let engine: Engine | null = null;
export function getEngine(): Engine {
  engine ??= new Engine();
  return engine;
}
export type { Engine };
