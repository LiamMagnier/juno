import { notFound } from "next/navigation";
import { SourcesGallery } from "./gallery";

/** Dev-only: inline citations and the Sources pill at transcript size. 404s outside development. */
export default function SourcesDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <SourcesGallery />;
}
