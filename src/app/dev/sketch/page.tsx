import { notFound } from "next/navigation";
import { SketchGallery } from "./gallery";

/**
 * Dev-only gallery for Sketch (components/chat/sketch): the real dialog over
 * a blank page, the PNG it exports, and the composer's attachment row with the
 * sketch on it (its label, and a click that reopens the drawing).
 *
 * `?open=1` opens the sheet on load (for screenshots). Not linked from
 * anywhere and 404s outside development, the same contract as /dev/premium.
 */
export default async function SketchDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { open } = await searchParams;
  return <SketchGallery openOnLoad={open === "1"} />;
}
