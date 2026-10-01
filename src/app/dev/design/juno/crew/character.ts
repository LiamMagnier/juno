/**
 * One crew character in the scene graph (three.js, client only), built from
 * the Blender kit (kit.ts) and fitted with the same rules as the Cycles
 * stills (fit.ts mirrors tools/crew/blender/crew_fit.py).
 *
 *   root ─ shadow                        the soft contact shadow on the ground
 *        ─ hearts                        the happy reaction (not turned with the body)
 *        ─ base (squash, lift)           scales about the ground, keeps volume
 *            └ pivot (yaw, pitch, roll)  turns about a point low in the body
 *                └ form (stretch)        taller and slimmer, or rounder and lower
 *                    └ content
 *                        ├ body          skin + fur shells (plush, velvet) or one solid mesh
 *                        ├ eyes ×2       dark domes with a catchlight (or whites and pupils,
 *                        │               or stitched thread); blink by squashing, closed as a curve
 *                        ├ brows, mouth  embroidered thread
 *                        └ accessories   canonical parts, fitted to the body's anchors
 *
 * The cuteness rules (D-033) live in the kit's face data: eyes large, low and
 * wide apart, one soft mass, a plush pile; the avatar's eye controls only move
 * within those ranges.
 *
 * Everything that changes with state (lids, look, brows, desaturation, fur
 * lag, hearts) is a transform or a uniform, so a state change never rebuilds
 * or recompiles. A config change rebuilds only what it touches.
 */

import * as THREE from "three";
import { defaultAccessoryColor } from "./accessory-colors";
import { avatarKey, formKey, furLengthOf, type AvatarConfig, type EyeStyle } from "./avatar2";
import { EYE_SHAPE, basisZ, eyeFrames, fitAccessories, type EyeFrame, type MatKey, type Placement } from "./fit";
import { kitSync, type Kit, type Lod, type ShapeId } from "./kit";
import { SHAPE_DATA } from "./kit-data";
import { heartGeometry, makeAccMaterial, makeFurMaterial, makeSolidMaterial, type AccMaterial, type AccMaterialKind, type FurMaterial, type SolidMaterial } from "./materials";
import { blush, colorHex, featureInk, hexToOklch, mixHex, patternPartner } from "./palette";
import type { Pose } from "./rig";

/* ——————————————————————————— Tuning ——————————————————————————— */

export interface Tuning {
  /** Eye size multiplier (small faces need bigger eyes to read). */
  eye: number;
  /** The body's level of detail. */
  lod: Lod;
  /** Kept for callers of the first engine. */
  detail: number;
  /** Fur shells (plush). */
  shells: number;
  /** Feature stroke multiplier (brows, mouth, closed eyes). */
  stroke: number;
  /** Relief multiplier (bumps alias when tiny). */
  bump: number;
  small: boolean;
}

/** Optical compensation and level of detail by rendered size (CSS px). */
export function tuning(size: number): Tuning {
  if (size <= 16) return { eye: 1.5, lod: "lod1", detail: 12, shells: 6, stroke: 1.9, bump: 0.2, small: true };
  if (size <= 20) return { eye: 1.42, lod: "lod1", detail: 12, shells: 7, stroke: 1.7, bump: 0.25, small: true };
  if (size <= 28) return { eye: 1.24, lod: "lod1", detail: 12, shells: 8, stroke: 1.45, bump: 0.35, small: true };
  if (size <= 48) return { eye: 1.12, lod: "lod1", detail: 12, shells: 12, stroke: 1.2, bump: 0.6, small: false };
  if (size <= 80) return { eye: 1.05, lod: "lod0", detail: 25, shells: 16, stroke: 1.08, bump: 0.8, small: false };
  if (size <= 140) return { eye: 1.0, lod: "lod0", detail: 25, shells: 22, stroke: 1, bump: 1, small: false };
  if (size <= 220) return { eye: 1.0, lod: "lod0", detail: 25, shells: 28, stroke: 1, bump: 1, small: false };
  return { eye: 1.0, lod: "lod0", detail: 25, shells: 34, stroke: 1, bump: 1, small: false };
}

/** Visible fur thickness in body units for a config. */
export const furLength = furLengthOf;

/* ——————————————————————————— Shared pieces ——————————————————————————— */

