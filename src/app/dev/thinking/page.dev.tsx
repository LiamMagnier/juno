import { notFound } from "next/navigation";

import { ThinkingPanelGallery } from "./gallery";

/**
 * Dev-only gallery for the thought-process panel (the dock a response's
 * activity strip opens): `?state=running` (writing, the reference screenshot's
 * run), `research` (live, sources arriving), `finished` (sources, a tool call,
 * cost) or `stopped` (a notice); `&width=mobile` draws it at phone width,
 * where it covers the chat and leads with a way back. Not linked from
 * anywhere and 404s outside development.
 */
export default async function ThinkingDevPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; width?: string }>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { state, width } = await searchParams;
  return <ThinkingPanelGallery state={state ?? "running"} mobile={width === "mobile"} />;
}
