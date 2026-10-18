/**
 * PROPOSAL, dev only: Alevr Orbit agent characters, two 3D directions.
 *
 *   A  "Simple 3D"  soft matte clay / vinyl, crisp simple volumes, soft studio light
 *   B  "Funny 3D"   velvet flock (sheen, a hashed fibre grain in the normal, a soft fibre rim),
 *                   chunkier proportions, bigger eyes and accessories
 *
 * Twelve characters: six simple forms (Mira the hero, a pill, a rounded
 * square, a drop, a bean, a gumdrop) and six exclusive forms from Alevr's own
 * geometry (the Orbit ellipse as two separated arcs, a black hole with its
 * accretion disc, a ringed planet, a crescent moon, a comet, a pulsar star).
 * No mouths, no blush; the graphic eyes carry the state.
 *
 * Everything is procedural three.js (no Blender, no assets): extruded rounded
 * silhouettes with deep bevels, lathed bodies, eyes painted onto the surface
 * by ray casting. One renderer draws every image once; small sizes are
 * pre-rendered sprites, the way they would ship.
 */
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

export type Direction = "A" | "B";
export type EyeState = "ready" | "thinking" | "working" | "waiting" | "finished" | "paused";
type EyeStyle = "oval" | "pill" | "dot" | "sticker" | "arc" | "sleepy";

const INK = 0x17151c;
const CREAM = 0xefe7d6;
const BG = 0xf4f3f0;

interface Build {
  dir: Direction;
  body: (m: (color: number, opts?: MatOpts) => THREE.Material) => THREE.Object3D;
  /** Extra parts that are not the eye surface. */
  parts?: (m: (color: number, opts?: MatOpts) => THREE.Material, dir: Direction) => THREE.Object3D[];
  eyes: { y: number; gap: number; size: number; style: EyeStyle; light?: boolean; x?: number };
}

interface MatOpts {
  emissive?: number;
  emissiveIntensity?: number;
  flat?: boolean;
  gloss?: boolean;
}

export interface CharacterDef {
  id: string;
  name: string;
  role: string;
  kind: "simple" | "cosmic";
  color: number;
  build: Omit<Build, "dir">;
}

/* ———————————————————————————— Geometry helpers ———————————————————————————— */

/** A 2D outline extruded into a soft, pillowy volume (deep round bevel). */
function pillow(shape: THREE.Shape, depth: number, bevel: number): THREE.BufferGeometry {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: bevel * 1.15,
    bevelSize: bevel,
    bevelSegments: 14,
    curveSegments: 64,
  });
  g.translate(0, 0, -depth / 2);
  g.computeVertexNormals();
  return g;
}

/** A rounded polygon: each corner replaced by a quadratic arc of radius r. */
function roundedPolygon(pts: [number, number][], r: number | number[]): THREE.Shape {
  const s = new THREE.Shape();
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const [px, py] = pts[(i - 1 + n) % n]!;
    const [cx, cy] = pts[i]!;
    const [nx, ny] = pts[(i + 1) % n]!;
    const rr = Array.isArray(r) ? r[i]! : r;
    const a = Math.hypot(px - cx, py - cy);
    const b = Math.hypot(nx - cx, ny - cy);
    const ra = Math.min(rr, a / 2);
    const rb = Math.min(rr, b / 2);
    const p1: [number, number] = [cx + ((px - cx) / a) * ra, cy + ((py - cy) / a) * ra];
    const p2: [number, number] = [cx + ((nx - cx) / b) * rb, cy + ((ny - cy) / b) * rb];
    if (i === 0) s.moveTo(p1[0], p1[1]);
    else s.lineTo(p1[0], p1[1]);
    s.quadraticCurveTo(cx, cy, p2[0], p2[1]);
  }
  s.closePath();
  return s;
}

function lathe(profile: [number, number][], segments = 96): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    segments,
  );
  g.computeVertexNormals();
  return g;
}

