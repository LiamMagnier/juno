import { notFound } from "next/navigation";

import { RunGallery } from "./gallery";

/**
 * Dev-only gallery for the chat run UI (SPEC §11.1): the 28 `/dev/run`
 * fixtures, each a turn script played through the server's `TurnStream` and
 * the client's `applyStreamChunk`, rendered by the real `RunBlock` under a
 * minimal transcript, with a stepper and the shared toggles (theme, width,
 * locale, direction, accent, text size, simulated reduced motion, the panel).
 * `?fixture=4` opens one. Not linked from anywhere and 404s outside
 * development, like every `/dev` page.
 */
export default async function RunDevPage({ searchParams }: { searchParams: Promise<{ fixture?: string }> }) {
  if (process.env.NODE_ENV === "production") notFound();
  const { fixture } = await searchParams;
  const number = Number(fixture);
  return <RunGallery initialFixture={Number.isInteger(number) && number >= 1 && number <= 28 ? number : 4} />;
}
