/**
 * Accessories (three.js, client only). Each one is modelled here and fitted
 * to the body it sits on from the shape's anchors (shapes.ts): hats read the
 * head's cross-section at their band, glasses the eye line, headphones and
 * earrings the sides of the head, neckwear the neck ring. No accessory is
 * tuned per shape, so every accessory sits on every body, including shapes a
 * person creates by stretching one.
 *
 * Everything is offset by the fur's length, so a hat sits on the pile rather
 * than inside it. Springy parts (antenna, sprout, earrings, scarf tail) are
 * returned with a weight so the character can swing them with the rig's
 * secondary motion.
 */

import * as THREE from "three";
import { ACCESSORIES, type AccessoryId } from "./avatar2";
import { makeAccMaterial, type AccMaterial, type AccMaterialKind } from "./materials";
import { complement, hexToOklch, oklchToHex, patternPartner } from "./palette";
import { castRay, surfaceBasis, type Anchors, type BodyField, type Frame, type V3 } from "./shapes";

export interface AccContext {
  anchors: Anchors;
  /** The body's distance field (cloth that lies on the body projects onto it). */
  field: BodyField;
  /** Fur length (body units): accessories sit on the pile. */
  fur: number;
  bodyHex: string;
  /** The accessory's own colour, or undefined for the default. */
  color?: string;
  /** Eye protrusion in front of the surface, for glasses. */
  eyeDepth: number;
  /** Eye radius as rendered (after small-size tuning). */
  eyeRadius: number;
  /** Mesh detail (segments). */
  detail: number;
}

export interface Springy {
  node: THREE.Object3D;
  /** How much it swings, radians per unit of lag. */
  k: number;
  /** The rest rotation. */
  rest: THREE.Euler;
}

export interface BuiltAccessory {
  id: AccessoryId;
  group: THREE.Group;
  mats: AccMaterial[];
  springs: Springy[];
  /** Highest point, for framing. */
  top: number;
  /** Widest half-extent in x, for framing. */
  half: number;
  dispose(): void;
}

/* ——————————————————————————— Default colours ——————————————————————————— */

const GOLD = "#c9a660";
const SILVER = "#b9bcc2";
const INK = "#1f1f23";

function light(hex: string) {
  return hexToOklch(hex).l > 0.72;
}

/** The colour an accessory wears when the person has not chosen one: chosen to sit with the body. */
export function defaultAccessoryColor(id: AccessoryId, bodyHex: string): string {
  const comp = complement(bodyHex);
  const lch = hexToOklch(bodyHex);
  switch (id) {
    case "cap":
    case "headband":
    case "bow":
    case "scarf":
    case "bandana":
      return comp;
    case "beanie":
      return lch.c < 0.04 ? "#c9486b" : oklchToHex({ l: Math.min(0.9, lch.l + 0.18), c: lch.c * 0.55, h: (lch.h + 40) % 360 });
    case "bucket":
      return light(bodyHex) ? "#8a5d47" : "#e4d7c1";
    case "sprout":
      return lch.h > 100 && lch.h < 160 && lch.c > 0.06 ? "#3e7d4f" : "#7fae5c";
    case "antenna":
      return comp;
    case "flower":
      return light(bodyHex) ? "#e4715e" : "#f7f3ea";
    case "round":
    case "monocle":
    case "hoops":
      return GOLD;
    case "square":
      return INK;
    case "shades":
      return INK;
    case "headphones":
      return light(bodyHex) ? "#3e4045" : "#f1f0ec";
    case "earbuds":
      return "#f6f6f4";
    default:
      return patternPartner(bodyHex);
  }
}

/* ——————————————————————————— Helpers ——————————————————————————— */

const v3 = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

/** A matrix that places local (x across, y up, z out) on a surface frame, pushed out by `out`. */
function onSurface(f: Frame, out: number, forward = 0.35): THREE.Matrix4 {
  // Features face mostly forward: blend the normal toward +z.
  const n = new THREE.Vector3(f.n[0], f.n[1], f.n[2]);
  n.z += forward;
  n.normalize();
  const b = surfaceBasis([n.x, n.y, n.z]);
  const m = new THREE.Matrix4().makeBasis(v3(b.x), v3(b.y), v3(b.z));
  const p = v3(f.p).addScaledVector(new THREE.Vector3(f.n[0], f.n[1], f.n[2]), out);
  m.setPosition(p);
  return m;
}

/** A lathe from a profile of [radius, height] pairs. */
function lathe(profile: [number, number][], segs: number) {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    segs,
  );
}