/** A smooth lathe profile through control points (radius, height), closed at both poles. */
function smoothProfile(ctrl: [number, number][], steps = 64): [number, number][] {
  const curve = new THREE.SplineCurve(ctrl.map(([r, y]) => new THREE.Vector2(r, y)));
  return curve.getPoints(steps).map((p) => [Math.max(0, p.x), p.y] as [number, number]);
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

/* ———————————————————————————— The twelve ———————————————————————————— */

const BLUE = 0x2a46d8; // Alevr presence ultramarine, lifted for a toy body

export const CHARACTERS: CharacterDef[] = [
  {
    id: "mira",
    name: "Mira",
    role: "Renewals",
    kind: "simple",
    color: BLUE,
    build: {
      body: (m) => mesh(pillow(roundedPolygon([[-0.95, 0.12], [0.95, 0.12], [0, 1.86]], [0.42, 0.42, 0.34]), 0.62, 0.3), m(BLUE)),
      parts: (m, dir) => {
        const k = dir === "B" ? 1.18 : 1;
        const disc = mesh(new THREE.CylinderGeometry(0.42 * k, 0.42 * k, 0.17, 72, 1), m(CREAM));
        const edge = disc.geometry as THREE.CylinderGeometry;
        edge.rotateX(Math.PI / 2);
        disc.position.set(0.8, 0.48 * k, 0.74);
        disc.rotation.set(0.04, -0.42, 0);
        return [disc];
      },
      eyes: { y: 0.82, gap: 0.24, size: 1, style: "oval" },
    },
  },
  {
    id: "otto",
    name: "Otto",
    role: "Finance ops",
    kind: "simple",
    color: 0xf2554a,
    build: {
      body: (m) => mesh(lathe(smoothProfile([[0, 0.05], [0.55, 0.1], [0.72, 0.5], [0.72, 1.15], [0.6, 1.5], [0, 1.62]])), m(0xf2554a)),
      parts: (m, dir) => {
        const k = dir === "B" ? 1.25 : 1;
        const cap = new THREE.Group();
        const dome = mesh(new THREE.SphereGeometry(0.72 * k, 64, 32, 0, Math.PI * 2, 0, Math.PI / 2), m(CREAM));
        dome.scale.set(1.03, 0.78, 1.03);
        const brim = mesh(pillow(roundedPolygon([[-0.5, 0], [0.5, 0], [0.42, 0.62], [-0.42, 0.62]], [0.1, 0.1, 0.4, 0.4]), 0.02, 0.04), m(0xe4d9c3));
        brim.rotation.x = Math.PI / 2;
        brim.position.set(0, 0.02, 0.52 * k);
        brim.scale.setScalar(k);
        cap.add(dome, brim);
        cap.position.y = 1.36;
        cap.rotation.set(-0.12, 0.35, 0.06);
        return [cap];
      },
      eyes: { y: 0.95, gap: 0.22, size: 0.95, style: "oval" },
    },
  },
  {
    id: "bram",
    name: "Bram",
    role: "Release notes",
    kind: "simple",
    color: 0x5a5ff0,
    build: {
      body: (m) => {
        const b = mesh(new RoundedBoxGeometry(1.7, 1.6, 1.2, 10, 0.42), m(0x5a5ff0));
        b.position.y = 0.82;
        return b;
      },
      parts: (m, dir) => {
        const k = dir === "B" ? 1.22 : 1;
        const g = new THREE.Group();
        for (const s of [-1, 1]) {
          const frame = mesh(new THREE.TorusGeometry(0.25 * k, 0.055 * k, 16, 64), m(INK, { gloss: true }));
          frame.scale.set(1.05, 0.92, 1);
          frame.position.set(s * 0.33 * k, 0, 0);
          g.add(frame);
        }
        const bridge = mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.2 * k, 12), m(INK, { gloss: true }));
        bridge.rotation.z = Math.PI / 2;
        g.add(bridge);
        g.position.set(0, 0.86, 0.66);
        return [g];
      },
      eyes: { y: 0.86, gap: 0.33, size: 0.9, style: "oval" },
    },
  },
  {
    id: "dew",
    name: "Dew",
    role: "Data",
    kind: "simple",
    color: 0x1fc3e6,
    build: {
      body: (m) => mesh(lathe(smoothProfile([[0, 0.04], [0.5, 0.08], [0.8, 0.55], [0.62, 1.15], [0.25, 1.6], [0, 1.95]])), m(0x1fc3e6)),
      eyes: { y: 0.66, gap: 0.24, size: 1, style: "sticker" },
    },
  },
  {
    id: "pip",
    name: "Pip",
    role: "Growth",
    kind: "simple",
    color: 0xf2557e,
    build: {
      body: (m) => {
        // A bean: a capsule bent into a soft kidney.
        const g = new THREE.CapsuleGeometry(0.52, 0.9, 24, 64);
        const p = g.attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < p.count; i++) {
          const y = p.getY(i);
          p.setX(i, p.getX(i) + 0.22 * Math.sin(y * 2.2) - 0.04 * y * y);
          p.setX(i, p.getX(i) * (1 + 0.08 * Math.cos(y * 3)));
        }
        g.computeVertexNormals();
        const b = mesh(g, m(0xf2557e));
        b.position.y = 0.98;
        b.rotation.z = -0.12;
        return b;
      },
      eyes: { y: 1.12, gap: 0.2, size: 0.95, style: "sticker", x: 0.12 },
    },
  },
  {
    id: "rhea",
    name: "Rhea",
    role: "Support",
    kind: "simple",
    color: 0x3dca8a,
    build: {
      body: (m) => mesh(lathe(smoothProfile([[0, 0.03], [0.78, 0.07], [0.86, 0.5], [0.8, 1.05], [0.5, 1.48], [0, 1.58]])), m(0x3dca8a)),
      parts: (m, dir) => {
        const k = dir === "B" ? 1.25 : 1;
        const g = new THREE.Group();
        const band = mesh(new THREE.TorusGeometry(0.9, 0.07 * k, 16, 80, Math.PI), m(CREAM));
        band.position.y = 0.82;
        g.add(band);
        for (const s of [-1, 1]) {
          const cup = mesh(new THREE.CylinderGeometry(0.26 * k, 0.26 * k, 0.22 * k, 48), m(CREAM));
          cup.rotation.z = Math.PI / 2;
          cup.position.set(s * 0.9, 0.82, 0);
          const pad = mesh(new THREE.TorusGeometry(0.2 * k, 0.07 * k, 16, 48), m(0xd9cfba));
          pad.rotation.y = Math.PI / 2;
          pad.position.set(s * (0.9 + 0.12 * k), 0.82, 0);
          g.add(cup, pad);
        }
        return [g];
      },
      eyes: { y: 0.8, gap: 0.23, size: 0.95, style: "oval" },
    },
  },
  // ——— Exclusive: Alevr's own geometry ———
  {
    id: "orbit",
    name: "Ori",
    role: "Orchestration",
    kind: "cosmic",
    color: 0xf3efe6,
    build: {
      body: (m) => {
        const b = mesh(new THREE.SphereGeometry(0.78, 96, 64), m(0xf6f2ea));
        b.scale.set(1, 0.97, 0.95);
        b.position.y = 0.8;
        return b;
      },
      parts: (m, dir) => {
        // The Orbit glyph: two separated elliptical arcs around the body.
        const k = dir === "B" ? 1.3 : 1;
        const g = new THREE.Group();
        for (const [start, len] of [
          [0.25, Math.PI * 1.05],
          [Math.PI * 1.42, Math.PI * 0.52],
        ] as const) {
          const arc = mesh(new THREE.TorusGeometry(1.2, 0.07 * k, 20, 140, len), m(BLUE));
          arc.rotation.z = start;
          g.add(arc);
        }
        g.rotation.set(-1.18, 0.12, -0.32);
        g.position.y = 0.82;
        return [g];
      },
      eyes: { y: 0.98, gap: 0.22, size: 0.9, style: "oval" },
    },
  },
  {
    id: "void",
    name: "Vanta",
    role: "Deep research",
    kind: "cosmic",
    color: 0x1c1830,
    build: {
      body: (m) => {
        const b = mesh(new THREE.SphereGeometry(0.72, 96, 64), m(0x1d1932));
        b.position.y = 0.86;
        return b;
      },
      parts: (m, dir) => {
        // The accretion disc: a flat glowing ring, hot inside, cooling out.
        const k = dir === "B" ? 1.12 : 1;
        const ring = mesh(new THREE.RingGeometry(0.86, 1.32 * k, 120, 3), m(0xffa43a, { emissive: 0xff8a1f, emissiveIntensity: 0.9, flat: true }));
        (ring.material as THREE.Material).side = THREE.DoubleSide;
        const glow = mesh(new THREE.TorusGeometry(0.88, 0.05, 16, 120), m(0xffe2a6, { emissive: 0xffd27a, emissiveIntensity: 1.4, flat: true }));
        const g = new THREE.Group();
        g.add(ring, glow);
        g.rotation.set(-1.32, 0, 0.22);
        g.position.y = 0.86;
        return [g];
      },
      eyes: { y: 0.98, gap: 0.22, size: 0.95, style: "oval", light: true },
    },
  },
  {
    id: "saturn",
    name: "Sato",
    role: "Planning",
    kind: "cosmic",
    color: 0xff9150,
    build: {
      body: (m) => {
        const b = mesh(new THREE.SphereGeometry(0.74, 96, 64), m(0xff9150));
        b.position.y = 0.8;
        return b;
      },
      parts: (m, dir) => {
        const k = dir === "B" ? 1.15 : 1;
        const ring = mesh(lathe([[0.98, -0.03], [1.34 * k, -0.015], [1.36 * k, 0], [1.34 * k, 0.015], [0.98, 0.03], [0.97, 0]], 128), m(0xb9a6f2));
        ring.rotation.set(0.32, 0, -0.32);
        ring.position.y = 0.78;
        return [ring];
      },
      eyes: { y: 0.98, gap: 0.22, size: 0.9, style: "oval" },
    },
  },
  {
    id: "luna",
    name: "Luna",
    role: "Overnight runs",
    kind: "cosmic",
    color: 0x6b74f4,
    build: {
      body: (m) => {
        // A crescent: the outer disc less an offset inner disc, joined at their two crossings.
        const [ox, oy, or] = [0, 0.95, 0.9];
        const [ix, iy, ir] = [0.5, 1.12, 0.74];
        const d = Math.hypot(ix - ox, iy - oy);
        const a = (or * or - ir * ir + d * d) / (2 * d);
        const h = Math.sqrt(or * or - a * a);
        const mx = ox + (a * (ix - ox)) / d;
        const my = oy + (a * (iy - oy)) / d;
        const p1 = [mx + (h * (iy - oy)) / d, my - (h * (ix - ox)) / d];
        const p2 = [mx - (h * (iy - oy)) / d, my + (h * (ix - ox)) / d];
        const ang = (cx: number, cy: number, q: number[]) => Math.atan2(q[1]! - cy, q[0]! - cx);
        const s = new THREE.Shape();
        s.absarc(ox, oy, or, ang(ox, oy, p2), ang(ox, oy, p1) + Math.PI * 2, false);
        s.absarc(ix, iy, ir, ang(ix, iy, p1), ang(ix, iy, p2), true);
        return mesh(pillow(s, 0.5, 0.26), m(0x6b74f4));
      },
      parts: (m, dir) => {
        const k = dir === "B" ? 1.25 : 1;
        const g = new THREE.Group();
        const cone = mesh(new THREE.ConeGeometry(0.4 * k, 1.0 * k, 48, 8), m(0x9fbcff));
        const p = (cone.geometry as THREE.ConeGeometry).attributes.position as THREE.BufferAttribute;
        for (let i = 0; i < p.count; i++) {
          const t = (p.getY(i) + 0.45 * k) / (0.9 * k);
          p.setX(i, p.getX(i) + 0.38 * t * t);
        }
        cone.geometry.computeVertexNormals();
        const pom = mesh(new THREE.SphereGeometry(0.12 * k, 32, 16), m(0xfbf7ee));
        pom.position.set(0.38, 0.45 * k, 0);
        g.add(cone, pom);
        g.position.set(-0.42, 1.72, 0.05);
        g.rotation.z = 0.42;
        return [g];
      },
      eyes: { y: 0.88, gap: 0.17, size: 0.85, style: "sleepy", x: -0.32 },
    },
  },
  {
    id: "comet",
    name: "Kip",
    role: "Quick tasks",
    kind: "cosmic",
    color: 0xffc83d,
    build: {
      body: (m) => {
        const b = mesh(new THREE.SphereGeometry(0.66, 96, 64), m(0xffc83d));
        b.position.set(0.25, 0.72, 0.1);
        return b;
      },
      parts: (m, dir) => {
        const k = dir === "B" ? 1.2 : 1;
        const g = new THREE.Group();
        const tails: [number, number, number][] = [
          [0.45, 1.5, 0],
          [0.28, 1.15, 0.38],
          [0.24, 1.05, -0.36],
        ];
        tails.forEach(([r, len, a], i) => {
          const t = mesh(new THREE.ConeGeometry(r * k, len * k, 48, 4), m(i === 0 ? 0xffe39a : 0xfff0c6));
          t.rotation.z = Math.PI / 2 + a * 0.6;
          t.scale.z = 0.45;
          t.position.set(-0.45 - (len * k) / 2 + 0.3, 0.78 + a * 0.35, -0.25 - i * 0.05);
          g.add(t);
        });
        return [g];
      },
      eyes: { y: 0.8, gap: 0.21, size: 0.95, style: "dot", x: 0.32 },
    },
  },
  {
    id: "pulsar",
    name: "Vela",
    role: "Monitoring",
    kind: "cosmic",
    color: 0x9b5cf5,
    build: {
      body: (m) => {
        // The four-point star: Alevr's spark as a body.
        const pts: [number, number][] = [];
        for (let i = 0; i < 8; i++) {
          const a = Math.PI / 2 + (i * Math.PI) / 4;
          const r = i % 2 === 0 ? (i === 0 || i === 4 ? 1.0 : 0.95) : 0.36;
          pts.push([Math.cos(a) * r, 0.98 + Math.sin(a) * r]);
        }
        return mesh(pillow(roundedPolygon(pts, pts.map((_, i) => (i % 2 === 0 ? 0.2 : 0.3))), 0.5, 0.26), m(0x9b5cf5));
      },
      eyes: { y: 0.98, gap: 0.16, size: 0.85, style: "pill" },
    },
  },
];

