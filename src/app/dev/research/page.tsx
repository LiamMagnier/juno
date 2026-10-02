import { Suspense } from "react";
import { notFound } from "next/navigation";
import { ResearchGallery } from "./gallery";

/**
 * Dev-only gallery for the Research UI (SPEC §11.2): the real scope card,
 * row, panel, report reader and completion watcher parts, driven by fixture
 * runs through a fetch shim so the real hooks run. Pick a state with
 * `?state=`. Not linked from anywhere, no auth, and 404s outside development.
 */
export default function ResearchDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <Suspense>
      <ResearchGallery />
    </Suspense>
  );
}
