import { notFound } from "next/navigation";
import { SandboxGallery } from "./gallery";

/**
 * Dev-only gallery for artifact previews. Mounts the REAL SandboxFrame,
 * MermaidBlock and SharedArtifactViewer — one per runtime, in both sandbox
 * profiles — under the app's real enforcing CSP, so "do previews run?" (audit
 * X-01) and "what may they reach?" can be checked without an account or a
 * conversation. Each frame's status and console lines are printed under it.
 * Not linked from anywhere and 404s outside development.
 */
export default function SandboxDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <SandboxGallery />;
}
