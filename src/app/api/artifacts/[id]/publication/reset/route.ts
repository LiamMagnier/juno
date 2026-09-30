import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";
import { PublicationTakenDownError, resetPublicationLink } from "@/lib/artifact-publication";

export const runtime = "nodejs";

/**
 * Reset the published link: the old URL answers "link gone" (410 on its
 * poster, the gone page on the page itself) for good, and the publication
 * continues under a new token with the same pin and state. For a link that
 * was forwarded further than the owner meant.
 */
export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await artifactWriteLimited(user, "publish");
  if (limited) return limited;

  const { id } = await params;
  try {
    const reset = await resetPublicationLink(user.id, id);
    if (!reset) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ publication: reset.publication });
  } catch (error) {
    if (error instanceof PublicationTakenDownError) {
      return NextResponse.json({ error: error.message, code: "share_taken_down" }, { status: 403 });
    }
    throw error;
  }
}
