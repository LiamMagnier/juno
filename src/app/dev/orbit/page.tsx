import { notFound } from "next/navigation";
import { OrbitGallery } from "./gallery";

/**
 * Dev-only gallery for the Orbit rework (docs/rework/program/ORBIT.md): the
 * REAL MessageList with a room's named speakers and handoff lines, the REAL
 * WorkRunPanel with a temporary team's member lines, durable-goal rows and
 * a task's activity as sentences, over fixtures, without an account.
 *
 *   ?only=room | team | goals | activity
 *
 * Not linked from anywhere and 404s outside development.
 */
export default async function OrbitDevPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (process.env.NODE_ENV === "production") notFound();
  const { only } = await searchParams;
  return <OrbitGallery only={typeof only === "string" ? only : undefined} />;
}
