import { notFound } from "next/navigation";
import { ShareLinksGallery } from "./gallery";

/**
 * Dev-only gallery for public-link governance: the share page's Report dialog
 * and the admin Links page, rendered for real against canned API answers (a
 * fetch shim in ./gallery), because the one needs a live share and the other a
 * signed-in owner with two-step on. Not linked from anywhere and 404s outside
 * development.
 */
export default function ShareLinksDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ShareLinksGallery />;
}
