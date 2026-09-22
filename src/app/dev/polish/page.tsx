import { notFound } from "next/navigation";
import { PolishGallery } from "./gallery";

/**
 * Dev-only gallery for the thread, its states and the shared primitives they
 * are drawn with: the reply and the user bubble at reading size, the thinking
 * line, editing a sent message in its bubble, the starter chips with their
 * examples open, the empty and error states at both sizes, the text field's
 * three states and the chat skeletons beside the frame they stand in for.
 *
 * Every one of those is a claim about how two things look TOGETHER (a question
 * beside its answer, a placeholder beside the page that replaces it) and the
 * product only ever shows them one at a time, behind a sign-in. Here they are
 * rendered from the real components, on the real tokens.
 *
 * Not linked from anywhere and 404s outside development, the same contract as
 * /dev/controls.
 */
export default function PolishDevPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <PolishGallery />;
}
