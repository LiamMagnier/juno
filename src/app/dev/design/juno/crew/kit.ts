/**
 * The crew kit, modeled in Blender (tools/crew/blender), loaded for three.js.
 *
 *   /crew/models/crew-bodies.glb   every body shape at two levels of detail. All
 *                                  shapes share one topology: each LOD is one mesh
 *                                  whose morph targets are the other shapes, with
 *                                  per-shape ambient occlusion and fur length as
 *                                  custom attributes (_ao_<shape>, _fur_<shape>).
 *   /crew/models/crew-parts.glb    eyes, features and accessory parts, each in its
 *                                  canonical frame (fit.ts places them).
 *   /crew/textures/fur-strands.png the tileable strand field the shell fur samples.
 *
 * Loaded once per page (about 2.5 MB, cached by the browser), only when a
 * character must be drawn that no cached sprite covers.
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { KIT_HASH, MORPH_ORDER } from "./kit-data";

export type ShapeId = (typeof MORPH_ORDER)[number];
export type Lod = "lod0" | "lod1";

export interface Kit {
  /** The body for a shape at a level of detail: position, normal, uv, `ao` and `fur` (length mask). Cached. */
  body(shape: ShapeId, lod: Lod): THREE.BufferGeometry;
  /** A part's geometry in its canonical frame, or null if the kit has no such part. */
  part(name: string): THREE.BufferGeometry | null;
  partNames(): string[];
  strands: THREE.Texture;
}

const BASE = "/crew/";

interface LodSource {
  base: THREE.BufferGeometry;
  targets: string[];
}

class KitImpl implements Kit {
  private cache = new Map<string, THREE.BufferGeometry>();
  constructor(
    private lods: Record<Lod, LodSource>,
    private parts: Map<string, THREE.BufferGeometry>,
    public strands: THREE.Texture,
  ) {}

  body(shape: ShapeId, lod: Lod): THREE.BufferGeometry {
    const key = `${shape}|${lod}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const src = this.lods[lod];
    const base = src.base;
    const g = new THREE.BufferGeometry();
    g.setIndex(base.index);
    g.setAttribute("uv", base.attributes.uv);
    const pos0 = base.attributes.position as THREE.BufferAttribute;
    const nor0 = base.attributes.normal as THREE.BufferAttribute;
    const ti = src.targets.indexOf(shape);
    let pos = pos0;
    let nor = nor0;
    if (ti >= 0) {
      const dp = base.morphAttributes.position![ti] as THREE.BufferAttribute;
      const dn = base.morphAttributes.normal?.[ti] as THREE.BufferAttribute | undefined;
      const relative = base.morphTargetsRelative;
      const p = new Float32Array(pos0.count * 3);
      const n = new Float32Array(pos0.count * 3);
      for (let i = 0; i < pos0.count; i++) {
        for (let k = 0; k < 3; k++) {
          const b = pos0.array[i * 3 + k];
          const d = dp.array[i * 3 + k];
          p[i * 3 + k] = relative ? b + d : d;
          const bn = nor0.array[i * 3 + k];
          const dnn = dn ? dn.array[i * 3 + k] : 0;
          n[i * 3 + k] = dn ? (relative ? bn + dnn : dnn) : bn;
        }
        const l = Math.hypot(n[i * 3], n[i * 3 + 1], n[i * 3 + 2]) || 1;
        n[i * 3] /= l;
        n[i * 3 + 1] /= l;
        n[i * 3 + 2] /= l;
      }
      pos = new THREE.BufferAttribute(p, 3);
      nor = new THREE.BufferAttribute(n, 3);
    }
    g.setAttribute("position", pos);
    g.setAttribute("normal", nor);
    const ao = base.attributes[`_ao_${shape}`] as THREE.BufferAttribute | undefined;
    const fur = base.attributes[`_fur_${shape}`] as THREE.BufferAttribute | undefined;
    g.setAttribute("ao", ao ?? new THREE.BufferAttribute(new Float32Array(pos0.count).fill(1), 1));
    g.setAttribute("fur", fur ?? new THREE.BufferAttribute(new Float32Array(pos0.count).fill(1), 1));
    g.computeBoundingBox();
    g.computeBoundingSphere();
    this.cache.set(key, g);
    return g;
  }

  part(name: string) {
    return this.parts.get(name) ?? null;
  }

  partNames() {
    return [...this.parts.keys()];
  }
}

let ready: Kit | null = null;
let pending: Promise<Kit> | null = null;

/** The kit if it has loaded, else null. */
export function kitSync(): Kit | null {
  return ready;
}

function loadGlb(loader: GLTFLoader, url: string) {
  return new Promise<THREE.Group>((resolve, reject) => loader.load(url, (g) => resolve(g.scene), undefined, reject));
}

/** Load the kit once (later calls share the promise). */
export function loadKit(): Promise<Kit> {
  pending ??= (async () => {
    const loader = new GLTFLoader();
    const [bodies, parts, strands] = await Promise.all([
      loadGlb(loader, `${BASE}models/crew-bodies.glb?v=${KIT_HASH}`),
      loadGlb(loader, `${BASE}models/crew-parts.glb?v=${KIT_HASH}`),
      new THREE.TextureLoader().loadAsync(`${BASE}textures/fur-strands.png?v=${KIT_HASH}`),
    ]);
    strands.wrapS = strands.wrapT = THREE.RepeatWrapping;
    strands.colorSpace = THREE.NoColorSpace;
    strands.generateMipmaps = true;
    strands.minFilter = THREE.LinearMipmapLinearFilter;
    strands.magFilter = THREE.LinearFilter;
    strands.flipY = false;
    const lods = {} as Record<Lod, LodSource>;
    bodies.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      // Node names lose their dots in three.js; the exporter's extras keep them.
      const lod = ((m.userData?.lod as string | undefined) ?? (m.name.includes("lod1") ? "lod1" : "lod0")) as Lod;
      const names = (m.geometry.userData?.targetNames as string[] | undefined) ?? (m.morphTargetDictionary ? Object.keys(m.morphTargetDictionary).sort((a, b) => m.morphTargetDictionary![a] - m.morphTargetDictionary![b]) : MORPH_ORDER.slice(1));
      lods[lod] = { base: m.geometry, targets: names };
    });
    const partMap = new Map<string, THREE.BufferGeometry>();
    parts.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const g = m.geometry.clone();
      // Bake any node transform the exporter left on the part.
      m.updateMatrixWorld(true);
      if (!m.matrixWorld.equals(new THREE.Matrix4())) g.applyMatrix4(m.matrixWorld);
      g.computeBoundingBox();
      partMap.set((m.userData?.part as string | undefined) ?? m.name, g);
    });
    const kit = new KitImpl(lods, partMap, strands);
    ready = kit;
    return kit;
  })();
  return pending;
}