let shadowTex: THREE.Texture | null = null;
function shadowTexture() {
  if (shadowTex) return shadowTex;
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  const wide = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  wide.addColorStop(0, "rgba(0,0,0,0.3)");
  wide.addColorStop(0.5, "rgba(0,0,0,0.12)");
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

let glintGeo: THREE.CircleGeometry | null = null;
const glint = () => (glintGeo ??= new THREE.CircleGeometry(1, 24));

/** Raycast targets for placing features on a body (LOD0, one per shape). */
const rayMeshes = new Map<ShapeId, THREE.Mesh>();
let rayMat: THREE.MeshBasicMaterial | null = null;
function rayMesh(kit: Kit, shape: ShapeId) {
  let m = rayMeshes.get(shape);
  if (!m) {
    rayMat ??= new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
    m = new THREE.Mesh(kit.body(shape, "lod0"), rayMat);
    m.updateMatrixWorld(true);
    rayMeshes.set(shape, m);
  }
  return m;
}
const raycaster = new THREE.Raycaster();
const tri = new THREE.Triangle();
const bary = new THREE.Vector3();

function frontHit(kit: Kit, shape: ShapeId) {
  const mesh = rayMesh(kit, shape);
  const geo = mesh.geometry;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  return (x: number, y: number) => {
    raycaster.set(new THREE.Vector3(x, y, 3), new THREE.Vector3(0, 0, -1));
    const hit = raycaster.intersectObject(mesh, false)[0];
    if (!hit || !hit.face) return null;
    const { a, b, c } = hit.face;
    tri.set(new THREE.Vector3().fromBufferAttribute(pos, a), new THREE.Vector3().fromBufferAttribute(pos, b), new THREE.Vector3().fromBufferAttribute(pos, c));
    tri.getBarycoord(hit.point, bary);
    const n = new THREE.Vector3()
      .addScaledVector(new THREE.Vector3().fromBufferAttribute(nor, a), bary.x)
      .addScaledVector(new THREE.Vector3().fromBufferAttribute(nor, b), bary.y)
      .addScaledVector(new THREE.Vector3().fromBufferAttribute(nor, c), bary.z)
      .normalize();
    return { p: hit.point.clone(), n };
  };
}

/* ——————————————————————————— Materials by key ——————————————————————————— */

/** Texture frequency per body unit for soft goods (felt fibres, knit stitches, canvas weave). */
const SOFT: Partial<Record<AccMaterialKind, { base: number; body: number }>> = {
  felt: { base: 3, body: 7 },
  knit: { base: 7, body: 22 },
  canvas: { base: 9, body: 26 },
  velvet: { base: 3, body: 7 },
  thread: { base: 14, body: 40 },
};

function kindOf(key: MatKey): { kind: AccMaterialKind; color?: string; adjust?: (c: string) => string } {
  switch (key) {
    case "eye":
      return { kind: "gloss", color: "#141113" };
    case "eye_white":
      return { kind: "gloss", color: "#f6f4ef" };
    case "thread":
      return { kind: "thread", color: "#1d1816" };
    case "thread_hi":
      return { kind: "thread", color: "#f3f0ea" };
    case "glass":
      return { kind: "glass", color: "#ffffff" };
    case "shade":
      return { kind: "gloss", color: "#18161a" };
    case "metal":
      return { kind: "metal" };
    case "acetate":
      return { kind: "acetate" };
    case "vinyl_white":
      return { kind: "vinyl" };
    case "stem":
      return { kind: "vinyl", color: "#5f8f3f" };
    case "leaf":
      return { kind: "felt", color: "#78b04a" };
    case "stem_dark":
      return { kind: "vinyl", color: "#2e2f33" };
    case "petal":
      return { kind: "felt", color: "#fbf9f4" };
    case "acc_dark":
      return { kind: "felt", adjust: (c) => mixHex(c, "#000000", 0.22) };
    case "acc_light":
    case "pom":
      return { kind: "felt", adjust: (c) => mixHex(c, "#ffffff", key === "pom" ? 0.12 : 0.3) };
    case "knit":
      return { kind: "knit" };
    case "canvas":
      return { kind: "canvas" };
    case "velvet":
      return { kind: "velvet" };
    default:
      return { kind: "felt" };
  }
}

function maxScale(m: THREE.Matrix4) {
  const e = m.elements;
  return Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[4], e[5], e[6]), Math.hypot(e[8], e[9], e[10]));
}

/* ——————————————————————————— Eyes ——————————————————————————— */

interface EyeParts {
  group: THREE.Group;
  /** Moves with the look. */
  look: THREE.Group;
  /** Squashes to blink. */
  squash: THREE.Group;
  /** Moves inside the eye (pupils of wide and googly eyes). */
  inner: THREE.Object3D | null;
  /** Closed: asleep (‿) and smiling shut (∩). */
  asleep: THREE.Mesh;
  smiling: THREE.Mesh;
  r: number;
  style: EyeStyle;
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

interface BuiltAcc {
  node: THREE.Object3D;
  springy: number;
  rest: THREE.Euler;
}

const HEART_STARTS = [0.05, 0.16, 0.27];
const HEART_X = [-0.42, 0.06, 0.44];

export class Character {
  root = new THREE.Group();
  private base = new THREE.Group();
  private pivot = new THREE.Group();
  private form = new THREE.Group();
  private content = new THREE.Group();
  private shadow: THREE.Mesh;
  private hearts = new THREE.Group();
  private heartMeshes: THREE.Mesh[] = [];
  private heartMat: THREE.MeshPhysicalMaterial | null = null;

  cfg: AvatarConfig | null = null;
  key = "";
  private detailKey = "";
  tune: Tuning = tuning(64);
  fur = 0;
  bounds: Bounds = { top: 1, bottom: 0, half: 0.5 };
  private shape: ShapeId = "pebble";

