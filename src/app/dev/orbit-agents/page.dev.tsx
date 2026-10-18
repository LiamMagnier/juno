import { notFound } from "next/navigation";
import { OrbitMotionPreview } from "./preview";

/**
 * Dev only: the Orbit agents proposal — characters, motion, hover and states.
 * The 3D portraits and motion frames are Blender renders that are not committed:
 *
 *   cd tools/crew/blender
 *   blender --background --factory-startup --python orbit_render.py -- all ../../../public/dev-assets/orbit-agents
 *   blender --background --factory-startup --python orbit_motion.py -- ../../../public/dev-assets/orbit-agents mira
 *
 * (public/dev-assets is git-ignored). The flat 2D icons are generated into
 * orbit-icons.generated.ts by orbit_flat.py + orbit_flat_ts.py and need nothing.
 * `?demo=1` cycles the states. Not linked from anywhere; 404s outside development.
 */
export default async function OrbitAgentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const sp = await searchParams;
  return <OrbitMotionPreview base="/dev-assets/orbit-agents" demo={sp.demo === "1"} />;
}
