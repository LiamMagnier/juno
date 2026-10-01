/**
 * One crew character in the scene graph (three.js, client only).
 *
 *   root ─ shadow                       the soft contact shadow on the ground
 *        ─ hearts                       the happy reaction (not turned with the body)
 *        ─ base (squash, lift)          scales about the ground, keeps volume
 *            └ pivot (yaw, pitch, roll) turns about a point low in the body
 *                └ content
 *                    ├ body             skin + fur shells (plush, velvet) or one solid mesh
 *                    ├ eyes ×2          dome, catchlights, iris or pupil, a lid that closes
 *                    ├ brows, mouth     embroidered thread
 *                    └ accessories      fitted to the body's anchors
 *
 * Everything that changes with state (lids, look, brows, desaturation, fur
 * lag, hearts) is a transform or a uniform, so a state change never rebuilds
 * or recompiles. A config change rebuilds only what it touches.
 */

import * as THREE from "three";
import { buildAccessory, type BuiltAccessory } from "./accessories";
import { avatarKey, formKey, furLengthOf, type AvatarConfig, type EyeStyle } from "./avatar2";
import { makeFurMaterial, makeSolidMaterial, heartGeometry, makeAccMaterial, type FurMaterial, type SolidMaterial, type AccMaterial } from "./materials";
import { blush, colorHex, featureInk, hexToOklch, oklchToHex, patternPartner } from "./palette";
import type { Pose } from "./rig";
import { anchors as anchorsOf, bodyField, coreOf, castRay, fieldNormal, surfaceBasis, type Anchors, type BodyField, type Frame } from "./shapes";

/* ——————————————————————————— Tuning ——————————————————————————— */

export interface Tuning {
  /** Eye size multiplier (small faces need bigger eyes to read). */
  eye: number;
  /** Body mesh subdivisions per cube face. */
  detail: number;
  /** Fur shells (plush). */
  shells: number;
  /** Feature stroke multiplier (brows, mouth, lash lines). */
  stroke: number;
  /** Relief multiplier (bumps alias when tiny). */
  bump: number;
  small: boolean;
}

/** Optical compensation and level of detail by rendered size (CSS px). */
export function tuning(size: number): Tuning {
  if (size <= 16) return { eye: 1.5, detail: 20, shells: 8, stroke: 1.9, bump: 0.2, small: true };
  if (size <= 20) return { eye: 1.4, detail: 22, shells: 9, stroke: 1.7, bump: 0.25, small: true };
  if (size <= 28) return { eye: 1.26, detail: 24, shells: 10, stroke: 1.45, bump: 0.35, small: true };
  if (size <= 48) return { eye: 1.14, detail: 28, shells: 14, stroke: 1.2, bump: 0.6, small: false };
  if (size <= 80) return { eye: 1.06, detail: 32, shells: 18, stroke: 1.08, bump: 0.8, small: false };
  if (size <= 140) return { eye: 1.0, detail: 40, shells: 24, stroke: 1, bump: 1, small: false };
  if (size <= 220) return { eye: 1.0, detail: 48, shells: 30, stroke: 1, bump: 1, small: false };
  return { eye: 1.0, detail: 56, shells: 36, stroke: 1, bump: 1, small: false };
}

/** Fur length in body units for a config. */
export const furLength = furLengthOf;

/* ——————————————————————————— Geometry ——————————————————————————— */

const geoCache = new Map<string, THREE.BufferGeometry>();

/**
 * The body mesh: a subdivided cube, welded, each vertex direction pushed out
 * from the body's core until it meets the surface of the shape's distance
 * field, with the field's own gradient as its normal. Every shape has the
 * same topology, so one can morph into another vertex for vertex.
 */
function bodyGeometry(f: BodyField, detail: number): THREE.BufferGeometry {
  const k = `${formKey(f)}|${detail}`;
  const hit = geoCache.get(k);
  if (hit) return hit;
  let g: THREE.BufferGeometry = new THREE.BoxGeometry(2, 2, 2, detail, detail, detail);
  g.deleteAttribute("normal");
  g.deleteAttribute("uv");
  g = mergeByPosition(g);
  const pos = g.attributes.position as THREE.BufferAttribute;
  const nor = new Float32Array(pos.count * 3);
  const c = coreOf(f);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    // Spherified cube: even spacing, no poles.
    let dx = x * Math.sqrt(1 - (y * y) / 2 - (z * z) / 2 + (y * y * z * z) / 3);
    let dy = y * Math.sqrt(1 - (z * z) / 2 - (x * x) / 2 + (z * z * x * x) / 3);
    let dz = z * Math.sqrt(1 - (x * x) / 2 - (y * y) / 2 + (x * x * y * y) / 3);
    const l = Math.hypot(dx, dy, dz) || 1;
    dx /= l;
    dy /= l;
    dz /= l;
    const t = castRay(f, c[0], c[1], c[2], dx, dy, dz, 3.2);
    const px = c[0] + dx * t;
    const py = c[1] + dy * t;
    const pz = c[2] + dz * t;
    pos.setXYZ(i, px, py, pz);
    const n = fieldNormal(f, px, py, pz);
    nor[i * 3] = n[0];
    nor[i * 3 + 1] = n[1];
    nor[i * 3 + 2] = n[2];
  }
  g.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  if (geoCache.size > 80) {
    const first = geoCache.keys().next().value;
    if (first) {
      geoCache.get(first)?.dispose();
      geoCache.delete(first);
    }
  }
  geoCache.set(k, g);
  return g;
}