  private skin: THREE.Mesh | null = null;
  private furMat: FurMaterial | null = null;
  private solidMat: SolidMaterial | null = null;
  private baseGeo: THREE.BufferGeometry | null = null;
  private press: THREE.BufferAttribute | null = null;
  private eyes: EyeParts[] = [];
  private frames: EyeFrame[] = [];
  private features = new THREE.Group();
  private brows: THREE.Group[] = [];
  private mouthSmile: THREE.Mesh | null = null;
  private mouthO: THREE.Group | null = null;
  private accGroup = new THREE.Group();
  private accs: BuiltAcc[] = [];
  private mats = new Map<string, AccMaterial>();
  private morph: Morph | null = null;
  private working: THREE.BufferGeometry | null = null;
  private imageTex: THREE.Texture | null = null;
  private shadowBase = { w: 1, d: 1 };
  private glintMatCache: THREE.MeshBasicMaterial | null = null;
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
    this.pivot.add(this.form);
    this.form.add(this.content);
    this.content.add(this.features, this.accGroup);
  }

  private mat(key: MatKey, color: string | undefined, partScale: number): AccMaterial {
    const k = kindOf(key);
    let c = k.color ?? color ?? "#3e4045";
    if (k.adjust) c = k.adjust(c);
    const soft = SOFT[k.kind];
    const scale = soft ? Math.max(0.15, Math.min(6, (soft.body * partScale) / soft.base)) : 1;
    const id = `${k.kind}|${c}|${scale.toFixed(2)}`;
    let m = this.mats.get(id);
    if (!m) {
      m = makeAccMaterial(k.kind, c, scale);
      this.mats.set(id, m);
    }
    return m;
  }

