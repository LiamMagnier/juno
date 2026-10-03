import { notFound } from "next/navigation";
import { AsciiGallery } from "./gallery";

/** Dev-only: the access panel's construction as hairlines vs ASCII. 404s in production. */
export default function AsciiDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <AsciiGallery />;
}
