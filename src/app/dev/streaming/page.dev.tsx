import { notFound } from "next/navigation";
import { StreamingGallery } from "./gallery";

/**
 * Dev-only bench for streamed writing (stream-text.tsx, stream-pacer.ts) and
 * the transcript's eased follow (use-transcript-window.ts): the REAL
 * MessageList replaying a reply over a simulated network that delivers it in
 * irregular bursts, as a model behind a proxy does. Markdown with headings,
 * lists, code, a table and a quote, plus a long mode (~6,000 words) with a
 * frame-time readout.
 *
 * `?autoplay=short|long` starts a run on load (screenshots). Not linked from
 * anywhere; 404s outside development.
 */
export default async function StreamingDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { autoplay } = await searchParams;
  return <StreamingGallery autoplay={autoplay === "short" || autoplay === "long" ? autoplay : undefined} />;
}
