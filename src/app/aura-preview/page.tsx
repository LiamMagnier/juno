import { notFound } from "next/navigation";
import { AuraPreview } from "./preview";

/**
 * Dev-only visual harness for the ambient aura. It shipped to production once
 * with no guard — a public route rendering an internal test bench. Same
 * contract as /dev/*: not linked from anywhere and 404s outside development.
 */
export default function AuraPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <AuraPreview />;
}