  /** Configure for a size. `morphAt` (ms) morphs the body from its current shape. */
  set(cfg: AvatarConfig, size: number, morphAt?: number) {
    const kit = kitSync();
    if (!kit) return;
    const tune = tuning(size);
    const key = avatarKey(cfg);
    const dk = `${tune.lod}|${tune.shells}|${tune.eye}`;
    if (key === this.key && dk === this.detailKey) return;
    const prev = this.cfg;
    const formChanged = !prev || formKey(prev) !== formKey(cfg) || dk !== this.detailKey;
    const matChanged = !prev || prev.material.kind !== cfg.material.kind || dk !== this.detailKey;
    this.cfg = cfg;
    this.key = key;
    this.detailKey = dk;
    this.tune = tune;
    this.fur = furLength(cfg);
    const shape = cfg.shape as ShapeId;
    this.shape = shape;
    const data = SHAPE_DATA[shape];
    const bodyHex = colorHex(cfg.color);

    /* Body geometry (morph when asked). */
    const geo = kit.body(shape, tune.lod);
    if (formChanged) {
      const prevGeo = this.baseGeo;
      if (morphAt !== undefined && prevGeo && prevGeo !== geo && prevGeo.attributes.position.count === geo.attributes.position.count) {
        const cur = this.working && this.morph ? this.working : prevGeo;
        const from = new Float32Array((cur.attributes.position as THREE.BufferAttribute).array as Float32Array);
        const fromN = new Float32Array((cur.attributes.normal as THREE.BufferAttribute).array as Float32Array);
        if (!this.working || this.working.attributes.position.count !== geo.attributes.position.count) {
          this.working?.dispose();
          this.working = new THREE.BufferGeometry();
          this.working.setIndex(geo.index);
          this.working.setAttribute("position", new THREE.BufferAttribute(new Float32Array(from), 3));
          this.working.setAttribute("normal", new THREE.BufferAttribute(new Float32Array(fromN), 3));
          this.working.setAttribute("uv", geo.attributes.uv);
        }
        this.working.setAttribute("ao", geo.attributes.ao);
        this.working.setAttribute("fur", geo.attributes.fur);
        this.morph = { from, fromN, to: geo, t0: morphAt };
      } else this.morph = null;
      this.baseGeo = geo;
    }

    /* Features and accessories are fitted first: the pile is pressed under them. */
    this.frames = eyeFrames(shape, cfg.eyes, this.fur, tune.eye, frontHit(kit, shape));
    const placements = fitAccessories(shape, cfg.accessories, this.fur, this.frames, (spec) => (spec.color ? colorHex(spec.color) : defaultAccessoryColor(spec.id, bodyHex)));

    /* Body material and the shells. */
    const kind = cfg.material.kind;
    const furry = kind === "plush" || kind === "velvet";
    if (matChanged) {
      this.furMat?.mat.dispose();
      this.solidMat?.mat.dispose();
      this.furMat = null;
      this.solidMat = null;
      if (furry) this.furMat = makeFurMaterial(kind === "velvet", kit.strands);
      else this.solidMat = makeSolidMaterial(kind as "knit" | "felt" | "vinyl" | "ceramic");
    }
    const drawGeo = this.morph && this.working ? this.working : geo;
    const shells = kind === "velvet" ? Math.max(4, Math.round(tune.shells * 0.35)) : tune.shells;
    this.press = new THREE.BufferAttribute(pressFor(geo, placements, kit, this.fur, data, cfg), 2);
    if (this.skin) {
      this.content.remove(this.skin);
      this.skin.geometry.dispose();
    }
    this.skin = new THREE.Mesh(furry ? shellGeometry(drawGeo, shells, this.press) : solidGeometry(drawGeo, this.press), furry ? this.furMat!.mat : this.solidMat!.mat);
    this.skin.frustumCulled = false;
    this.content.add(this.skin);
    if (this.furMat) this.furMat.u.uShells.value = shells;

    /* Surface uniforms (colour, pattern, cheeks, fur). */
    const u = (this.furMat ?? this.solidMat)!.u;
    u.uBase.value.set(bodyHex);
    u.uBounds.value.set(data.bounds.bottom, data.bounds.top, data.bounds.halfWidth, data.bounds.halfDepth);
    const p = cfg.pattern;
    const kinds = { none: 0, dip: 1, belly: 2, spots: 3, stripes: 4, image: 5 } as const;
    u.uPatKind.value = kinds[p.kind];
    u.uPatSeed.value = (parseInt(bodyHex.slice(1, 4), 16) % 97) * 0.13;
    if (p.kind !== "none" && p.kind !== "image") {
      u.uPat.value.set(colorHex(p.color));
      u.uPatScale.value = p.scale;
    }
    const fr = this.frames;
    if (cfg.cheeks && fr.length === 2) {
      u.uBlushCol.value.set(blush(bodyHex));
      const at = (f: EyeFrame) => new THREE.Vector3(f.side * f.r * 1.15, -f.r * 1.25, -f.r * 0.35).add(f.c);
      const b0 = at(fr[0]);
      const b1 = at(fr[1]);
      u.uBlush0.value.set(b0.x, b0.y, b0.z, fr[0].r * 1.25);
      u.uBlush1.value.set(b1.x, b1.y, b1.z, fr[1].r * 1.25);
    } else {
      u.uBlush0.value.set(0, -99, 0, 0.001);
      u.uBlush1.value.set(0, -99, 0, 0.001);
    }
    if (this.furMat) {
      const fu = this.furMat.u;
      const velvet = kind === "velvet";
      const dens = velvet ? 1 : cfg.material.furDensity;
      fu.uFurLen.value = this.fur * 1.2;
      fu.uCover.value = velvet ? 1.0 : 0.78 + dens * 0.2;
      fu.uSpread.value = velvet ? 0.004 : 0.022 + cfg.material.furLength * 0.02;
      fu.uTuftF.value = velvet ? 3.2 : 0.95 - cfg.material.furLength * 0.35;
      fu.uGravity.value = velvet ? 0 : 0.06 + cfg.material.furLength * 0.12;
      // Pale fur reads dirty with deep roots: its pile shadow is gentler.
      const lum = hexToOklch(bodyHex).l;
      fu.uAO.value = velvet ? 0.72 : 0.34 + Math.max(0, lum - 0.75) * 1.1;
      fu.uTip.value = velvet ? 0.05 : 0.12;
      const style = cfg.eyes.style;
      const [sx, sy] = EYE_SHAPE[style];
      const er = (f: EyeFrame) => (style === "sleepy" ? f.r * 0.7 : f.r * Math.max(sx, sy) * 0.94);
      if (fr[0]) fu.uFeat0.value.set(fr[0].skin.x, fr[0].skin.y, fr[0].skin.z, er(fr[0]));
      else fu.uFeat0.value.set(0, -99, 0, 0.001);
      if (fr[1]) fu.uFeat1.value.set(fr[1].skin.x, fr[1].skin.y, fr[1].skin.z, er(fr[1]));
      else fu.uFeat1.value.set(0, -99, 0, 0.001);
      this.furMat.mat.sheenColor.set(bodyHex).lerp(new THREE.Color(1, 1, 1), 0.6);
    }
    if (this.solidMat) {
      const su = this.solidMat.u;
      su.uBumpK.value = (kind === "knit" ? 0.022 : kind === "felt" ? 0.006 : kind === "vinyl" ? 0.0015 : 0.0022) * tune.bump;
      const circ = Math.PI * (data.bounds.halfWidth + data.bounds.halfDepth);
      su.uKnitCols.value = Math.max(24, Math.round((circ * 7) / 8) * 8);
      su.uKnitRows.value = 7.5;
      if (kind === "felt" || kind === "knit") this.solidMat.mat.sheenColor.set(bodyHex).lerp(new THREE.Color(1, 1, 1), 0.5);
    }
    this.loadImage(cfg);

    /* Eyes, features, accessories. */
    this.buildEyes(cfg, kit);
    this.buildFeatures(cfg, kit, bodyHex);
    this.buildAccessories(placements, kit);
    this.buildHearts(bodyHex);

    /* Stretch, shadow and framing. */
    const st = cfg.stretch;
    const sy = 1 + 0.16 * st;
    const sxz = 1 / Math.sqrt(sy);
    this.form.scale.set(sxz, sy, sxz);
    const half = data.bounds.halfWidth * sxz;
    const furPad = this.fur * 0.9;
    this.shadow.position.y = data.bounds.bottom + 0.004;
    const bodyTop = data.bounds.top * sy + furPad;
    const bodyHalf = half + furPad;
    let top = bodyTop;
    let hw = bodyHalf;
    for (const pl of placements) {
      const g = kit.part(pl.part);
      if (!g?.boundingBox) continue;
      const bb = g.boundingBox.clone().applyMatrix4(pl.matrix);
      top = Math.max(top, Math.min(bb.max.y * sy, bodyTop + data.bounds.top * (tune.small ? 0.1 : 0.26)));
      hw = Math.max(hw, Math.min(Math.max(Math.abs(bb.min.x), Math.abs(bb.max.x)) * sxz, bodyHalf * 1.06));
    }
    this.bounds = { top, bottom: data.bounds.bottom, half: hw };
    const h = data.bounds.top * sy - data.bounds.bottom;
    this.base.position.y = data.bounds.bottom;
    this.pivot.position.y = h * 0.4;
    this.form.position.y = -h * 0.4;
    this.content.position.y = -data.bounds.bottom;
    this.shadowBase = { w: half * 2.5 + this.fur * 2, d: data.bounds.halfDepth * sxz * 2.3 + this.fur * 2 };
    this.shadow.scale.set(this.shadowBase.w, this.shadowBase.d, 1);
  }

