import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CodeV2GalleryClient } from "./client";

/**
 * Dev-only gallery for the Alevr Code v2 workspace (DESIGN §6,
 * INTERACTION_SPEC §3): every state over fixture data. `?state=` picks one
 * (streaming, needs-you, limited, subagents, best-of-n, model-picker,
 * model-catalog, tiers,
 * orchestrate, plan, empty, offline, no-provider, connections), `?bare=1`
 * hides the gallery bar, `?theme=dark`, `?motion=reduced`. Not linked from
 * anywhere, no auth, and absent from production builds (page.dev.tsx).
 */
export default function CodeV2DevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense>
      <CodeV2GalleryClient />
    </Suspense>
  );
}
