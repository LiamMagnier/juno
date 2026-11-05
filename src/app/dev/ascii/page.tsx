import { notFound } from "next/navigation";
import { PageRoot } from "@/components/app/page-root";
import { AsciiGallery } from "./gallery";

/** Dev-only: the access panel's construction as hairlines vs ASCII. 404s in production. */
export default function AsciiDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <PageRoot>
      <AsciiGallery />
    </PageRoot>
  );
}
