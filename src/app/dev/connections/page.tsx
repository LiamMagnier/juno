import { notFound } from "next/navigation";
import { PageRoot } from "@/components/app/page-root";
import { ConnectionsGallery } from "./gallery";

export default function ConnectionsDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <PageRoot>
      <ConnectionsGallery />
    </PageRoot>
  );
}