/** Weld coincident vertices (BoxGeometry duplicates its edges). */
function mergeByPosition(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const pos = g.attributes.position as THREE.BufferAttribute;
  const idx = g.index!;
  const map = new Map<string, number>();
  const remap = new Uint32Array(pos.count);
  const out: number[] = [];
  for (let i = 0; i < pos.count; i++) {
    const key = `${Math.round(pos.getX(i) * 1e4)},${Math.round(pos.getY(i) * 1e4)},${Math.round(pos.getZ(i) * 1e4)}`;
    let j = map.get(key);
    if (j === undefined) {
      j = out.length / 3;
      map.set(key, j);
      out.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
    remap[i] = j;
  }
  const index: number[] = [];
  for (let i = 0; i < idx.count; i++) index.push(remap[idx.getX(i)]);
  const m = new THREE.BufferGeometry();
  m.setAttribute("position", new THREE.BufferAttribute(new Float32Array(out), 3));
  m.setIndex(index);
  g.dispose();
  return m;
}

function shellGeometry(base: THREE.BufferGeometry, shells: number): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute("position", base.attributes.position);
  g.setAttribute("normal", base.attributes.normal);
  g.instanceCount = shells;
  g.boundingSphere = base.boundingSphere?.clone() ?? null;
  if (g.boundingSphere) g.boundingSphere.radius += 0.3;
  return g;
}

let shadowTex: THREE.Texture | null = null;
function shadowTexture() {
  if (shadowTex) return shadowTex;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  const wide = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  wide.addColorStop(0, "rgba(0,0,0,0.3)");
  wide.addColorStop(0.5, "rgba(0,0,0,0.13)");
  wide.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = wide;
  ctx.fillRect(0, 0, 256, 256);
  const core = ctx.createRadialGradient(128, 128, 0, 128, 128, 64);
  core.addColorStop(0, "rgba(0,0,0,0.55)");
  core.addColorStop(0.6, "rgba(0,0,0,0.2)");
  core.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, 256, 256);
  shadowTex = new THREE.CanvasTexture(c);
  shadowTex.colorSpace = THREE.NoColorSpace;
  return shadowTex;
}

/* Shared unit geometries for features. */
const unit = {
  sphere: null as THREE.SphereGeometry | null,
  hemi: null as THREE.SphereGeometry | null,
  disc: null as THREE.CircleGeometry | null,
  capsule: null as THREE.CapsuleGeometry | null,
};
const U = {
  sphere: () => (unit.sphere ??= new THREE.SphereGeometry(1, 40, 24)),
  hemi: () => (unit.hemi ??= new THREE.SphereGeometry(1, 40, 14, 0, Math.PI * 2, 0, Math.PI / 2)),
  disc: () => (unit.disc ??= new THREE.CircleGeometry(1, 40)),
  capsule: () => (unit.capsule ??= new THREE.CapsuleGeometry(0.5, 1, 6, 12)),
};
const lashCache = new Map<number, THREE.TubeGeometry>();
function lashGeometry(stroke: number) {
  const k = Math.round(stroke * 100);
  let g = lashCache.get(k);
  if (!g) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 24; i++) {
      const t = 0.08 + (i / 24) * (Math.PI - 0.16);
      pts.push(new THREE.Vector3(Math.cos(t) * 1.03, 0, Math.sin(t) * 1.03));
    }
    g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 32, 0.075 * stroke, 8, false);
    lashCache.set(k, g);
  }
  return g;
}
const smileCache = new Map<number, THREE.TubeGeometry>();
function smileGeometry(stroke: number) {
  const k = Math.round(stroke * 100);
  let g = smileCache.get(k);
  if (!g) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 16; i++) {
      const t = Math.PI * (0.18 + (i / 16) * 0.64);
      pts.push(new THREE.Vector3(Math.cos(t), -Math.sin(t) * 0.62 + 0.3, 0));
    }
    g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.11 * stroke, 8, false);
    smileCache.set(k, g);
  }
  return g;
}

const arcCache = new Map<string, THREE.TubeGeometry>();
/** A closed eye drawn as one stitched curve: ‿ asleep, ∩ when smiling shut. */
function closedArc(stroke: number, up: boolean) {
  const k = `${Math.round(stroke * 100)}|${up ? 1 : 0}`;
  let g = arcCache.get(k);
  if (!g) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 18; i++) {
      const t = Math.PI * (0.14 + (i / 18) * 0.72);
      const y = Math.sin(t) * 0.5;
      pts.push(new THREE.Vector3(Math.cos(t), up ? y - 0.22 : 0.22 - y, 0));
    }
    g = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 28, 0.13 * stroke, 8, false);
    arcCache.set(k, g);
  }
  return g;
}

/* ——————————————————————————— Eyes ——————————————————————————— */

const EYE_INK = "#15110f";

/** Where on the surface a feature sits, facing mostly forward. */
function placeOn(obj: THREE.Object3D, f: Frame, out: number, forward: number) {
  const n = new THREE.Vector3(f.n[0], f.n[1], f.n[2]);
  const nf = n.clone();
  nf.z += forward;
  nf.normalize();
  const b = surfaceBasis([nf.x, nf.y, nf.z]);
  const m = new THREE.Matrix4().makeBasis(new THREE.Vector3(...b.x), new THREE.Vector3(...b.y), new THREE.Vector3(...b.z));
  m.setPosition(new THREE.Vector3(f.p[0], f.p[1], f.p[2]).addScaledVector(n, out));
  obj.matrix.copy(m);
  obj.matrix.decompose(obj.position, obj.quaternion, obj.scale);
}