  private loadImage(cfg: AvatarConfig) {
    const u = (this.furMat ?? this.solidMat)!.u;
    const p = cfg.pattern;
    if (p.kind !== "image") {
      this.ready = Promise.resolve();
      return;
    }
    const b = SHAPE_DATA[this.shape].bounds;
    const w = Math.max(b.halfWidth * 2, b.top - b.bottom) * 1.02;
    u.uImageBox.value.set(-w / 2, (b.top + b.bottom) / 2 - w / 2, w, w);
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

  private glintMat() {
    this.glintMatCache ??= new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.92 });
    return this.glintMatCache;
  }

  private buildEyes(cfg: AvatarConfig, kit: Kit) {
    for (const e of this.eyes) this.features.remove(e.group);
    this.eyes = [];
    const style = cfg.eyes.style;
    const [sx, sy, sd] = EYE_SHAPE[style];
    const part = (n: string) => kit.part(n) ?? new THREE.SphereGeometry(1, 24, 12);
    const stroke = this.tune.stroke;
    const ink = style === "stitched" ? this.mat("thread", undefined, 0.1) : this.mat("eye", undefined, 0.1);
    const glintMat = this.glintMat();
    for (const f of this.frames) {
      const group = new THREE.Group();
      group.position.copy(f.c);
      group.quaternion.setFromRotationMatrix(f.basis);
      const look = new THREE.Group();
      const squash = new THREE.Group();
      group.add(look);
      look.add(squash);
      const r = f.r;
      let inner: THREE.Object3D | null = null;
      const add = (geo: THREE.BufferGeometry, m: THREE.Material, s: [number, number, number], p: [number, number, number] = [0, 0, 0], parent: THREE.Object3D = squash) => {
        const mesh = new THREE.Mesh(geo, m);
        mesh.scale.set(...s);
        mesh.position.set(...p);
        parent.add(mesh);
        return mesh;
      };
      const domeZ = (x: number, y: number, ax: number, ay: number, az: number) => az * Math.sqrt(Math.max(0, 1 - (x / ax) ** 2 - (y / ay) ** 2));
      if (style === "oval" || style === "button" || style === "bead") {
        const ax = r * sx;
        const ay = r * sy;
        const az = r * sd;
        add(part("eye.dome"), this.mat("eye", undefined, 0.1).mat, [ax, ay, az]);
        // One soft catchlight up and to the left, and a small one below.
        const gx = -ax * 0.34;
        const gy = ay * 0.4;
        add(glint(), glintMat, [ax * 0.26, ay * 0.26, 1], [gx, gy, domeZ(gx, gy, ax, ay, az) + 0.0015]);
        const hx = ax * 0.3;
        const hy = -ay * 0.36;
        add(glint(), glintMat, [ax * 0.1, ay * 0.1, 1], [hx, hy, domeZ(hx, hy, ax, ay, az) + 0.0015]);
      } else if (style === "stitched") {
        add(part("eye.dome"), this.mat("thread", undefined, r).mat, [r * sx, r * sy, r * sd]);
        add(part("eye.stitch_hi"), this.mat("thread_hi", undefined, r).mat, [r * sx, r * sy, r * sd]);
      } else if (style === "wide" || style === "googly") {
        const ax = r * sx;
        const ay = r * sy;
        const az = r * sd;
        add(part("eye.white"), this.mat("eye_white", undefined, 0.1).mat, [ax, ay, az]);
        const pupil = new THREE.Group();
        squash.add(pupil);
        const pr = style === "wide" ? 0.62 : 0.56;
        add(part("eye.pupil"), this.mat("eye", undefined, 0.1).mat, [r * pr, r * pr, r * 0.2], [0, 0, 0], pupil);
        add(glint(), glintMat, [r * 0.16, r * 0.16, 1], [-r * 0.2, r * 0.22, r * 0.06], pupil);
        pupil.position.z = az * 0.98;
        inner = pupil;
        if (style === "googly") add(part("eye.cover"), this.mat("glass", undefined, 0.1).mat, [ax * 1.02, ay * 1.02, az * 1.25]);
      }
      // Closed eyes: one soft stroke. Sleepy eyes are closed at rest.
      const arcK = 0.85 * (style === "googly" || style === "wide" ? 1.1 : 1);
      const asleep = new THREE.Mesh(part("eye.closed"), ink.mat);
      const smiling = new THREE.Mesh(part("eye.smiling"), ink.mat);
      for (const m of [asleep, smiling]) {
        m.scale.set(r * arcK, r * arcK, r * arcK * (0.9 + 0.1 * stroke));
        m.position.z = r * 0.1;
        m.visible = false;
        look.add(m);
      }
      this.eyes.push({ group, look, squash, inner, asleep, smiling, r, style });
      this.features.add(group);
    }
  }

  private buildFeatures(cfg: AvatarConfig, kit: Kit, bodyHex: string) {
    for (const b of this.brows) this.features.remove(b);
    if (this.mouthSmile) this.features.remove(this.mouthSmile);
    if (this.mouthO) this.features.remove(this.mouthO);
    this.brows = [];
    this.mouthSmile = null;
    this.mouthO = null;
    if (this.furMat) this.furMat.u.uFeat2.value.set(0, -99, 0, 0.001);
    const fr = this.frames;
    if (fr.length < 2) return;
    const ink = this.mat("thread", featureInk(bodyHex), 0.1);
    ink.mat.color.set(featureInk(bodyHex));
    const r = fr[0].r;
    const stroke = this.tune.stroke;
    if (cfg.brows !== "none") {
      fr.forEach((f) => {
        const g = new THREE.Group();
        g.position.copy(f.c).addScaledVector(new THREE.Vector3(0, 1, 0), r * 1.6).addScaledVector(f.n, this.fur * 0.35);
        g.quaternion.setFromRotationMatrix(f.basis);
        const inner = new THREE.Group();
        g.add(inner);
        const m = new THREE.Mesh(kit.part("brow") ?? new THREE.CapsuleGeometry(0.2, 1), ink.mat);
        const arch = cfg.brows === "arched" ? 1.4 : cfg.brows === "straight" ? 0.15 : 0.8;
        m.scale.set(r * 0.62, r * 0.62 * arch, r * 0.5 * stroke);
        inner.add(m);
        g.userData.side = f.side;
        this.brows.push(g);
        this.features.add(g);
      });
    }
    // The mouth: under the eyes, between them, on the surface.
    const y = (fr[0].skin.y + fr[1].skin.y) / 2 - r * 1.45;
    const hit = frontHit(kit, this.shape)(0, y);
    if (!hit) return;
    const R = basisZ(hit.n.clone().multiplyScalar(0.6).add(new THREE.Vector3(0, 0, 0.4)));
    const at = hit.p.clone().addScaledVector(hit.n, this.fur * 0.35);
    if (cfg.mouth === "smile") {
      const m = new THREE.Mesh(kit.part("mouth.smile") ?? new THREE.TorusGeometry(1, 0.1), ink.mat);
      m.position.copy(at);
      m.quaternion.setFromRotationMatrix(R);
      m.scale.set(r * 0.5, r * 0.5, r * 0.4 * stroke);
      this.mouthSmile = m;
      this.features.add(m);
    }
    const o = new THREE.Group();
    o.position.copy(at);
    o.quaternion.setFromRotationMatrix(R);
    const om = new THREE.Mesh(kit.part("mouth.o") ?? new THREE.SphereGeometry(1), this.mat("eye", undefined, 0.1).mat);
    om.scale.set(r * 0.3, r * 0.24, r * 0.14);
    o.add(om);
    o.userData.base = cfg.mouth === "dot" ? 1 : 0;
    o.visible = cfg.mouth === "dot";
    this.mouthO = o;
    this.features.add(o);
    if (this.furMat && cfg.mouth !== "none") this.furMat.u.uFeat2.value.set(hit.p.x, hit.p.y, hit.p.z, r * 0.6);
  }

  private buildAccessories(placements: Placement[], kit: Kit) {
    for (const a of this.accs) this.accGroup.remove(a.node);
    this.accs = [];
    // Springy parts of one accessory swing about one pivot.
    const pivots = new Map<string, THREE.Group>();
    for (const pl of placements) {
      const geo = kit.part(pl.part);
      if (!geo) continue;
      const s = maxScale(pl.matrix);
      const m = this.mat(pl.material, pl.color, s);
      const mesh = new THREE.Mesh(geo, m.mat);
      mesh.matrixAutoUpdate = false;
      if (pl.springy) {
        const key = `${pl.acc}|${pl.matrix.elements[12].toFixed(3)}`;
        let pivot = pivots.get(key);
        if (!pivot) {
          pivot = new THREE.Group();
          pivot.position.setFromMatrixPosition(pl.matrix);
          pivots.set(key, pivot);
          this.accGroup.add(pivot);
          this.accs.push({ node: pivot, springy: pl.springy, rest: pivot.rotation.clone() });
        }
        mesh.matrix.makeTranslation(-pivot.position.x, -pivot.position.y, -pivot.position.z).multiply(pl.matrix);
        pivot.add(mesh);
      } else {
        mesh.matrix.copy(pl.matrix);
        this.accGroup.add(mesh);
        this.accs.push({ node: mesh, springy: 0, rest: new THREE.Euler() });
      }
      // Lenses are see-through: draw them after the eyes.
      if (pl.material === "glass") mesh.renderOrder = 2;
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
    this.heartMat.color.set(lch.l > 0.86 ? patternPartner(bodyHex) : bodyHex);
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
      const skin = this.skin;
      if (skin && this.press) {
        const shells = skin.geometry instanceof THREE.InstancedBufferGeometry ? skin.geometry.instanceCount : 0;
        skin.geometry.dispose();
        skin.geometry = shells ? shellGeometry(m.to, shells, this.press) : solidGeometry(m.to, this.press);
      }
    }
  }

  pose(p: Pose, now: number) {
    const cfg = this.cfg;
    if (!cfg) return;
    this.stepMorph(now);
    const data = SHAPE_DATA[this.shape];
    const s = Math.max(0.5, p.squash);
    const w = 1 / Math.sqrt(s);
    this.base.position.y = data.bounds.bottom + p.lift;
    this.base.scale.set(w * p.scale, s * p.scale, w * p.scale);
    this.pivot.rotation.set(p.pitch, p.yaw, p.roll, "YXZ");
    // Shadow: shrinks and fades as the body leaves the ground.
    const lifted = Math.max(0, p.lift);
    const sm = this.shadow.material as THREE.MeshBasicMaterial;
    sm.opacity = Math.max(0, (1 - lifted * 1.8) * this.shadowOpacity) * Math.min(1, p.scale * 1.2);
    const sk = (1 - Math.min(0.5, lifted * 0.9)) * p.scale * w;
    this.shadow.scale.set(this.shadowBase.w * sk, this.shadowBase.d * sk, 1);

    // Surface.
    const u = (this.furMat ?? this.solidMat)!.u;
    u.uDesat.value = p.desat;
    if (this.furMat) {
      const fu = this.furMat.u;
      fu.uFurLen.value = this.fur * 1.2 * (1 - 0.4 * p.matte);
      fu.uLag.value.set(p.lagX * 0.9, p.lagY * 0.6, 0);
      fu.uSquashInv.value.set(1 / w, 1 / s, 1 / w);
      this.furMat.mat.sheen = (cfg.material.kind === "velvet" ? 1 : 0.45) * (1 - 0.55 * p.matte);
    }
    if (this.solidMat) {
      const sb = this.solidMat.base;
      this.solidMat.mat.roughness = sb.roughness + (1 - sb.roughness) * p.matte * 0.7;
      this.solidMat.mat.clearcoat = Math.max(1e-4, sb.clearcoat * (1 - p.matte));
    }
    for (const m of this.mats.values()) m.desat.value = p.desat;

    // Eyes.
    const lookX = Math.max(-1, Math.min(1, p.lookX));
    const lookY = Math.max(-1, Math.min(1, p.lookY));
    for (const e of this.eyes) {
      const r = e.r;
      const open = p.eyeOpen;
      if (e.inner) {
        if (e.style === "googly") {
          const gx = Math.max(-1, Math.min(1, p.googX + lookX * 0.4));
          const gy = Math.max(-1, Math.min(1, p.googY + lookY * 0.4));
          const l = Math.hypot(gx, gy);
          const k = l > 1 ? 1 / l : 1;
          e.inner.position.x = gx * k * r * 0.5;
          e.inner.position.y = gy * k * r * 0.5;
        } else {
          e.inner.position.x = lookX * r * 0.34;
          e.inner.position.y = lookY * r * 0.3;
        }
        e.look.position.set(lookX * r * 0.06, lookY * r * 0.05, 0);
      } else {
        e.look.position.set(lookX * r * 0.24, lookY * r * 0.18, 0);
      }
      // Sleepy eyes rest closed (content); every eye closes into a soft stroke.
      const closedAtRest = e.style === "sleepy" && open <= 1.04;
      const shut = closedAtRest || open < 0.14;
      e.squash.visible = !shut;
      e.asleep.visible = shut && p.hearts < 0;
      e.smiling.visible = shut && p.hearts >= 0;
      const o = Math.max(0.08, Math.min(1.12, open));
      const wide = Math.max(0, open - 1);
      e.squash.scale.set(1 + wide * 0.3, o * (1 + wide * 0.3), 1);
    }
    // Brows.
    for (const b of this.brows) {
      const side = b.userData.side as number;
      const r = this.eyes[0]?.r ?? 0.1;
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
    for (const a of this.accs)
      if (a.springy) {
        a.node.rotation.z = a.rest.z - p.lagX * a.springy * 2.2;
        a.node.rotation.x = a.rest.x + p.lagY * a.springy * 1.2;
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
      const hs = 0.16 + (i === 1 ? 0.03 : 0);
      m.scale.setScalar(Math.max(0.001, pop) * hs);
      // Hearts rise from the head and fade before they leave the frame.
      m.position.set(HEART_X[i] * (this.bounds.half * 0.9), this.bounds.top * 0.72 + lt * 0.3, 0.3);
      m.rotation.set(0, 0, Math.sin(lt * Math.PI * 2 + i) * 0.25);
    }
  }

  dispose() {
    this.furMat?.mat.dispose();
    this.solidMat?.mat.dispose();
    this.skin?.geometry.dispose();
    this.working?.dispose();
    (this.shadow.material as THREE.Material).dispose();
    for (const m of this.mats.values()) m.mat.dispose();
    this.mats.clear();
    this.glintMatCache?.dispose();
    this.heartMat?.dispose();
    this.imageTex?.dispose();
  }
}

