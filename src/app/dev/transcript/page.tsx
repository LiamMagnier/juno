import { notFound } from "next/navigation";
import { TranscriptGallery } from "./gallery";

/**
 * Dev-only gallery for the transcript details (docs/design/premium-pass/BRIEF.md):
 * the REAL MessageItem, MessageList and Markdown over sample turns, so message
 * actions, code blocks, diffs, tool rows, markdown rhythm and the streaming
 * feel can be checked in both themes without an account or a live model.
 *
 *   conversation  a settled thread: prose, tables, code in several languages,
 *                 a diff, a clamped long block, run strips, versions, actions
 *   states        errors, a token-limit stop, an interrupted partial answer
 *   audio         a generated Lyria track: the player, its lyrics, the placeholder
 *   streaming     a MessageList replaying a reply chunk by chunk, with the
 *                 follow, the tail fade and "Jump to latest"
 *   shared        the public /share transcript over the same turns
 *
 * `?only=<section>` renders one section. Not linked from anywhere and 404s
 * outside development, the same contract as /dev/premium.
 */
export default async function TranscriptDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { only } = await searchParams;
  return <TranscriptGallery only={typeof only === "string" ? only : undefined} />;
}