/** A tube along points (smooth). */
function tube(points: THREE.Vector3[], radius: number, segs = 48, radial = 10, closed = false) {
  const curve = new THREE.CatmullRomCurve3(points, closed, "centripetal");
  return new THREE.TubeGeometry(curve, segs, radius, radial, closed);
}

/** A rounded-rectangle outline in the xy plane, as points. */
function roundedRect(w: number, h: number, r: number, n = 6): THREE.Vector3[] {
  const pts: THREE.Vector3[] = [];
  const cs: [number, number, number][] = [
    [w / 2 - r, h / 2 - r, 0],
    [-w / 2 + r, h / 2 - r, Math.PI / 2],
    [-w / 2 + r, -h / 2 + r, Math.PI],
    [w / 2 - r, -h / 2 + r, (3 * Math.PI) / 2],
  ];
  for (const [cx, cy, a0] of cs) for (let i = 0; i <= n; i++) {
    const a = a0 + (i / n) * (Math.PI / 2);
    pts.push(new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0));
  }
  return pts;
}

/**
 * A closed band round an elliptical section (front and back radii may differ),
 * with a rounded-rectangle cross-section `thick` deep and `tall` high: scarves
 * and bands that hug the body instead of floating round it like a tube.
 */
function bandGeometry(rx: number, rzF: number, rzB: number, thick: number, tall: number, segs: number) {
  const section: [number, number][] = [];
  const m = 20;
  for (let i = 0; i < m; i++) {
    const t = (i / m) * Math.PI * 2;
    // A superellipse: flat faces, soft edges.
    const cx = Math.cos(t);
    const cy = Math.sin(t);
    const e = 0.55;
    section.push([Math.sign(cx) * Math.pow(Math.abs(cx), e) * thick * 0.5, Math.sign(cy) * Math.pow(Math.abs(cy), e) * tall * 0.5]);
  }
  const pos: number[] = [];
  const idx: number[] = [];
  for (let j = 0; j < segs; j++) {
    const a = (j / segs) * Math.PI * 2;
    const ca = Math.cos(a);
    const rz = ca >= 0 ? rzF : rzB;
    const cx = Math.sin(a) * rx;
    const cz = ca * rz;
    // Outward normal of the ellipse.
    let nx = Math.sin(a) / rx;
    let nz = ca / rz;
    const l = Math.hypot(nx, nz) || 1;
    nx /= l;
    nz /= l;
    const wob = 1 + 0.07 * Math.sin(a * 3 + 0.6);
    for (const [r, y] of section) pos.push(cx + nx * (r + thick * 0.5), y * wob, cz + nz * (r + thick * 0.5));
  }
  for (let j = 0; j < segs; j++)
    for (let i = 0; i < m; i++) {
      const a0 = j * m + i;
      const a1 = j * m + ((i + 1) % m);
      const b0 = ((j + 1) % segs) * m + i;
      const b1 = ((j + 1) % segs) * m + ((i + 1) % m);
      idx.push(a0, b0, a1, a1, b0, b1);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/** Round a box's corners a little by pulling its vertices toward a rounded box. */
function softenBox(g: THREE.BufferGeometry, r: number) {
  g.computeBoundingBox();
  const b = g.boundingBox!;
  const hx = (b.max.x - b.min.x) / 2;
  const hy = (b.max.y - b.min.y) / 2;
  const hz = (b.max.z - b.min.z) / 2;
  const cx = (b.max.x + b.min.x) / 2;
  const cy = (b.max.y + b.min.y) / 2;
  const cz = (b.max.z + b.min.z) / 2;
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) - cx;
    const y = p.getY(i) - cy;
    const z = p.getZ(i) - cz;
    const ix = Math.max(-hx + r, Math.min(hx - r, x));
    const iy = Math.max(-hy + r, Math.min(hy - r, y));
    const iz = Math.max(-hz + r, Math.min(hz - r, z));
    const dx = x - ix;
    const dy = y - iy;
    const dz = z - iz;
    const l = Math.hypot(dx, dy, dz) || 1;
    p.setXYZ(i, cx + ix + (dx / l) * Math.min(r, l), cy + iy + (dy / l) * Math.min(r, l), cz + iz + (dz / l) * Math.min(r, l));
  }
  g.computeVertexNormals();
}

class Kit {
  group = new THREE.Group();
  mats: AccMaterial[] = [];
  geos: THREE.BufferGeometry[] = [];
  springs: Springy[] = [];
  mat(kind: AccMaterialKind, color: string, scale = 1, dots?: string) {
    const m = makeAccMaterial(kind, color, scale, dots);
    this.mats.push(m);
    return m.mat;
  }
  mesh(geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D = this.group) {
    this.geos.push(geo);
    const m = new THREE.Mesh(geo, mat);
    parent.add(m);
    return m;
  }
  spring(node: THREE.Object3D, k: number) {
    this.springs.push({ node, k, rest: node.rotation.clone() });
  }
}