/* ——————————————————————————— Geometry helpers ——————————————————————————— */

function shellGeometry(base: THREE.BufferGeometry, shells: number, press: THREE.BufferAttribute): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  g.index = base.index;
  g.setAttribute("position", base.attributes.position);
  g.setAttribute("normal", base.attributes.normal);
  g.setAttribute("ao", base.attributes.ao);
  g.setAttribute("fur", base.attributes.fur);
  g.setAttribute("press", press);
  g.instanceCount = shells;
  g.boundingSphere = base.boundingSphere?.clone() ?? null;
  if (g.boundingSphere) g.boundingSphere.radius += 0.3;
  return g;
}

/** Solid bodies (felt, knit, vinyl, ceramic) share the attributes but draw once. */
function solidGeometry(base: THREE.BufferGeometry, press: THREE.BufferAttribute): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.index = base.index;
  g.setAttribute("position", base.attributes.position);
  g.setAttribute("normal", base.attributes.normal);
  g.setAttribute("ao", base.attributes.ao);
  g.setAttribute("fur", base.attributes.fur);
  g.setAttribute("press", press);
  g.boundingSphere = base.boundingSphere?.clone() ?? null;
  return g;
}

/**
 * Where accessories sit, the pile is pressed down: per vertex (density,
 * length). Mirrors crew_compose.covered + accessory_distance: hats clear the
 * crown, headphone cups clear the ears, and anything touching the body
 * flattens the fur under it.
 */
