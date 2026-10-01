/**
 * Fitting the eyes and accessories onto a body (three.js math, no scene).
 *
 * The TypeScript twin of tools/crew/blender/crew_fit.py: the Cycles stills and
 * the live renderer place every part with the same rules and the same numbers
 * (kit-data.ts). Keep the two in step.
 *
 * Every accessory part is modeled in a canonical frame (see crew_parts.py):
 * hats on a unit band, eyewear on a unit rim, arcs as a unit half ellipse,
 * neck pieces on a unit ring, small things in body units. Fitting is a matrix
 * per part from the body's anchors, the eyes and the visible fur thickness
 * (accessories sit on the pile, not under it).
 */

import * as THREE from "three";
import { ACCESSORIES, type AccessoryId, type AccessorySpec, type AvatarConfig, type EyeStyle } from "./avatar2";
import { SHAPE_DATA } from "./kit-data";
import type { ShapeId } from "./kit";
import { colorHex } from "./palette";

export type MatKey =
  | "eye"
  | "eye_white"
  | "thread"
  | "thread_hi"
  | "glass"
  | "shade"
  | "metal"
  | "acetate"
  | "vinyl_white"
  | "stem"
  | "leaf"
  | "stem_dark"
  | "petal"
  | "acc"
  | "acc_dark"
  | "acc_light"
  | "knit"
  | "canvas"
  | "velvet"
  | "pom";

export interface Placement {
  part: string;
  matrix: THREE.Matrix4;
  material: MatKey;
  /** The accessory's colour (resolved by the caller when absent). */
  color?: string;
  acc: AccessoryId;
  /** Parts that swing with the head's secondary motion (antenna, sprout, hoops). */
  springy?: number;
}

export interface EyeFrame {
  /** Centre of the eye, on the pile. */
  c: THREE.Vector3;
  /** The direction the eye faces (between the surface normal and straight ahead). */
  n: THREE.Vector3;
  /** Columns: across, up, out. */
  basis: THREE.Matrix4;
  /** Eye half-height. */
  r: number;
  side: -1 | 1;
  /** The skin point under the eye (for the fur parting and the blush). */
  skin: THREE.Vector3;
}

/** Eye proportions per style: across, up and depth as fractions of the eye radius. */
export const EYE_SHAPE: Record<EyeStyle, [number, number, number]> = {
  oval: [0.74, 1.0, 0.5],
  button: [0.9, 0.9, 0.5],
  bead: [0.6, 0.6, 0.55],
  sleepy: [0.92, 0.92, 0.45],
  wide: [1.0, 1.04, 0.55],
  googly: [1.12, 1.12, 0.62],
  stitched: [0.72, 0.96, 0.16],
};

const v3 = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]);
const lerp = (r: readonly [number, number], t: number) => r[0] + (r[1] - r[0]) * t;

/** Columns x, y, z with z along `z` and y as close to `up` as possible. */
export function basisZ(z: THREE.Vector3, up = new THREE.Vector3(0, 1, 0)): THREE.Matrix4 {
  const zz = z.clone().normalize();
  let y = up.clone().sub(zz.clone().multiplyScalar(up.dot(zz)));
  if (y.lengthSq() < 1e-10) y = new THREE.Vector3(0, 0, -1).sub(zz.clone().multiplyScalar(-zz.z));
  y.normalize();
  const x = new THREE.Vector3().crossVectors(y, zz);
  return new THREE.Matrix4().makeBasis(x, y, zz);
}

/** Columns x, y, z with y along `yv` and z as close to `fwd` as possible. */
export function basisY(yv: THREE.Vector3, fwd = new THREE.Vector3(0, 0, 1)): THREE.Matrix4 {
  const yy = yv.clone().normalize();
  let z = fwd.clone().sub(yy.clone().multiplyScalar(fwd.dot(yy)));
  if (z.lengthSq() < 1e-10) z = new THREE.Vector3(0, 0, 1);
  z.normalize();
  const x = new THREE.Vector3().crossVectors(yy, z);
  return new THREE.Matrix4().makeBasis(x, yy, z);
}