/* ——————————————————————————— Builders ——————————————————————————— */

type Builder = (kit: Kit, c: AccContext, col: string) => void;

/** The head's cross-section where headwear sits, pushed out by the pile. */
function hatRing(c: AccContext) {
  const r = c.anchors.hat;
  const pad = c.fur * 0.85 + 0.012;
  const rx = r.a + pad;
  const rzF = r.front + pad;
  const rzB = r.back + pad;
  const rz = (rzF + rzB) / 2;
  const cz = (rzF - rzB) / 2;
  const topY = c.anchors.top[1] + c.fur * 0.85;
  return { y: r.y, rx, rz, cz, topY, ht: Math.max(0.12, topY - r.y) };
}

const BUILD: Record<AccessoryId, Builder> = {
  /* A soft beanie with a folded cuff and a yarn pompom. */
  beanie(kit, c, col) {
    const h = hatRing(c);
    const knit = kit.mat("knit", col);
    const seg = c.detail;
    const g = new THREE.Group();
    g.position.set(0, h.y, h.cz);
    kit.group.add(g);
    // Crown: a dome from the band to just over the top, a little slouch at the back.
    const crown = kit.mesh(new THREE.SphereGeometry(1, seg, Math.round(seg / 2), 0, Math.PI * 2, 0, Math.PI / 2), knit, g);
    crown.scale.set(h.rx * 1.02, h.ht * 1.16 + 0.04, h.rz * 1.02);
    crown.position.y = 0.02;
    // The folded cuff.
    const cuff = kit.mesh(lathe([[1, -0.075], [1.035, -0.07], [1.055, -0.03], [1.06, 0.02], [1.05, 0.065], [1.02, 0.08], [0.98, 0.08]], seg), knit, g);
    cuff.scale.set(h.rx, 1, h.rz);
    cuff.position.y = 0.02;
    // Pompom.
    const pom = kit.mesh(new THREE.IcosahedronGeometry(1, 3), kit.mat("felt", col), g);
    const pr = 0.1 + h.rx * 0.05;
    pom.scale.setScalar(pr);
    pom.position.y = h.ht * 1.16 + 0.04 + pr * 0.55;
    kit.spring(pom, 0.3);
  },

  /* A soft six-panel cap: a felt crown, a curved bill, a button on top. */
  cap(kit, c, col) {
    const h = hatRing(c);
    const felt = kit.mat("felt", col);
    const seg = c.detail;
    const g = new THREE.Group();
    g.position.set(0, h.y, h.cz);
    g.rotation.x = -0.08;
    kit.group.add(g);
    const crown = kit.mesh(new THREE.SphereGeometry(1, seg, Math.round(seg / 2), 0, Math.PI * 2, 0, Math.PI / 2), felt, g);
    crown.scale.set(h.rx * 1.03, h.ht * 1.02 + 0.03, h.rz * 1.03);
    // Panel seams: thin darker lines from the button down.
    const seamMat = kit.mat("thread", oklchToHex({ ...hexToOklch(col), l: Math.max(0.12, hexToOklch(col).l - 0.12) }));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 + Math.PI / 6;
      const pts: THREE.Vector3[] = [];
      for (let j = 0; j <= 8; j++) {
        const t = (j / 8) * (Math.PI / 2);
        pts.push(new THREE.Vector3(Math.sin(a) * Math.cos(t) * h.rx * 1.035, Math.sin(t) * (h.ht * 1.02 + 0.03) * 1.005, Math.cos(a) * Math.cos(t) * h.rz * 1.035));
      }
      kit.mesh(tube(pts, 0.006, 16, 4), seamMat, g);
    }
    // Bill: a rounded half-disc, curved down at its sides.
    const shape = new THREE.Shape();
    const bw = h.rx * 0.95;
    const bl = 0.26 + h.rx * 0.18;
    shape.moveTo(-bw, 0);
    shape.bezierCurveTo(-bw, bl * 0.9, -bw * 0.45, bl, 0, bl);
    shape.bezierCurveTo(bw * 0.45, bl, bw, bl * 0.9, bw, 0);
    shape.lineTo(-bw, 0);
    const billGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.022, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.012, bevelSegments: 3, curveSegments: 20 });
    // Curve the bill: bend its sides down.
    const pos = billGeo.attributes.position as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      pos.setZ(i, pos.getZ(i) - Math.pow(Math.abs(x) / bw, 2) * 0.07);
    }
    billGeo.computeVertexNormals();
    const billMat = kit.mat("felt", col);
    billMat.side = THREE.DoubleSide;
    const bill = kit.mesh(billGeo, billMat, g);
    bill.rotation.x = Math.PI / 2 + 0.2;
    bill.position.set(0, 0.012, h.rz * 0.9);
    const btn = kit.mesh(new THREE.SphereGeometry(1, 16, 10), felt, g);
    btn.scale.set(0.045, 0.028, 0.045);
    btn.position.y = h.ht * 1.02 + 0.035;
  },

  /* A canvas bucket hat: a soft crown and a brim that slopes down all round. */
  bucket(kit, c, col) {
    const h = hatRing(c);
    const canvas = kit.mat("canvas", col);
    const seg = c.detail;
    const g = new THREE.Group();
    g.position.set(0, h.y - 0.02, h.cz);
    kit.group.add(g);
    const ch = h.ht * 1.05 + 0.05;
    const crown = kit.mesh(
      lathe(
        [
          [1.0, 0],
          [0.99, ch * 0.35],
          [0.95, ch * 0.7],
          [0.86, ch * 0.92],
          [0.62, ch * 1.0],
          [0.001, ch * 1.02],
        ],
        seg,
      ),
      canvas,
      g,
    );
    crown.scale.set(h.rx * 1.03, 1, h.rz * 1.03);
    const bw = 0.2 + h.rx * 0.14;
    const brim = kit.mesh(
      lathe(
        [
          [1.0, 0.012],
          [1.0 + bw * 0.5, -0.03],
          [1.0 + bw, -0.085],
          [1.0 + bw + 0.012, -0.1],
          [1.0 + bw, -0.11],
          [1.0 + bw * 0.5, -0.058],
          [0.985, -0.02],
        ],
        seg,
      ),
      canvas,
      g,
    );
    brim.scale.set(h.rx, 1, h.rz);
    // A band.
    const band = kit.mesh(lathe([[1.005, 0.0], [1.012, 0.02], [1.012, 0.06], [1.0, 0.075]], seg), kit.mat("canvas", oklchToHex({ ...hexToOklch(col), l: Math.max(0.2, hexToOklch(col).l - 0.18) })), g);
    band.scale.set(h.rx * 1.03, 1, h.rz * 1.03);
  },

  /* A velvet headband with a small bow on one side. */
  headband(kit, c, col) {
    const h = hatRing(c);
    const vel = kit.mat("velvet", col);
    const y = h.y + h.ht * 0.32;
    // Follow the head's section a little higher than the hat band.
    const k = Math.sqrt(Math.max(0.2, 1 - Math.pow((y - h.y) / (h.ht + 0.05), 2)));
    const rx = h.rx * (0.9 + 0.1 * k);
    const rz = h.rz * (0.9 + 0.1 * k);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.sin(a) * rx, 0, Math.cos(a) * rz));
    }
    const g = new THREE.Group();
    g.position.set(0, y, h.cz);
    g.rotation.x = -0.18;
    kit.group.add(g);
    const band = kit.mesh(tube(pts, 0.04, 80, 10, true), vel, g);
    band.scale.set(1, 1.4, 1);
    // The bow: two lobes and a knot, up on the viewer's left.
    const bow = new THREE.Group();
    const a = -0.72;
    bow.position.set(Math.sin(a) * rx * 1.02, 0.05, Math.cos(a) * rz * 1.02);
    bow.rotation.y = a;
    g.add(bow);
    const lobe = new THREE.SphereGeometry(1, 20, 14);
    for (const s of [-1, 1]) {
      const l = kit.mesh(lobe.clone(), vel, bow);
      l.scale.set(0.1, 0.065, 0.04);
      l.position.set(s * 0.085, 0, 0.02);
      l.rotation.z = s * 0.3;
    }
    const knot = kit.mesh(new THREE.SphereGeometry(1, 14, 10), vel, bow);
    knot.scale.set(0.04, 0.045, 0.04);
    knot.position.z = 0.04;
  },

  /* A sprout: a curved stem and two leaves, springy. */
  sprout(kit, c, col) {
    const top = c.anchors.top;
    const base = new THREE.Group();
    base.position.set(top[0], top[1] + c.fur * 0.5, top[2]);
    base.scale.setScalar(1.45);
    kit.group.add(base);
    const vinyl = kit.mat("vinyl", col);
    const stem = kit.mesh(tube([new THREE.Vector3(0, -0.04, 0), new THREE.Vector3(0.01, 0.08, 0), new THREE.Vector3(0.035, 0.17, 0.01)], 0.018, 20, 8), vinyl, base);
    void stem;
    const leafShape = new THREE.Shape();
    leafShape.moveTo(0, 0);
    leafShape.bezierCurveTo(0.06, 0.03, 0.12, 0.08, 0.2, 0.02);
    leafShape.bezierCurveTo(0.14, -0.05, 0.06, -0.04, 0, 0);
    const leafGeo = new THREE.ExtrudeGeometry(leafShape, { depth: 0.01, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.01, bevelSegments: 3, curveSegments: 14 });
    const tip = new THREE.Group();
    tip.position.set(0.035, 0.17, 0.01);
    base.add(tip);
    for (const s of [-1, 1]) {
      const leaf = kit.mesh(leafGeo.clone(), vinyl, tip);
      leaf.rotation.set(0.3, s > 0 ? 0 : Math.PI, s * 0.5);
    }
    leafGeo.dispose();
    kit.spring(base, 0.5);
  },

  /* An antenna: a thin stalk and a glossy ball, very springy. */
  antenna(kit, c, col) {
    const top = c.anchors.top;
    const base = new THREE.Group();
    base.position.set(top[0], top[1] + c.fur * 0.3, top[2]);
    base.rotation.z = -0.12;
    base.scale.setScalar(1.3);
    kit.group.add(base);
    kit.mesh(tube([new THREE.Vector3(0, -0.05, 0), new THREE.Vector3(0.0, 0.14, 0), new THREE.Vector3(0.03, 0.3, 0)], 0.014, 24, 8), kit.mat("vinyl", "#3e4045"), base);
    const ball = kit.mesh(new THREE.SphereGeometry(1, 24, 16), kit.mat("gloss", col), base);
    ball.scale.setScalar(0.07);
    ball.position.set(0.03, 0.33, 0);
    kit.spring(base, 0.9);
  },

  /* A felt flower pinned high on the side of the head. */
  flower(kit, c, col) {
    const m = onSurface(c.anchors.pin, c.fur * 0.8 + 0.01, 0.1);
    const g = new THREE.Group();
    g.applyMatrix4(m);
    kit.group.add(g);
    const felt = kit.mat("felt", col);
    const petal = new THREE.SphereGeometry(1, 18, 12);
    const k = 1.9;
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.3;
      const p = kit.mesh(petal.clone(), felt, g);
      p.scale.set(0.078 * k, 0.054 * k, 0.026 * k);
      p.position.set(Math.cos(a) * 0.068 * k, Math.sin(a) * 0.068 * k, 0);
      p.rotation.set(0, -0.18, a);
    }
    petal.dispose();
    const centre = kit.mesh(new THREE.SphereGeometry(1, 16, 12), kit.mat("felt", "#efb23f"), g);
    centre.scale.set(0.042 * k, 0.042 * k, 0.03 * k);
    centre.position.z = 0.025;
  },

  /* Round wire glasses. */
  round(kit, c, col) {
    glasses(kit, c, col, "round");
  },
  /* Square acetate frames. */
  square(kit, c, col) {
    glasses(kit, c, col, "square");
  },
  /* Sunglasses: soft rectangular frames with dark lenses. */
  shades(kit, c, col) {
    glasses(kit, c, col, "shades");
  },
  /* A monocle on the viewer's right with a fine chain. */
  monocle(kit, c, col) {
    const metal = kit.mat("metal", col);
    const e = c.anchors.eyes[1];
    const R = c.eyeRadius * 1.55;
    const m = onSurface(e, c.fur * 0.4 + c.eyeDepth + 0.03);
    const g = new THREE.Group();
    g.applyMatrix4(m);
    kit.group.add(g);
    kit.mesh(new THREE.TorusGeometry(R, 0.018, 10, 48), metal, g);
    const lens = kit.mesh(new THREE.CircleGeometry(R, 40), kit.mat("lens", "#e8eef2"), g);
    (lens.material as THREE.MeshPhysicalMaterial).opacity = 0.16;
    // The chain hangs to the side and down.
    const p0 = new THREE.Vector3(R * 0.9, -R * 0.4, 0);
    const chain = kit.mesh(tube([p0, new THREE.Vector3(R * 1.4, -R * 1.6, -0.05), new THREE.Vector3(R * 1.6, -R * 2.8, -0.14)], 0.007, 24, 6), metal, g);
    void chain;
  },

  /* Over-ear headphones: a padded band over the head, big cushioned cups turned a little toward you. */
  headphones(kit, c, col) {
    const a = c.anchors;
    const shell = kit.mat("vinyl", col);
    const cushion = kit.mat("velvet", light(col) ? "#3e4045" : "#2a2b2f");
    const out = c.fur * 0.8 + 0.03;
    const h = hatRing(c);
    const cupR = 0.17 + a.height * 0.035;
    const ears = a.ears.map((e) => v3(e.p).addScaledVector(v3(e.n), out).add(new THREE.Vector3(0, 0, 0.05)));
    const topY = a.top[1] + c.fur * 0.85 + 0.07;
    const midY = (ears[0].y + topY) / 2 + 0.08;
    const band = [
      ears[0].clone().add(new THREE.Vector3(0.03, cupR * 0.8, -0.02)),
      new THREE.Vector3(-h.rx * 0.98 - 0.03, midY, h.cz * 0.4),
      new THREE.Vector3(0, topY, h.cz * 0.2),
      new THREE.Vector3(h.rx * 0.98 + 0.03, midY, h.cz * 0.4),
      ears[1].clone().add(new THREE.Vector3(-0.03, cupR * 0.8, -0.02)),
    ];
    const bandMesh = kit.mesh(tube(band, 0.045, 72, 12), shell, kit.group);
    bandMesh.scale.z = 1;
    for (const [i, p] of ears.entries()) {
      const n = v3(a.ears[i].n).normalize();
      // Turn the cup a little toward the viewer so it reads from the front.
      n.z += 0.45;
      n.normalize();
      const cup = new THREE.Group();
      cup.position.copy(p);
      cup.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), n);
      kit.group.add(cup);
      kit.mesh(lathe([[0.001, 0.13], [cupR * 0.72, 0.13], [cupR, 0.1], [cupR * 1.04, 0.05], [cupR * 0.98, 0.0]], 32), shell, cup);
      const pad = kit.mesh(new THREE.TorusGeometry(cupR * 0.78, cupR * 0.28, 12, 32), cushion, cup);
      pad.rotation.x = Math.PI / 2;
      pad.position.y = -0.01;
    }
  },

  /* Earbuds, a short stem each. */
  earbuds(kit, c, col) {
    const a = c.anchors;
    const gloss = kit.mat("gloss", col);
    for (const e of a.ears) {
      const p = v3(e.p).addScaledVector(v3(e.n), c.fur * 0.6 + 0.03).add(new THREE.Vector3(0, -0.04, 0.08));
      const g = new THREE.Group();
      g.position.copy(p);
      const nn = v3(e.n).normalize();
      nn.z += 0.5;
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), nn.normalize());
      kit.group.add(g);
      const bud = kit.mesh(new THREE.SphereGeometry(1, 20, 14), gloss, g);
      bud.scale.set(0.09, 0.09, 0.07);
      const stem = new THREE.Group();
      g.add(stem);
      stem.quaternion.copy(g.quaternion.clone().invert());
      const s2 = kit.mesh(new THREE.CapsuleGeometry(0.028, 0.15, 4, 10), gloss, stem);
      s2.position.y = -0.11;
    }
  },

  /* Small gold hoops, springy. */
  hoops(kit, c, col) {
    const a = c.anchors;
    const metal = kit.mat("metal", col);
    for (const e of a.ears) {
      const p = v3(e.p).addScaledVector(v3(e.n), c.fur * 0.6 + 0.01).add(new THREE.Vector3(0, -a.eyeRadius * 1.1, 0.07));
      const g = new THREE.Group();
      g.position.copy(p);
      kit.group.add(g);
      const stud = kit.mesh(new THREE.SphereGeometry(0.026, 12, 10), metal, g);
      void stud;
      const ring = kit.mesh(new THREE.TorusGeometry(0.11, 0.018, 10, 40), metal, g);
      ring.position.y = -0.11;
      ring.rotation.y = Math.atan2(e.n[0], e.n[2]) + Math.PI / 2;
      kit.spring(g, 0.8);
    }
  },

  /* A velvet bow at the neck. */
  bow(kit, c, col) {
    const n = c.anchors.neck;
    const vel = kit.mat("velvet", col);
    const g = new THREE.Group();
    g.position.set(0, n.y - 0.03, n.front + c.fur * 0.8 + 0.03);
    kit.group.add(g);
    const s = 1.15 + n.a * 0.35;
    const lobe = new THREE.SphereGeometry(1, 22, 14);
    for (const side of [-1, 1]) {
      const l = kit.mesh(lobe.clone(), vel, g);
      l.scale.set(0.15 * s, 0.1 * s, 0.055 * s);
      l.position.set(side * 0.13 * s, 0.005, -0.01);
      l.rotation.z = side * 0.32;
      const tail = kit.mesh(lobe.clone(), vel, g);
      tail.scale.set(0.045 * s, 0.11 * s, 0.03 * s);
      tail.position.set(side * 0.07 * s, -0.1 * s, -0.005);
      tail.rotation.z = side * -0.35;
    }
    lobe.dispose();
    const knot = kit.mesh(new THREE.SphereGeometry(1, 16, 12), vel, g);
    knot.scale.set(0.055 * s, 0.06 * s, 0.05 * s);
    knot.position.z = 0.025;
  },

  /* A knit scarf: a soft flat band hugging the neck, one end hanging in front. */
  scarf(kit, c, col) {
    const n = c.anchors.neck;
    const knit = kit.mat("knit", col);
    const pad = c.fur * 0.7 + 0.03;
    const geo = bandGeometry(n.a + pad, n.front + pad, n.back + pad, 0.07, 0.19, 96);
    const g = new THREE.Group();
    g.position.y = n.y - 0.03;
    kit.group.add(g);
    kit.mesh(geo, knit, g);
    // The hanging end: a flat knit strip with a little fringe, over the front.
    const tailG = new THREE.Group();
    const a = 0.42;
    tailG.position.set(Math.sin(a) * (n.a + pad + 0.03), -0.04, Math.cos(a) * (n.front + pad + 0.03));
    tailG.rotation.set(0.16, a * 0.9, 0.1);
    g.add(tailG);
    const len = Math.max(0.16, Math.min(0.4, (n.y + 1) * 0.7));
    const strip = kit.mesh(new THREE.BoxGeometry(0.17, len, 0.05, 2, 6, 1), knit, tailG);
    strip.position.y = -len / 2 + 0.02;
    softenBox(strip.geometry as THREE.BufferGeometry, 0.02);
    for (let i = 0; i < 4; i++) {
      const fr = kit.mesh(new THREE.CapsuleGeometry(0.012, 0.05, 3, 6), knit, tailG);
      fr.position.set(-0.06 + i * 0.04, -len + 0.0, 0);
    }
    kit.spring(tailG, 0.35);
  },

  /* A canvas bandana tied at the neck, the point hanging in front. */
  bandana(kit, c, col) {
    const n = c.anchors.neck;
    const canvas = kit.mat("canvas", col);
    const pad = c.fur * 0.8 + 0.02;
    const rx = n.a + pad;
    const rzF = n.front + pad;
    const w = rx * 0.56;
    const hgt = 0.4 + n.a * 0.08;
    const shape = new THREE.Shape();
    shape.moveTo(-w, 0);
    shape.lineTo(w, 0);
    shape.quadraticCurveTo(w * 0.2, -hgt * 0.7, 0.03, -hgt);
    shape.quadraticCurveTo(0, -hgt - 0.02, -0.03, -hgt);
    shape.quadraticCurveTo(-w * 0.2, -hgt * 0.7, -w, 0);
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.012, bevelEnabled: true, bevelThickness: 0.008, bevelSize: 0.008, bevelSegments: 2, curveSegments: 16 });
    // Lay the cloth on the body: each vertex goes round the neck by its x and is
    // projected onto the surface at its own height, so the point lies on the chest.
    const pos = geo.attributes.position as THREE.BufferAttribute;
    const baseY = n.y + 0.05;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const ang = x / rx;
      const dx = Math.sin(ang);
      const dz = Math.cos(ang);
      const wy = baseY + y;
      // Cloth drapes straight down from the band; it never tucks under the body's curve.
      const atBand = castRay(c.field, 0, baseY, 0, dx, 0, dz, 3);
      const surf = Math.max(castRay(c.field, 0, wy, 0, dx, 0, dz, 3), atBand - Math.max(0, -y) * 0.15);
      const r = surf + pad + z;
      pos.setXYZ(i, dx * r, y, dz * r);
    }
    geo.computeVertexNormals();
    const g = new THREE.Group();
    g.position.y = baseY;
    kit.group.add(g);
    // Cloth is thin: both faces render (the extrusion's caps wind inward once draped).
    const cloth = kit.mat("canvas", col, 1, light(col) ? "#3e4045" : "#f7f3ea");
    cloth.side = THREE.DoubleSide;
    kit.mesh(geo, cloth, g);
    // The band behind.
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.sin(a) * rx, 0, Math.cos(a) >= 0 ? Math.cos(a) * rzF : Math.cos(a) * (n.back + pad)));
    }
    kit.mesh(tube(pts, 0.03, 64, 8, true), canvas, g);
    // The knot, at the back.
    const knot = kit.mesh(new THREE.SphereGeometry(1, 14, 10), canvas, g);
    knot.scale.set(0.06, 0.05, 0.05);
    knot.position.set(0, 0, -(n.back + pad));
  },
};

