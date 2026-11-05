import { notFound } from "next/navigation";
import { PageRoot } from "@/components/app/page-root";
import { SourcesGallery } from "./gallery";

/** Dev-only: inline citations and the Sources pill at transcript size. 404s outside development. */
export default function SourcesDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <PageRoot>
      <SourcesGallery />
    </PageRoot>
  );
}