/* ———————————————————————————— Materials ———————————————————————————— */

function materialFor(dir: Direction, small: boolean) {
  return (color: number, opts: MatOpts = {}): THREE.Material => {
    const c = new THREE.Color(color);
    if (opts.flat) {
      return new THREE.MeshStandardMaterial({ color: c, emissive: new THREE.Color(opts.emissive ?? 0), emissiveIntensity: opts.emissiveIntensity ?? 0, roughness: 0.6 });
    }
    if (opts.gloss) return new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.32, clearcoat: 0.6, clearcoatRoughness: 0.3 });
    if (dir === "A") {
      // Soft matte vinyl: a gentle broad highlight, no sparkle.
      return new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.52, clearcoat: 0.18, clearcoatRoughness: 0.75, emissive: new THREE.Color(opts.emissive ?? 0), emissiveIntensity: opts.emissiveIntensity ?? 0 });
    }
    // Velvet flock: no specular; a fine fibre grain in the normal (hashed from
    // world position, so every geometry gets the same pile without UVs) and a
    // soft bright rim where the fibres are seen side-on.
    const rim = c.clone().lerp(new THREE.Color(0xffffff), 0.7);
    const mat = new THREE.MeshPhysicalMaterial({
      color: c.clone().multiplyScalar(0.8),
      roughness: 1,
      sheen: 0.8,
      sheenRoughness: 0.5,
      sheenColor: rim,
      emissive: new THREE.Color(opts.emissive ?? 0),
      emissiveIntensity: opts.emissiveIntensity ?? 0,
    });
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uRim = { value: rim };
      shader.uniforms.uGrain = { value: small ? 0 : 0.22 };
      shader.vertexShader = shader.vertexShader
        .replace("#include <common>", "#include <common>\nvarying vec3 vWorldP;")
        .replace("#include <worldpos_vertex>", "#include <worldpos_vertex>\nvWorldP = (modelMatrix * vec4(transformed, 1.0)).xyz;");
      shader.fragmentShader = shader.fragmentShader
        .replace(
          "#include <common>",
          "#include <common>\nvarying vec3 vWorldP;\nuniform vec3 uRim;\nuniform float uGrain;\nvec3 h3(vec3 p){p=fract(p*vec3(443.897,441.423,437.195));p+=dot(p,p.yxz+19.19);return fract((p.xxy+p.yxx)*p.zyx);}",
        )
        .replace("#include <normal_fragment_maps>", "#include <normal_fragment_maps>\nnormal = normalize(normal + uGrain * (h3(floor(vWorldP * 110.0)) - 0.5));")
        .replace(
          "#include <opaque_fragment>",
          "float fres = pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 2.6);\noutgoingLight = mix(outgoingLight, uRim * 0.95, fres * 0.55);\n#include <opaque_fragment>",
        );
    };
    return mat;
  };
}