const rotX = (a: number) => new THREE.Matrix4().makeRotationX(a);
const rotY = (a: number) => new THREE.Matrix4().makeRotationY(a);
const rotZ = (a: number) => new THREE.Matrix4().makeRotationZ(a);

/** R · S, translated: the same as crew_fit.mat(R, t, s). */
function place(R: THREE.Matrix4 | null, t: THREE.Vector3 | readonly number[], s: number | readonly [number, number, number]): THREE.Matrix4 {
  const S = typeof s === "number" ? new THREE.Matrix4().makeScale(s, s, s) : new THREE.Matrix4().makeScale(s[0], s[1], s[2]);
  const M = (R ? R.clone() : new THREE.Matrix4()).multiply(S);
  const tv = t instanceof THREE.Vector3 ? t : v3(t);
  M.setPosition(tv);
  return M;
}

function col(m: THREE.Matrix4, i: number) {
  const e = m.elements;
  return new THREE.Vector3(e[i * 4], e[i * 4 + 1], e[i * 4 + 2]);
}

/** Half-width of a shape at height y (from the kit's table). */
export function halfWidthAt(shape: ShapeId, y: number): number {
  const s = SHAPE_DATA[shape];
  const n = s.hw.length;
  const t = (y / s.bounds.top) * n - 0.5;
  const i = Math.max(0, Math.min(n - 2, Math.floor(t)));
  const f = Math.max(0, Math.min(1, t - i));
  return s.hw[i] + (s.hw[i + 1] - s.hw[i]) * f;
}

export type FrontHit = (x: number, y: number) => { p: THREE.Vector3; n: THREE.Vector3 } | null;

/** The eye frames for an avatar's eye controls, on the body (front hits come from the caller's raycast). */
export function eyeFrames(shape: ShapeId, eyes: AvatarConfig["eyes"], fur: number, eyeScale: number, front: FrontHit): EyeFrame[] {
  const fc = SHAPE_DATA[shape].face;
  const H = fc.top;
  const y = lerp(fc.y, eyes.y) * H;
  const hw = fc.hw ?? halfWidthAt(shape, y);
  const x = lerp(fc.gap, eyes.gap) * hw;
  const r = lerp(fc.r, eyes.size) * H * eyeScale;
  const out: EyeFrame[] = [];
  for (const side of [-1, 1] as const) {
    const hit = front(side * x, y);
    if (!hit) continue;
    const n = hit.n.clone().multiplyScalar(0.55).add(new THREE.Vector3(0, 0, 0.45)).normalize();
    const c = hit.p.clone().addScaledVector(hit.n, fur * 0.42);
    out.push({ c, n, basis: basisZ(n), r, side, skin: hit.p.clone() });
  }
  return out;
}

/** The colour an accessory wears when the person has not chosen one: chosen to sit with the body. */
export { defaultAccessoryColor } from "./accessory-colors";