interface EyeParts {
  group: THREE.Group;
  /** Moves with the look (dome eyes). */
  look: THREE.Group;
  /** Moves inside the eye (iris, pupil). */
  inner: THREE.Object3D | null;
  lidRot: THREE.Group | null;
  lid: THREE.Mesh | null;
  lash: THREE.Mesh | null;
  /** The eye's scale, for blinking without a lid. */
  squash: THREE.Group;
  /** Closed: asleep (‿) and smiling shut (∩). */
  asleep: THREE.Mesh;
  smiling: THREE.Mesh;
  r: number;
  depth: number;
  style: EyeStyle;
}

interface EyeMats {
  dark: THREE.MeshPhysicalMaterial;
  /** Flat discs (pupils) must be matte: a glossy disc facing the camera mirrors the studio light and turns white. */
  pupil: THREE.MeshStandardMaterial;
  white: THREE.MeshPhysicalMaterial;
  iris: THREE.MeshPhysicalMaterial;
  glint: THREE.MeshBasicMaterial;
  cover: THREE.MeshPhysicalMaterial;
  lid: THREE.MeshPhysicalMaterial;
  ink: AccMaterial;
  thread: AccMaterial;
}

function eyeMaterials(bodyHex: string): EyeMats {
  const lch = hexToOklch(bodyHex);
  const irisHex = oklchToHex({ l: 0.42, c: Math.min(0.1, Math.max(0.05, lch.c)), h: lch.c < 0.03 ? 60 : (lch.h + 200) % 360 });
  return {
    dark: new THREE.MeshPhysicalMaterial({ color: EYE_INK, roughness: 0.2, clearcoat: 1, clearcoatRoughness: 0.05, metalness: 0 }),
    white: new THREE.MeshPhysicalMaterial({ color: "#f7f5f0", roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.1 }),
    iris: new THREE.MeshPhysicalMaterial({ color: irisHex, roughness: 0.7, envMapIntensity: 0.5, clearcoat: 1e-4 }),
    pupil: new THREE.MeshStandardMaterial({ color: "#0d0b0a", roughness: 0.85, envMapIntensity: 0.3 }),
    glint: new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }),
    cover: new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.03, clearcoat: 1, clearcoatRoughness: 0.02, transparent: true, opacity: 0.12, depthWrite: false }),
    lid: new THREE.MeshPhysicalMaterial({
      color: oklchToHex({ l: Math.max(0.18, lch.l - 0.09), c: lch.c * 0.95, h: lch.h }),
      roughness: 0.92,
      sheen: 0.7,
      sheenRoughness: 0.5,
      sheenColor: new THREE.Color(1, 1, 1),
      clearcoat: 1e-4,
    }),
    ink: makeAccMaterial("thread", featureInk(bodyHex)),
    thread: makeAccMaterial("thread", EYE_INK),
  };
}