/* ———————————————————————————— Eyes, painted on the surface ———————————————————————————— */

const ray = new THREE.Raycaster();

function hitFront(targets: THREE.Object3D[], x: number, y: number): { p: THREE.Vector3; n: THREE.Vector3 } | null {
  ray.set(new THREE.Vector3(x, y, 10), new THREE.Vector3(0, 0, -1));
  const hit = ray.intersectObjects(targets, true)[0];
  if (!hit || !hit.face) return null;
  const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld).normalize();
  return { p: hit.point.clone(), n };
}

function disc(targets: THREE.Object3D[], x: number, y: number, rx: number, ry: number, color: number, lidCut = 0): THREE.Mesh | null {
  const h = hitFront(targets, x, y);
  if (!h) return null;
  let geo: THREE.BufferGeometry;
  if (lidCut > 0) {
    // Lowered lids: an ellipse with its top cut flat.
    const s = new THREE.Shape();
    const top = 1 - lidCut * 2;
    const a0 = Math.asin(Math.max(-1, Math.min(1, top)));
    s.absellipse(0, 0, 1, 1, a0, Math.PI - a0, true, 0);
    s.closePath();
    geo = new THREE.ExtrudeGeometry(s, { depth: 0.02, bevelEnabled: false, curveSegments: 48 });
  } else {
    geo = new THREE.CylinderGeometry(1, 1, 0.02, 64);
    geo.rotateX(Math.PI / 2);
  }
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.92 }));
  m.scale.set(rx, ry, 1);
  m.position.copy(h.p).addScaledVector(h.n, 0.012);
  m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), h.n);
  return m;
}

