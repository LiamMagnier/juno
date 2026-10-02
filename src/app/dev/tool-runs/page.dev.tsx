import { notFound } from "next/navigation";
import { ToolRunsGallery } from "./gallery";

/**
 * Dev-only gallery for real runs on every surface (TOOL_RUNTIME_DESIGN.md
 * §6.12, lane L4): each phase of `run_code`, `check_run` and the skill tools,
 * settled, in the REAL components over the wire fixtures
 * (src/lib/chat/tool-run-fixtures.ts):
 *
 *   phases     every phase as a chat receipt row with its detail open
 *   strip      the run strip above the answer, live and settled, with files,
 *              and the real Thought process panel docked beside it
 *   code       web Code activity
 *   orbit      an Orbit task's feed and current action
 *   voice      what a voice-mode turn says
 *   live       one run stepping through its phases, with the announcements
 *
 * `?only=<section>` renders one section. Not linked from anywhere; the page
 * extension exists only outside production builds and it 404s there anyway.
 */
export default async function ToolRunsDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { only } = await searchParams;
  return <ToolRunsGallery only={typeof only === "string" ? only : undefined} />;
}
