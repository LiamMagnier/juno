import { notFound } from "next/navigation";
import { GenerationGallery } from "./gallery";

/**
 * Dev-only gallery for generated media (src/components/chat/generation.css):
 * the waiting field at each requested ratio, video with real progress, audio,
 * and the arrival on the REAL MessageItem: a turn that was generating is
 * settled with its result, so the reveal, the frame morph and the grid's
 * staggered sweep play exactly as they do in a chat. "Replay" runs it again.
 *
 * `?only=<section>` renders one section; `?theme=dark` starts dark. Not linked
 * from anywhere and 404s outside development, like /dev/transcript.
 */
export default async function GenerationDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { only, theme } = await searchParams;
  return <GenerationGallery only={typeof only === "string" ? only : undefined} dark={theme === "dark"} />;
}