function arc(targets: THREE.Object3D[], x: number, y: number, w: number, bend: number, radius: number, color: number): THREE.Object3D | null {
  const pts: THREE.Vector3[] = [];
  for (let i = 0; i <= 16; i++) {
    const t = i / 16;
    const px = x - w + 2 * w * t;
    const py = y + bend * (1 - Math.pow(2 * t - 1, 2));
    const h = hitFront(targets, px, py);
    if (!h) return null;
    pts.push(h.p.addScaledVector(h.n, radius * 0.7));
  }
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.92 });
  g.add(new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 48, radius, 12), mat));
  for (const p of [pts[0]!, pts[pts.length - 1]!]) {
    const cap = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), mat);
    cap.position.copy(p);
    g.add(cap);
  }
  return g;
}

function paintEyes(group: THREE.Group, surface: THREE.Object3D, def: CharacterDef, dir: Direction, state: EyeState, small: boolean) {
  group.updateMatrixWorld(true);
  const e = def.build.eyes;
  const big = 1.45 * (dir === "B" ? 1.2 : 1) * (small ? 1.45 : 1) * e.size;
  const ink = e.light ? 0xf4efe4 : INK;
  const cx = e.x ?? 0;
  const style: EyeStyle = state === "ready" ? e.style : e.style === "sleepy" || e.style === "arc" ? "oval" : e.style;
  for (const s of [-1, 1]) {
    const x = cx + s * e.gap * (dir === "B" ? 1.08 : 1);
    const y = e.y;
    const lw = (small ? 0.05 : 0.036) * Math.max(0.9, big);
    let part: THREE.Object3D | null = null;
    const aw = Math.min(0.062 * big, e.gap * 0.62);
    if (state === "finished") part = arc([surface], x, y - 0.03, aw, aw * 0.9, lw, ink);
    else if (state === "paused" || style === "sleepy") part = arc([surface], x, y + 0.03, aw, -aw * 0.8, lw, ink);
    else if (style === "arc") part = arc([surface], x, y - 0.03, aw, aw * 0.9, lw, ink);
    else {
      let dx = 0;
      let dy = 0;
      let k = 1;
      let lid = 0;
      if (state === "thinking") {
        dx = 0.05;
        dy = 0.07;
      } else if (state === "working") {
        dy = -0.04;
        lid = 0.36;
      } else if (state === "waiting") {
        k = 1.18;
      }
      const rx = (style === "dot" ? 0.056 : style === "pill" ? 0.05 : 0.064) * big * k;
      const ry = (style === "dot" ? 0.056 : style === "pill" ? 0.12 : 0.1) * big * k;
      if (style === "sticker") {
        const white = disc([surface], x, y, 0.105 * big * k, 0.105 * big * k, 0xfbfaf5, lid);
        if (white) group.add(white);
        group.updateMatrixWorld(true);
        part = disc(white ? [white] : [surface], x + dx * 0.7, y + dy * 0.7 - (lid ? 0.02 : 0), 0.05 * big, 0.05 * big, INK);
      } else part = disc([surface], x + dx, y + dy, rx, ry, ink, lid);
    }
    if (part) group.add(part);
  }
}

