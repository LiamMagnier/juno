import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";
import {
  getPublication,
  publishArtifact,
  PublicationTakenDownError,
  PublicationVersionError,
  unpublishArtifact,
} from "@/lib/artifact-publication";

export const runtime = "nodejs";

/*
 * An artifact's publication: its stable public URL, pinned to a version or to
 * the latest one (src/lib/artifact-publication.ts). Separate from Share.
 *
 *   GET     the publication, or null — never creates one (opening the Publish
 *           panel is not publishing)
 *   POST    { version: n | "latest" } — Publish, Update (move the pin forward)
 *           or Roll back (pin an older version); the same action
 *   DELETE  Unpublish: the page comes down, the URL is kept for next time
 *
 * Reset link is POST ./reset.
 */

type Params = { params: Promise<{ id: string }> };

export async function GET(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const found = await getPublication(user.id, id);
  if (!found) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json(found, { headers: { "Cache-Control": "no-store" } });
}

const publishSchema = z.object({
  version: z.union([z.literal("latest"), z.number().int().positive()]).default("latest"),
});

export async function POST(req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await artifactWriteLimited(user, "publish");
  if (limited) return limited;

  const parsed = publishSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { id } = await params;
  try {
    const publication = await publishArtifact(user.id, id, parsed.data.version);
    if (!publication) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ publication });
  } catch (error) {
    if (error instanceof PublicationTakenDownError) {
      return NextResponse.json({ error: error.message, code: "share_taken_down" }, { status: 403 });
    }
    if (error instanceof PublicationVersionError) {
      return NextResponse.json({ error: error.message, code: "no_such_version" }, { status: 400 });
    }
    throw error;
  }
}

export async function DELETE(_req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await artifactWriteLimited(user, "publish");
  if (limited) return limited;

  const { id } = await params;
  const publication = await unpublishArtifact(user.id, id);
  if (!publication) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ publication });
}