function buildEye(style: EyeStyle, r: number, stroke: number, mats: EyeMats, side: number): EyeParts {
  const group = new THREE.Group();
  const look = new THREE.Group();
  const squash = new THREE.Group();
  group.add(look);
  look.add(squash);
  let inner: THREE.Object3D | null = null;
  let depth = r * 0.6;
  const add = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = squash) => {
    const m = new THREE.Mesh(geo, mat);
    parent.add(m);
    return m;
  };
  const glint = (x: number, y: number, s: number, z: number, parent: THREE.Object3D = squash) => {
    const g = add(U.disc(), mats.glint, parent);
    g.scale.setScalar(s);
    g.position.set(x, y, z);
  };
  let dome = new THREE.Vector3(r, r, r * 0.6);
  switch (style) {
    case "button":
    case "sleepy": {
      dome = new THREE.Vector3(r, r, r * 0.62);
      const d = add(U.sphere(), mats.dark);
      d.scale.copy(dome);
      glint(-r * 0.32, r * 0.36, r * 0.24, r * 0.5);
      glint(r * 0.3, -r * 0.3, r * 0.09, r * 0.5);
      depth = r * 0.62;
      break;
    }
    case "oval": {
      dome = new THREE.Vector3(r * 0.76, r * 1.12, r * 0.55);
      const d = add(U.sphere(), mats.dark);
      d.scale.copy(dome);
      glint(-r * 0.22, r * 0.46, r * 0.22, r * 0.44);
      glint(r * 0.24, -r * 0.4, r * 0.08, r * 0.46);
      depth = r * 0.55;
      break;
    }
    case "bead": {
      const rb = r * 0.58;
      dome = new THREE.Vector3(rb, rb, rb * 0.85);
      const d = add(U.sphere(), mats.dark);
      d.scale.copy(dome);
      glint(-rb * 0.34, rb * 0.36, rb * 0.26, rb * 0.76);
      depth = rb * 0.85;
      break;
    }
    case "wide": {
      dome = new THREE.Vector3(r * 1.12, r * 1.2, r * 0.6);
      const d = add(U.sphere(), mats.white);
      d.scale.copy(dome);
      const iris = new THREE.Group();
      squash.add(iris);
      const i = add(U.disc(), mats.iris, iris);
      i.scale.setScalar(r * 0.62);
      const p = add(U.disc(), mats.pupil, iris);
      p.scale.setScalar(r * 0.34);
      p.position.z = 0.002;
      glint(-r * 0.2, r * 0.24, r * 0.15, 0.004, iris);
      iris.position.z = r * 0.6 + 0.002;
      inner = iris;
      depth = r * 0.6;
      break;
    }
    case "googly": {
      dome = new THREE.Vector3(r * 1.22, r * 1.22, r * 0.7);
      const d = add(U.sphere(), mats.white);
      d.scale.copy(dome);
      const pupil = new THREE.Group();
      squash.add(pupil);
      const p = add(U.disc(), mats.pupil, pupil);
      p.scale.setScalar(r * 0.6);
      pupil.position.z = r * 0.7 + 0.003;
      inner = pupil;
      const cover = add(U.sphere(), mats.cover);
      cover.scale.set(r * 1.24, r * 1.24, r * 0.82);
      cover.renderOrder = 2;
      glint(-r * 0.5, r * 0.55, r * 0.16, r * 0.66);
      depth = r * 0.82;
      break;
    }
    case "stitched": {
      dome = new THREE.Vector3(r * 0.72, r * 0.98, r * 0.22);
      const d = add(U.sphere(), mats.thread.mat);
      d.scale.copy(dome);
      depth = r * 0.22;
      break;
    }
  }
  void side;
  // The lid: a hemisphere in the body's colour that rotates down over the eye.
  let lidRot: THREE.Group | null = null;
  let lid: THREE.Mesh | null = null;
  let lash: THREE.Mesh | null = null;
  if (style !== "stitched") {
    const lidScale = new THREE.Group();
    lidScale.scale.copy(dome).multiplyScalar(1.055);
    lidScale.scale.z = dome.z * 1.12;
    squash.add(lidScale);
    lidRot = new THREE.Group();
    lidScale.add(lidRot);
    lid = new THREE.Mesh(U.hemi(), mats.lid);
    lidRot.add(lid);
    lash = new THREE.Mesh(lashGeometry(stroke), mats.ink.mat);
    lidRot.add(lash);
  }
  const arcW = style === "googly" || style === "wide" ? r * 1.05 : style === "bead" ? r * 0.75 : r * 0.92;
  const asleep = new THREE.Mesh(closedArc(stroke * (0.9 / Math.max(0.6, arcW / r)), false), mats.ink.mat);
  const smiling = new THREE.Mesh(closedArc(stroke * (0.9 / Math.max(0.6, arcW / r)), true), mats.ink.mat);
  for (const m of [asleep, smiling]) {
    m.scale.set(arcW, arcW, arcW);
    m.position.z = Math.min(depth, r * 0.45);
    m.visible = false;
    look.add(m);
  }
  return { group, look, inner, lidRot, lid, lash, squash, asleep, smiling, r, depth, style };
}

/* ——————————————————————————— The character ——————————————————————————— */

export interface Bounds {
  top: number;
  bottom: number;
  half: number;
}

interface Morph {
  from: Float32Array;
  fromN: Float32Array;
  to: THREE.BufferGeometry;
  t0: number;
}

const HEART_STARTS = [0.05, 0.16, 0.27];
const HEART_X = [-0.42, 0.06, 0.44];

export class Character {
  root = new THREE.Group();
  private base = new THREE.Group();
  private pivot = new THREE.Group();
  private content = new THREE.Group();
  private shadow: THREE.Mesh;
  private hearts = new THREE.Group();
  private heartMeshes: THREE.Mesh[] = [];
  private heartMat: THREE.MeshPhysicalMaterial | null = null;

  cfg: AvatarConfig | null = null;
  key = "";
  private detailKey = "";
  field: BodyField | null = null;
  anchors: Anchors | null = null;
  tune: Tuning = tuning(64);
  fur = 0;
  bounds: Bounds = { top: 1, bottom: -1, half: 1 };

  private skin: THREE.Mesh | null = null;
  private furMat: FurMaterial | null = null;
  private solidMat: SolidMaterial | null = null;
  private baseGeo: THREE.BufferGeometry | null = null;
  private eyes: EyeParts[] = [];
  private eyeMats: EyeMats | null = null;
  private lidBase = new THREE.Color();
  private features = new THREE.Group();
  private brows: THREE.Group[] = [];
  private mouthSmile: THREE.Mesh | null = null;
  private mouthO: THREE.Group | null = null;
  private accs: BuiltAccessory[] = [];
  private accGroup = new THREE.Group();
  private morph: Morph | null = null;
  private working: THREE.BufferGeometry | null = null;
  private imageTex: THREE.Texture | null = null;
  shadowOpacity = 1;
  onChange?: () => void;
  ready: Promise<void> = Promise.resolve();
  private loadToken = 0;

