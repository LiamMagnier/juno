import { notFound } from "next/navigation";
import { ConnectionsGallery } from "./gallery";

export default function ConnectionsDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ConnectionsGallery />;
}