/* ———————————————————————————— Rendering ———————————————————————————— */

export function buildCharacter(def: CharacterDef, dir: Direction, state: EyeState, small: boolean): THREE.Group {
  const m = materialFor(dir, small);
  const group = new THREE.Group();
  const body = def.build.body(m);
  const holder = new THREE.Group();
  holder.add(body);
  // B: more playful proportions, a little squatter and wider.
  if (dir === "B") holder.scale.set(1.09, 0.92, 1.05);
  group.add(holder);
  for (const p of def.build.parts?.(m, dir) ?? []) group.add(p);
  paintEyes(group, body, def, dir, state, small);
  // State in the pose: a lift for "needs your answer", a lean into the work.
  if (state === "waiting") {
    group.position.y = 0.1;
    group.rotation.z = -0.05;
  } else if (state === "working") group.rotation.x = 0.08;
  else if (state === "thinking") group.rotation.z = 0.06;
  return group;
}

function contactShadow(): THREE.Mesh {
  const c = document.createElement("canvas");
  c.width = c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  g.addColorStop(0, "rgba(28,24,48,0.42)");
  g.addColorStop(0.45, "rgba(28,24,48,0.16)");
  g.addColorStop(1, "rgba(28,24,48,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(c);
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 1.3), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
  plane.rotation.x = -Math.PI / 2;
  plane.position.y = 0.002;
  return plane;
}

