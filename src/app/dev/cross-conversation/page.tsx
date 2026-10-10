import { notFound } from "next/navigation";
import { CrossConversationGallery } from "./gallery";

/**
 * Dev-only gallery for conversations messaging each other
 * (src/lib/cross-conversation): the transcript rows a Chat draws for a
 * message it received, the reply under it, a message it sent and the idle
 * notice. Fixture data, no account. 404s outside development, like every
 * /dev page.
 */
export default function CrossConversationDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <CrossConversationGallery />;
}