function pressFor(geo: THREE.BufferGeometry, placements: Placement[], kit: Kit, fur: number, data: (typeof SHAPE_DATA)[ShapeId], cfg: AvatarConfig): Float32Array {
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const n = pos.count;
  const out = new Float32Array(n * 2).fill(1);
  if (!placements.length) return out;
  // A spatial hash of the accessory surfaces (eyewear floats in front: skipped).
  const cell = 0.06;
  const grid = new Map<string, number[]>();
  const v = new THREE.Vector3();
  for (const pl of placements) {
    if (pl.part.startsWith("eyewear")) continue;
    const g = kit.part(pl.part);
    if (!g) continue;
    const pp = g.attributes.position as THREE.BufferAttribute;
    const step = pp.count > 1200 ? 2 : 1;
    for (let i = 0; i < pp.count; i += step) {
      v.fromBufferAttribute(pp, i).applyMatrix4(pl.matrix);
      const k = `${Math.floor(v.x / cell)},${Math.floor(v.y / cell)},${Math.floor(v.z / cell)}`;
      let arr = grid.get(k);
      if (!arr) grid.set(k, (arr = []));
      arr.push(v.x, v.y, v.z);
    }
  }
  const ids = new Set(cfg.accessories.map((a) => a.id));
  const hat = ids.has("cap") || ids.has("beanie") || ids.has("bucket");
  const capY = data.anchors.crown.capY - 0.05;
  const ears = data.anchors.ears;
  for (let i = 0; i < n; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    let best = 9;
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const cz = Math.floor(z / cell);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const arr = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!arr) continue;
          for (let j = 0; j < arr.length; j += 3) {
            const d = (arr[j] - x) ** 2 + (arr[j + 1] - y) ** 2 + (arr[j + 2] - z) ** 2;
            if (d < best) best = d;
          }
        }
    const d = Math.sqrt(best);
    let dens = Math.min(1, Math.max(0, (d - 0.004) / 0.03));
    const len = Math.min(1, Math.max(0.2, (d - 0.01) / (fur * 1.6)));
    if (hat) dens *= 1 - Math.min(1, Math.max(0, (y - capY) / 0.04));
    if (ids.has("headphones"))
      for (const e of ears) {
        const de = Math.hypot(x - e.p[0], y - e.p[1], z - e.p[2]);
        dens *= Math.min(1, Math.max(0, (de - 0.2) / 0.06));
      }
    out[i * 2] = dens;
    out[i * 2 + 1] = len;
  }
  return out;
}

function backOut(t: number) {
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
}