export class Studio {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(22, 1, 0.1, 50);
  private slot = new THREE.Group();

  constructor() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.VSMShadowMap;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.85;
    // High key: a big warm key from the upper left, a cool fill, a top light.
    const key = new THREE.DirectionalLight(0xfff4e8, 1.6);
    key.position.set(-3, 6, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.radius = 14;
    key.shadow.blurSamples = 16;
    key.shadow.bias = -0.0004;
    key.shadow.camera.left = key.shadow.camera.bottom = -2.5;
    key.shadow.camera.right = key.shadow.camera.top = 2.5;
    const fill = new THREE.DirectionalLight(0xe6eeff, 0.55);
    fill.position.set(4, 2, 3);
    const rim = new THREE.DirectionalLight(0xffffff, 0.7);
    rim.position.set(0, 4, -5);
    this.scene.add(key, fill, rim, new THREE.HemisphereLight(0xffffff, 0xece6dc, 0.6));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(12, 12), new THREE.ShadowMaterial({ opacity: 0.1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground, contactShadow(), this.slot);
    this.camera.position.set(0, 1.55, 8.2);
    this.camera.lookAt(0, 0.95, 0);
  }

  render(def: CharacterDef, dir: Direction, state: EyeState, px: number): string {
    const small = px <= 28;
    const dpr = 2;
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(px * dpr, px * dpr, false);
    this.renderer.setClearColor(BG, 0);
    this.slot.clear();
    const g = buildCharacter(def, dir, state, small);
    // Sprites are framed tighter so the character fills the small box.
    g.scale.setScalar(small ? 1.28 : 1);
    this.slot.add(g);
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL("image/png");
  }
}
