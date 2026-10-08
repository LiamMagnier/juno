import { notFound } from "next/navigation";
import { LiveUIGallery } from "./gallery";

/**
 * Dev-only gallery for Live UI (docs/design/LIVE_UI.md). Every sample is a
 * whole assistant reply rendered through the chat's real Markdown component,
 * so the fence routing, the streaming path and the view are exactly what a
 * conversation shows. Not linked from anywhere and 404s outside development.
 */
export default function LiveUIDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <LiveUIGallery />;
}
