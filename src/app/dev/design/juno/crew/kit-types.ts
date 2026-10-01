/**
 * The shape of the crew kit's data (kit-data.ts is generated from the Blender
 * kit by tools/crew/blender/crew_export.py; public/crew/manifest.json carries
 * the same numbers for the native apps).
 *
 * Coordinates are glTF's: x across (the viewer's right), y up, z toward the
 * viewer. The body stands on y = 0 and is about one unit tall.
 */

export type V3 = [number, number, number];

export interface KitFrame {
  p: V3;
  n: V3;
}

export interface KitShape {
  label: string;
  bounds: { bottom: number; top: number; halfWidth: number; halfDepth: number };
  /** Eye placement rules (cuteness, D-033): ranges the avatar's 0..1 controls map onto. */
  face: { y: [number, number]; gap: [number, number]; r: [number, number]; top: number; hw?: number };
  anchors: {
    crown: KitFrame & { r: number; rz: number; capY: number; cz: number };
    ears: [KitFrame, KitFrame];
    neck: { y: number; cz: number; rx: number; rz: number };
    pin: KitFrame;
    height: number;
    top: number;
  };
  /** The front silhouette (x, y), for the flat placeholder. */
  outline: [number, number][];
  /** Half-width of the body at 24 heights from the ground to the top. */
  hw: number[];
  eared: boolean;
}

export interface KitAccessory {
  label: string;
  slot: string;
  fit: string;
  parts: string[];
}