function glasses(kit: Kit, c: AccContext, col: string, kind: "round" | "square" | "shades") {
  const a = c.anchors;
  const R = c.eyeRadius * (kind === "round" ? 1.5 : 1.55);
  const frame = kind === "round" ? kit.mat("metal", col) : kit.mat("acetate", col);
  const thick = kind === "round" ? 0.017 : 0.028;
  const out = c.fur * 0.4 + c.eyeDepth + 0.035;
  const rims: THREE.Group[] = [];
  const centres: THREE.Vector3[] = [];
  for (const e of a.eyes) {
    const g = new THREE.Group();
    g.applyMatrix4(onSurface(e, out, 0.9));
    kit.group.add(g);
    rims.push(g);
    centres.push(g.position.clone());
    if (kind === "round") {
      kit.mesh(new THREE.TorusGeometry(R, thick, 10, 56), frame, g);
      const lens = kit.mesh(new THREE.CircleGeometry(R, 48), kit.mat("lens", "#eef2f4"), g);
      (lens.material as THREE.MeshPhysicalMaterial).opacity = 0.14;
    } else {
      const w = R * 2.25;
      const h = R * (kind === "shades" ? 1.75 : 1.85);
      kit.mesh(tube(roundedRect(w, h, R * 0.6, 8), thick, 96, 10, true), frame, g);
      if (kind === "shades") {
        const s = new THREE.Shape(roundedRect(w, h, R * 0.6, 8).map((p) => new THREE.Vector2(p.x, p.y)));
        const lens = kit.mesh(new THREE.ShapeGeometry(s, 12), kit.mat("lens", "#17181c"), g);
        (lens.material as THREE.MeshPhysicalMaterial).opacity = 0.92;
        lens.position.z = -0.004;
      } else {
        const s = new THREE.Shape(roundedRect(w, h, R * 0.6, 8).map((p) => new THREE.Vector2(p.x, p.y)));
        const lens = kit.mesh(new THREE.ShapeGeometry(s, 12), kit.mat("lens", "#eef2f4"), g);
        (lens.material as THREE.MeshPhysicalMaterial).opacity = 0.12;
      }
    }
  }
  // Bridge: a small arch between the inner edges.
  const inner = (i: number) => {
    const g = rims[i];
    const sx = i === 0 ? 1 : -1;
    const hw = kind === "round" ? R : R * 1.12;
    return new THREE.Vector3(sx * hw, R * 0.15, 0).applyMatrix4(g.matrix);
  };
  const p0 = inner(0);
  const p1 = inner(1);
  const mid = p0.clone().add(p1).multiplyScalar(0.5).add(new THREE.Vector3(0, R * 0.22, 0.01));
  kit.mesh(tube([p0, mid, p1], thick * 0.85, 20, 8), frame, kit.group);
  // Temples: from the outer edges back toward the ears.
  for (let i = 0; i < 2; i++) {
    const g = rims[i];
    const sx = i === 0 ? -1 : 1;
    const hw = kind === "round" ? R : R * 1.12;
    const o = new THREE.Vector3(sx * hw, R * 0.2, 0).applyMatrix4(g.matrix);
    const ear = v3(a.ears[i].p).addScaledVector(v3(a.ears[i].n), c.fur * 0.6 + 0.01);
    const m = o.clone().lerp(ear, 0.5);
    m.x += sx * 0.03;
    m.z += 0.02;
    kit.mesh(tube([o, m, ear.clone().add(new THREE.Vector3(0, 0.02, -0.04))], thick * 0.8, 24, 8), frame, kit.group);
  }
}

/* ——————————————————————————— Public ——————————————————————————— */

export function buildAccessory(id: AccessoryId, c: AccContext): BuiltAccessory {
  const kit = new Kit();
  const col = c.color ?? defaultAccessoryColor(id, c.bodyHex);
  BUILD[id](kit, c, col);
  kit.group.name = `acc:${id}`;
  kit.group.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(kit.group);
  const built: BuiltAccessory = {
    id,
    group: kit.group,
    mats: kit.mats,
    springs: kit.springs,
    top: Number.isFinite(box.max.y) ? box.max.y : 0,
    half: Number.isFinite(box.max.x) ? Math.max(Math.abs(box.min.x), Math.abs(box.max.x)) : 0,
    dispose() {
      for (const g of kit.geos) g.dispose();
      for (const m of kit.mats) m.mat.dispose();
    },
  };
  return built;
}

export function accessorySlot(id: AccessoryId) {
  return ACCESSORIES[id].slot;
}

export { SILVER };
