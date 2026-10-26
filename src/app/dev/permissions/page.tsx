import { notFound } from "next/navigation";
import { PageRoot } from "@/components/app/page-root";
import { PermissionsGallery } from "./gallery";

export default function PermissionsDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <PageRoot>
      <PermissionsGallery />
    </PageRoot>
  );
}