  constructor() {
    this.shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, color: 0x000000, toneMapped: false }),
    );
    this.shadow.rotation.x = -Math.PI / 2;
    this.shadow.renderOrder = -1;
    this.root.add(this.shadow, this.base, this.hearts);
    this.base.add(this.pivot);
    this.pivot.add(this.content);
    this.content.add(this.features, this.accGroup);
  }

  /** Configure for a size. `morphAt` (ms) morphs the body from its current shape. */
  set(cfg: AvatarConfig, size: number, morphAt?: number) {
    const tune = tuning(size);
    const key = avatarKey(cfg);
    const dk = `${tune.detail}|${tune.shells}|${tune.eye}`;
    if (key === this.key && dk === this.detailKey) return;
    const prev = this.cfg;
    const formChanged = !prev || formKey(prev) !== formKey(cfg) || dk !== this.detailKey;
    const matChanged = !prev || prev.material.kind !== cfg.material.kind || dk !== this.detailKey;
    this.cfg = cfg;
    this.key = key;
    this.detailKey = dk;
    this.tune = tune;
    this.fur = furLength(cfg);
    const f = bodyField(cfg.shape, cfg.stretch);
    this.field = f;
    this.anchors = anchorsOf(cfg.shape, cfg.stretch, cfg.eyes);
    const bodyHex = colorHex(cfg.color);

    /* Body geometry (morph when asked). */
    const geo = bodyGeometry(f, tune.detail);
    if (formChanged) {
      if (morphAt !== undefined && this.baseGeo && this.baseGeo !== geo && (this.baseGeo.attributes.position as THREE.BufferAttribute).count === (geo.attributes.position as THREE.BufferAttribute).count) {
        const cur = this.working && this.morph ? this.working : this.baseGeo;
        const from = new Float32Array((cur.attributes.position as THREE.BufferAttribute).array as Float32Array);
        const fromN = new Float32Array((cur.attributes.normal as THREE.BufferAttribute).array as Float32Array);
        if (!this.working || (this.working.attributes.position as THREE.BufferAttribute).count !== (geo.attributes.position as THREE.BufferAttribute).count) {
          this.working?.dispose();
          this.working = geo.clone();
        }
        this.morph = { from, fromN, to: geo, t0: morphAt };
        this.baseGeo = geo;
      } else {
        this.morph = null;
        this.baseGeo = geo;
      }
    }

    /* Body material. */
    const kind = cfg.material.kind;
    const furry = kind === "plush" || kind === "velvet";
    if (matChanged || formChanged) {
      if (this.skin) {
        this.content.remove(this.skin);
        if (this.skin.geometry instanceof THREE.InstancedBufferGeometry) this.skin.geometry.dispose();
      }
      if (matChanged) {
        this.furMat?.mat.dispose();
        this.solidMat?.mat.dispose();
        this.furMat = null;
        this.solidMat = null;
        if (furry) this.furMat = makeFurMaterial(kind === "velvet");
        else this.solidMat = makeSolidMaterial(kind as "knit" | "felt" | "vinyl" | "ceramic");
      }
      const drawGeo = this.morph && this.working ? this.working : geo;
      const shells = kind === "velvet" ? Math.max(4, Math.round(tune.shells * 0.3)) : tune.shells;
      this.skin = new THREE.Mesh(furry ? shellGeometry(drawGeo, shells) : drawGeo, furry ? this.furMat!.mat : this.solidMat!.mat);
      this.skin.frustumCulled = false;
      this.content.add(this.skin);
      if (this.furMat) this.furMat.u.uShells.value = shells;
    }

    /* Surface uniforms (colour, pattern, cheeks, fur). */
    const u = (this.furMat ?? this.solidMat)!.u;
    u.uBase.value.set(bodyHex);
    u.uBounds.value.set(f.bottom, f.top, f.halfWidth, f.halfDepth);
    const p = cfg.pattern;
    const kinds = { none: 0, dip: 1, belly: 2, spots: 3, stripes: 4, image: 5 } as const;
    u.uPatKind.value = kinds[p.kind];
    u.uPatSeed.value = (parseInt(bodyHex.slice(1, 4), 16) % 97) * 0.13;
    if (p.kind !== "none" && p.kind !== "image") {
      u.uPat.value.set(colorHex(p.color));
      u.uPatScale.value = p.scale;
    }
    const a = this.anchors;
    const blushR = a.eyeRadius * tune.eye * 1.0;
    if (cfg.cheeks) {
      u.uBlushCol.value.set(blush(bodyHex));
      u.uBlush0.value.set(a.cheeks[0].p[0], a.cheeks[0].p[1], a.cheeks[0].p[2], blushR);
      u.uBlush1.value.set(a.cheeks[1].p[0], a.cheeks[1].p[1], a.cheeks[1].p[2], blushR);
    } else {
      u.uBlush0.value.set(0, -99, 0, 0.001);
      u.uBlush1.value.set(0, -99, 0, 0.001);
    }
    if (this.furMat) {
      const fu = this.furMat.u;
      const velvet = kind === "velvet";
      const dens = velvet ? 1 : cfg.material.furDensity;
      fu.uFurLen.value = this.fur;
      // Longer fur reads as fewer, thicker locks; density adds strands.
      fu.uFreq.value = velvet ? 6 : (1.5 + dens * 1.3) / (0.7 + cfg.material.furLength * 0.8);
      fu.uCover.value = velvet ? 0.95 : 0.62 + dens * 0.36;
      fu.uGravity.value = velvet ? 0 : 0.25 + cfg.material.furLength * 0.35;
      fu.uAO.value = velvet ? 0.72 : 0.5 - cfg.material.furLength * 0.12;
      fu.uTip.value = velvet ? 0.05 : 0.1;
      const er = a.eyeRadius * tune.eye;
      const eyeF = (i: number) => a.eyes[i].p;
      const style = cfg.eyes.style;
      const k = style === "wide" ? 1.18 : style === "googly" ? 1.28 : style === "oval" ? 1.1 : style === "bead" ? 0.62 : 1;
      fu.uFeat0.value.set(eyeF(0)[0], eyeF(0)[1], eyeF(0)[2], er * k);
      fu.uFeat1.value.set(eyeF(1)[0], eyeF(1)[1], eyeF(1)[2], er * k);
      if (cfg.mouth !== "none") fu.uFeat2.value.set(a.mouth.p[0], a.mouth.p[1], a.mouth.p[2], er * 0.7);
      else fu.uFeat2.value.set(0, -99, 0, 0.001);
      this.furMat.mat.sheenColor.set(bodyHex).lerp(new THREE.Color(1, 1, 1), 0.55);
    }
    if (this.solidMat) {
      const su = this.solidMat.u;
      su.uBumpK.value = (kind === "knit" ? 0.022 : kind === "felt" ? 0.006 : kind === "vinyl" ? 0.0015 : 0.0022) * tune.bump;
      const circ = Math.PI * (f.halfWidth + f.halfDepth);
      // Chunky stitches; the column count is a multiple of 8 so the seam trick tiles.
      su.uKnitCols.value = Math.max(24, Math.round((circ * 7) / 8) * 8);
      su.uKnitRows.value = 7.5;
      if (kind === "felt" || kind === "knit") this.solidMat.mat.sheenColor.set(bodyHex).lerp(new THREE.Color(1, 1, 1), 0.5);
    }
    this.loadImage(cfg);

    /* Features and accessories. */
    this.buildFeatures(cfg, bodyHex);
    this.buildAccessories(cfg, bodyHex);
    this.buildHearts(bodyHex);

    /* Shadow and framing. */
    this.shadow.scale.set(f.halfWidth * 2.5 + this.fur * 2, f.halfDepth * 2.3 + this.fur * 2, 1);
    this.shadow.position.y = f.bottom + 0.004;
    let top = f.top + this.fur;
    let half = f.halfWidth + this.fur;
    for (const acc of this.accs) {
      top = Math.max(top, acc.top);
      half = Math.max(half, acc.half);
    }
    this.bounds = { top, bottom: f.bottom, half };
    const h = f.top - f.bottom;
    this.base.position.y = f.bottom;
    this.pivot.position.y = h * 0.4;
    this.content.position.y = -h * 0.4 - f.bottom;
  }

  private loadImage(cfg: AvatarConfig) {
    const u = (this.furMat ?? this.solidMat)!.u;
    const p = cfg.pattern;
    if (p.kind !== "image") {
      this.ready = Promise.resolve();
      return;
    }
    const f = this.field!;
    const w = Math.max(f.halfWidth * 2, f.top - f.bottom) * 1.02;
    u.uImageBox.value.set(-w / 2, (f.top + f.bottom) / 2 - w / 2, w, w);
    u.uImageTint.value = p.tint;
    const token = ++this.loadToken;
    this.ready = new Promise<void>((resolve) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        if (token !== this.loadToken) return resolve();
        this.imageTex?.dispose();
        const t = new THREE.Texture(img);
        t.colorSpace = THREE.SRGBColorSpace;
        t.needsUpdate = true;
        this.imageTex = t;
        const uu = (this.furMat ?? this.solidMat)!.u;
        uu.uImage.value = t;
        this.onChange?.();
        resolve();
      };
      img.onerror = () => resolve();
      img.src = p.assetUrl;
    });
  }

  private buildFeatures(cfg: AvatarConfig, bodyHex: string) {
    for (const e of this.eyes) this.features.remove(e.group);
    for (const b of this.brows) this.features.remove(b);
    if (this.mouthSmile) this.features.remove(this.mouthSmile);
    if (this.mouthO) this.features.remove(this.mouthO);
    this.brows = [];
    this.mouthSmile = null;
    this.mouthO = null;
    if (this.eyeMats) {
      for (const m of [this.eyeMats.dark, this.eyeMats.pupil, this.eyeMats.white, this.eyeMats.iris, this.eyeMats.glint, this.eyeMats.cover, this.eyeMats.lid]) m.dispose();
      this.eyeMats.ink.mat.dispose();
      this.eyeMats.thread.mat.dispose();
    }
    const mats = eyeMaterials(bodyHex);
    this.eyeMats = mats;
    this.lidBase.copy(mats.lid.color);
    const a = this.anchors!;
    const t = this.tune;
    const r = a.eyeRadius * t.eye;
    const out = this.fur * 0.22;
    this.eyes = a.eyes.map((frame, i) => {
      const e = buildEye(cfg.eyes.style, r, t.stroke, mats, i === 0 ? -1 : 1);
      placeOn(e.group, frame, out, 0.55);
      this.features.add(e.group);
      return e;
    });
    // Brows: short embroidered strokes above the eyes.
    if (cfg.brows !== "none") {
      a.brows.forEach((frame, i) => {
        const g = new THREE.Group();
        placeOn(g, frame, this.fur * 0.55 + 0.004, 0.5);
        const inner = new THREE.Group();
        g.add(inner);
        const m = new THREE.Mesh(U.capsule(), mats.ink.mat);
        const len = r * (cfg.brows === "straight" ? 1.05 : 0.95);
        const th = r * 0.26 * t.stroke;
        m.scale.set(th, len, th * 0.7);
        m.rotation.z = Math.PI / 2;
        if (cfg.brows === "arched") {
          // Two strokes meeting in a soft peak.
          m.scale.y = len * 0.55;
          m.position.x = (i === 0 ? 1 : -1) * len * 0.22;
          m.rotation.z = Math.PI / 2 + (i === 0 ? 0.35 : -0.35);
          const m2 = new THREE.Mesh(U.capsule(), mats.ink.mat);
          m2.scale.set(th, len * 0.55, th * 0.7);
          m2.position.x = (i === 0 ? -1 : 1) * len * 0.22;
          m2.position.y = -len * 0.06;
          m2.rotation.z = Math.PI / 2 + (i === 0 ? -0.2 : 0.2);
          inner.add(m2);
        } else if (cfg.brows === "soft") {
          m.scale.x = th * 1.15;
          m.scale.y = len * 0.85;
        }
        inner.add(m);
        g.userData.side = i === 0 ? -1 : 1;
        this.brows.push(g);
        this.features.add(g);
      });
    }
    // Mouth.
    const mf = a.mouth;
    if (cfg.mouth === "smile") {
      const m = new THREE.Mesh(smileGeometry(t.stroke), mats.ink.mat);
      placeOn(m, mf, this.fur * 0.45 + 0.004, 0.45);
      m.scale.setScalar(r * 0.55);
      this.mouthSmile = m;
      this.features.add(m);
    }
    // The "o" mouth: shown as the mouth style, and while talking.
    const o = new THREE.Group();
    placeOn(o, mf, this.fur * 0.4 + 0.004, 0.45);
    const om = new THREE.Mesh(U.sphere(), mats.dark);
    om.scale.set(r * 0.26, r * 0.2, r * 0.12);
    o.add(om);
    o.userData.base = cfg.mouth === "dot" ? 1 : 0;
    o.visible = cfg.mouth === "dot";
    this.mouthO = o;
    this.features.add(o);
  }

  private buildAccessories(cfg: AvatarConfig, bodyHex: string) {
    for (const acc of this.accs) {
      this.accGroup.remove(acc.group);
      acc.dispose();
    }
    this.accs = [];
    const a = this.anchors!;
    const r = a.eyeRadius * this.tune.eye;
    const eyeDepth = this.eyes[0]?.depth ?? r * 0.6;
    for (const spec of cfg.accessories) {
      const built = buildAccessory(spec.id, {
        anchors: a,
        fur: this.fur,
        bodyHex,
        color: spec.color ? colorHex(spec.color) : undefined,
        eyeDepth: eyeDepth + this.fur * 0.22,
        eyeRadius: r,
        detail: Math.max(24, Math.round(this.tune.detail * 1.1)),
      });
      this.accs.push(built);
      this.accGroup.add(built.group);
    }
  }

  private buildHearts(bodyHex: string) {
    if (!this.heartMat) {
      this.heartMat = new THREE.MeshPhysicalMaterial({ color: bodyHex, roughness: 0.35, clearcoat: 0.8, clearcoatRoughness: 0.15, sheen: 0.3 });
      for (let i = 0; i < 3; i++) {
        const m = new THREE.Mesh(heartGeometry(), this.heartMat);
        m.visible = false;
        this.heartMeshes.push(m);
        this.hearts.add(m);
      }
    }
    const lch = hexToOklch(bodyHex);
    // Very pale bodies get a deeper heart so it reads against a light ground.
    this.heartMat.color.set(lch.l > 0.88 ? patternPartner(bodyHex) : bodyHex);
  }

  morphing(now: number) {
    return !!this.morph && now - this.morph.t0 < 320;
  }

  private stepMorph(now: number) {
    const m = this.morph;
    if (!m || !this.working) return;
    const t = Math.min(1, (now - m.t0) / 300);
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
    if (t >= 1) {
      this.morph = null;
      // Swap to the cached target geometry.
      const skin = this.skin;
      if (skin) {
        if (skin.geometry instanceof THREE.InstancedBufferGeometry) {
          const shells = skin.geometry.instanceCount;
          skin.geometry.dispose();
          skin.geometry = shellGeometry(m.to, shells);
        } else skin.geometry = m.to;
      }
    }
  }

  pose(p: Pose, now: number) {
    const cfg = this.cfg;
    const f = this.field;
    if (!cfg || !f) return;
    this.stepMorph(now);
    const s = Math.max(0.5, p.squash);
    const w = 1 / Math.sqrt(s);
    this.base.position.y = f.bottom + p.lift;
    this.base.scale.set(w * p.scale, s * p.scale, w * p.scale);
    this.pivot.rotation.set(p.pitch, p.yaw, p.roll, "YXZ");
    // Shadow: shrinks and fades as the body leaves the ground.
    const lifted = Math.max(0, p.lift);
    const sm = this.shadow.material as THREE.MeshBasicMaterial;
    sm.opacity = Math.max(0, (1 - lifted * 1.8) * this.shadowOpacity) * Math.min(1, p.scale * 1.2);
    const sk = (1 - Math.min(0.5, lifted * 0.9)) * p.scale * w;
    this.shadow.scale.set((f.halfWidth * 2.5 + this.fur * 2) * sk, (f.halfDepth * 2.3 + this.fur * 2) * sk, 1);

    // Surface.
    const u = (this.furMat ?? this.solidMat)!.u;
    u.uDesat.value = p.desat;
    if (this.furMat) {
      const fu = this.furMat.u;
      fu.uFurLen.value = this.fur * (1 - 0.4 * p.matte);
      fu.uLag.value.set(p.lagX * 0.9, p.lagY * 0.6, 0);
      this.furMat.mat.sheen = (cfg.material.kind === "velvet" ? 1 : 0.85) * (1 - 0.55 * p.matte);
    }
    if (this.solidMat) {
      const sb = this.solidMat.base;
      this.solidMat.mat.roughness = sb.roughness + (1 - sb.roughness) * p.matte * 0.7;
      this.solidMat.mat.clearcoat = Math.max(1e-4, sb.clearcoat * (1 - p.matte));
    }
    const em = this.eyeMats!;
    em.lid.color.copy(this.lidBase);
    // Lids share the desaturation.
    if (p.desat > 0.001) {
      const c = em.lid.color;
      const l = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
      c.lerp(new THREE.Color(l, l, l), p.desat);
    }
    em.ink.desat.value = p.desat;
    for (const acc of this.accs) for (const m of acc.mats) m.desat.value = p.desat;

    // Eyes.
    const lookX = Math.max(-1, Math.min(1, p.lookX));
    const lookY = Math.max(-1, Math.min(1, p.lookY));
    for (const e of this.eyes) {
      const r = e.r;
      const open = e.style === "sleepy" ? Math.min(1, p.eyeOpen) * 0.52 + Math.max(0, p.eyeOpen - 1) * 0.6 : p.eyeOpen;
      if (e.inner) {
        if (e.style === "googly") {
          const gx = Math.max(-1, Math.min(1, p.googX + lookX * 0.4));
          const gy = Math.max(-1, Math.min(1, p.googY + lookY * 0.4));
          const l = Math.hypot(gx, gy);
          const k = l > 1 ? 1 / l : 1;
          e.inner.position.x = gx * k * r * 0.55;
          e.inner.position.y = gy * k * r * 0.55;
        } else {
          e.inner.position.x = lookX * r * 0.38;
          e.inner.position.y = lookY * r * 0.34;
          // Stay on the dome's surface.
          const dx = e.inner.position.x / (r * 1.12);
          const dy = e.inner.position.y / (r * 1.2);
          e.inner.position.z = r * 0.6 * Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy)) + 0.002;
        }
        e.look.position.set(lookX * r * 0.08, lookY * r * 0.06, 0);
      } else {
        e.look.position.set(lookX * r * 0.26, lookY * r * 0.2, 0);
      }
      // Fully closed eyes are drawn as a stitched curve instead of a lid over the dome.
      const shut = open < 0.14;
      e.squash.visible = !shut;
      e.asleep.visible = shut && p.hearts < 0;
      e.smiling.visible = shut && p.hearts >= 0;
      if (e.lidRot && e.lid && e.lash) {
        const o = Math.max(0, Math.min(1, open));
        const theta = -Math.PI / 2 + (1 - o) * Math.PI;
        e.lidRot.rotation.x = theta;
        const shown = o < 0.97;
        e.lid.visible = shown;
        e.lash.visible = o < 0.55;
        // Wider than open: the eye grows a touch.
        const wide = Math.max(0, p.eyeOpen - 1);
        e.squash.scale.setScalar(1 + wide * 0.5);
      } else {
        // Stitched eyes blink by squashing.
        e.squash.scale.set(1, Math.max(0.08, Math.min(1.1, open)), 1);
      }
    }
    // Brows.
    for (const b of this.brows) {
      const side = b.userData.side as number;
      const r = this.eyes[0]?.r ?? 0.12;
      const inner = b.children[0];
      inner.position.y = p.brow * r * 0.34;
      inner.rotation.z = -side * p.browTilt * 0.4;
    }
    // Mouth: the "o" opens with the voice.
    if (this.mouthO) {
      const base = this.mouthO.userData.base as number;
      const m = Math.max(base * 0.6, p.mouth);
      this.mouthO.visible = m > 0.03;
      this.mouthO.scale.set(0.7 + m * 0.5, 0.4 + m * 1.4, 1);
      if (this.mouthSmile) this.mouthSmile.visible = p.mouth < 0.08;
    }
    // Springy accessories swing with the lag.
    for (const acc of this.accs)
      for (const sp of acc.springs) {
        sp.node.rotation.z = sp.rest.z - p.lagX * sp.k * 2.2;
        sp.node.rotation.x = sp.rest.x + p.lagY * sp.k * 1.2;
      }
    // Hearts.
    const t = p.hearts;
    for (let i = 0; i < this.heartMeshes.length; i++) {
      const m = this.heartMeshes[i];
      const lt = (t - HEART_STARTS[i]) / 0.62;
      if (t < 0 || lt <= 0 || lt >= 1) {
        m.visible = false;
        continue;
      }
      m.visible = true;
      const pop = lt < 0.2 ? backOut(lt / 0.2) : lt > 0.72 ? 1 - (lt - 0.72) / 0.28 : 1;
      const hs = 0.2 + (i === 1 ? 0.04 : 0);
      m.scale.setScalar(Math.max(0.001, pop) * hs);
      m.position.set(HEART_X[i] * (this.bounds.half * 0.95), this.bounds.top * 0.85 + 0.12 + lt * 0.55, 0.25);
      m.rotation.set(0, 0, Math.sin(lt * Math.PI * 2 + i) * 0.25);
    }
  }

  dispose() {
    this.furMat?.mat.dispose();
    this.solidMat?.mat.dispose();
    if (this.skin?.geometry instanceof THREE.InstancedBufferGeometry) this.skin.geometry.dispose();
    this.working?.dispose();
    (this.shadow.material as THREE.Material).dispose();
    for (const acc of this.accs) acc.dispose();
    if (this.eyeMats) {
      for (const m of [this.eyeMats.dark, this.eyeMats.pupil, this.eyeMats.white, this.eyeMats.iris, this.eyeMats.glint, this.eyeMats.cover, this.eyeMats.lid]) m.dispose();
      this.eyeMats.ink.mat.dispose();
      this.eyeMats.thread.mat.dispose();
    }
    this.heartMat?.dispose();
    this.imageTex?.dispose();
  }
}

function backOut(t: number) {
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}
