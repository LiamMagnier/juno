import { notFound } from "next/navigation";
import { PermissionsGallery } from "./gallery";

export default function PermissionsDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <PermissionsGallery />;
}