/** Placements for every accessory part (eyes are built by the character from the frames). */
export function fitAccessories(shape: ShapeId, specs: AccessorySpec[], fur: number, frames: EyeFrame[], resolve: (spec: AccessorySpec) => string): Placement[] {
  const a = SHAPE_DATA[shape].anchors;
  const out: Placement[] = [];
  for (const spec of specs) {
    const id = spec.id;
    const color = resolve(spec);
    const P = (part: string, matrix: THREE.Matrix4, material: MatKey, springy?: number) => out.push({ part, matrix, material, color, acc: id, springy });
    switch (id) {
      case "cap":
      case "beanie":
      case "bucket": {
        const cr = a.crown;
        const r = Math.max(cr.r, 0.34) + fur * 0.85;
        const rz = Math.max(cr.rz, 0.3) + fur * 0.85;
        const ravg = 0.5 * (r + rz);
        const B = new THREE.Vector3(0, cr.capY, cr.cz);
        const tilt = rotZ(-0.1).multiply(rotX(-0.05));
        const parts: [string, MatKey][] =
          id === "cap"
            ? [
                ["cap.crown", "acc"],
                ["cap.button", "acc"],
                ["cap.brim", "acc_dark"],
              ]
            : id === "beanie"
              ? [
                  ["beanie.dome", "acc"],
                  ["beanie.cuff", "knit"],
                  ["beanie.pom", "pom"],
                ]
              : [
                  ["bucket.crown", "canvas"],
                  ["bucket.brim", "canvas"],
                  ["bucket.band", "acc_dark"],
                ];
        for (const [part, m] of parts) P(part, place(tilt, B, [r, ravg * (id === "beanie" ? 0.9 : 1.0), rz]), m);
        break;
      }
      case "sprout":
      case "antenna": {
        const cr = a.crown;
        const R = basisY(v3(cr.n));
        const c = v3(cr.p).addScaledVector(v3(cr.n), fur * 0.45);
        const s = id === "sprout" ? 2.0 : 1.2;
        if (id === "sprout") {
          P("sprout.stem", place(R, c, s), "stem", 0.5);
          P("sprout.leaves", place(R, c, s), "leaf", 0.5);
        } else {
          P("antenna.stem", place(R, c, s), "stem_dark", 1);
          P("antenna.ball", place(R, c, s), "acc", 1);
        }
        break;
      }
      case "flower": {
        const pn = a.pin;
        const R = basisY(v3(pn.n), new THREE.Vector3(0, 1, 0.3));
        const c = v3(pn.p).addScaledVector(v3(pn.n), fur * 0.8);
        P("flower.petals", place(R, c, 2.3), "petal");
        P("flower.centre", place(R, c, 2.3), "acc");
        break;
      }
      case "bow": {
        const pn = a.pin;
        const n = v3(pn.n);
        const R = basisZ(n.clone().multiplyScalar(0.6).add(new THREE.Vector3(0, 0, 0.4))).multiply(rotZ(-0.35));
        const c = v3(pn.p).addScaledVector(n, fur * 0.75);
        P("bow.ribbon", place(R, c, 1.9), "velvet");
        P("bow.knot", place(R, c, 1.9), "velvet");
        break;
      }
      case "round":
      case "square":
      case "shades":
      case "monocle": {
        if (frames.length < 2) break;
        const round = id === "round" || id === "monocle";
        const k = round ? 1.85 : 1.72;
        const nf = frames[0].n.clone().add(frames[1].n).normalize();
        const R = basisZ(nf);
        const cs = frames.map((fr) => fr.c.clone().addScaledVector(nf, fr.r * 0.55 + 0.012 + fur * 0.25));
        const s = Math.max(frames[0].r, frames[1].r) * k;
        const rim = round ? "eyewear.rim_round" : "eyewear.rim_square";
        const lens = id === "shades" ? "eyewear.lens_shade" : round ? "eyewear.lens_round" : "eyewear.lens_square";
        const rimMat: MatKey = round ? "metal" : "acetate";
        const lensMat: MatKey = id === "shades" ? "shade" : "glass";
        const which = id === "monocle" ? [1] : [0, 1];
        for (const i of which) {
          P(rim, place(R, cs[i], s), rimMat);
          P(lens, place(R, cs[i], s), lensMat);
        }
        if (id === "monocle") P("eyewear.chain", place(R, cs[1], s), "metal", 0.6);
        else {
          const x = col(R, 0);
          const ko = id === "round" ? 1.0 : 1.06;
          const a0 = cs[0].clone().addScaledVector(x, s * ko);
          const a1 = cs[1].clone().addScaledVector(x, -s * ko);
          const L = a0.distanceTo(a1);
          P(id === "round" ? "eyewear.bridge" : "eyewear.bridge_thick", place(R, a0, [L, s * 0.9, s * 0.9]), rimMat);
          const earZ = a.ears[0].p[2];
          for (const [i, sgn] of [
            [0, -1],
            [1, 1],
          ] as const) {
            const o = cs[i].clone().addScaledVector(x, sgn * s * (id === "round" ? 1.0 : 1.08));
            const Lt = Math.max(0.05, o.z - earZ);
            P("eyewear.temple", place(R, o, [s, s, Lt]), rimMat);
          }
        }
        break;
      }
      case "headphones":
      case "headband": {
        const [e0, e1] = a.ears;
        const cr = a.crown;
        const ex = Math.abs(e1.p[0]) + fur * 1.1;
        const ey = e1.p[1];
        if (id === "headphones") {
          const cz = e1.p[2] + 0.05;
          const top = a.top + fur * 1.0;
          const ry = top - ey;
          const cup = 0.23;
          P("headphones.arc", place(null, [0, ey, cz], [ex + 0.09, ry + 0.03, 1.8]), "acc_dark");
          for (const [e, side] of [
            [e0, -1],
            [e1, 1],
          ] as const) {
            const Rr = rotY(side > 0 ? 0 : Math.PI);
            const c = new THREE.Vector3(side * (Math.abs(e.p[0]) + fur * 0.9 + cup * 0.32), e.p[1], e.p[2] + 0.05);
            P("headphones.cup", place(Rr, c, cup), "acc");
            P("headphones.pad", place(Rr, c, cup), "acc_dark");
          }
        } else {
          const exh = Math.abs(e1.p[0]) + fur * 0.8;
          const ryh = cr.p[1] + fur * 0.85 - ey;
          const Rb = rotX(0.42);
          P("headband.band", place(Rb, [0, ey, e1.p[2]], [exh, ryh, 0.8]), "velvet");
          const kp = new THREE.Vector3(Math.cos(1.0) * exh, Math.sin(1.0) * ryh, 0).applyMatrix4(Rb).add(new THREE.Vector3(0, ey, e1.p[2] + 0.02));
          P("headband.knot", place(rotZ(-0.6), kp, 0.7), "velvet");
        }
        void ex;
        break;
      }
      case "earbuds":
      case "hoops": {
        for (const [e, side] of [
          [a.ears[0], -1],
          [a.ears[1], 1],
        ] as const) {
          const Rr = rotY(side > 0 ? 0 : Math.PI);
          const c = new THREE.Vector3(side * (Math.abs(e.p[0]) + fur * 0.95 + 0.03), e.p[1] - (id === "earbuds" ? 0.02 : 0.04), e.p[2] + 0.06);
          if (id === "earbuds") P("earbuds.bud", place(Rr, c, 0.15), "vinyl_white");
          else P("hoops.ring", place(Rr, c, 0.1), "metal", 0.8);
        }
        break;
      }
      case "scarf":
      case "bandana": {
        const nk = a.neck;
        const rx = nk.rx + fur * 0.8;
        const rz = nk.rz + fur * 0.8;
        const rr = 0.5 * (rx + rz);
        if (id === "scarf") {
          P("scarf.ring", place(null, [0, nk.y, nk.cz], [rx, rr, rz]), "knit");
          P("scarf.tail", place(null, [0, nk.y, nk.cz], [rx, rr, rz]), "knit", 0.3);
        } else {
          P("bandana.cloth", place(null, [0, nk.y + 0.04, nk.cz], [rx, rr * 0.8, rz]), "canvas");
          P("bandana.band", place(null, [0, nk.y + 0.04, nk.cz], [rx, rr * 0.8, rz]), "canvas");
        }
        break;
      }
    }
  }
  return out;
}

/** The accessory's own colour, or the default chosen for the body. */
export function accessoryColor(spec: AccessorySpec, bodyHex: string, fallback: (id: AccessoryId, body: string) => string): string {
  return spec.color ? colorHex(spec.color) : fallback(spec.id, bodyHex);
}

/** Which slot an accessory holds. */
export function accessorySlot(id: AccessoryId) {
  return ACCESSORIES[id].slot;
}
