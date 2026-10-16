import { notFound } from "next/navigation";

import { BlueprintGallery } from "./gallery";

/**
 * Dev-only gallery for the live blueprint (src/components/canvas/live-blueprint.tsx):
 * a sample page streamed into the real artifact card at a steady pace, with
 * restart, speed, source and simulated reduced motion. Not linked from
 * anywhere and 404s outside development, like every `/dev` page.
 */
export default function BlueprintDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <BlueprintGallery />;
}
