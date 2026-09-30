import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";
import { duplicateArtifact } from "@/lib/artifact-duplicate";
import { artifactPath } from "@/lib/artifact-links";

export const runtime = "nodejs";

const bodySchema = z.object({
  /** The version to copy; the current one when absent. */
  version: z.number().int().positive().optional(),
  title: z.string().trim().min(1).max(200).optional(),
});

/**
 * Duplicate an artifact into a new one of the owner's, in the same project,
 * recording its provenance (src/lib/artifact-duplicate.ts). 201 with the new
 * artifact and its address.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await artifactWriteLimited(user, "create");
  if (limited) return limited;

  const parsed = bodySchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { id } = await params;
  const result = await duplicateArtifact(user.id, id, parsed.data);
  if (!result.ok) {
    if (result.error === "no_such_version") return NextResponse.json({ error: "That version does not exist." }, { status: 400 });
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ artifact: result.artifact, url: artifactPath(result.id) }, { status: 201 });
}
