import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ownedArtifactWhere } from "@/lib/artifact-access";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";
import { discardArtifactDraft, sealArtifactDraft } from "@/lib/artifact-writes";

export const runtime = "nodejs";

const bodySchema = z.object({ action: z.enum(["seal", "discard"]).default("seal") });

/**
 * The design editor's working copy (src/lib/artifact-writes.ts).
 *
 * `seal` (the default, and what an empty body means, so the editor can send it
 * with `navigator.sendBeacon` as the page goes away) turns the draft into the
 * next version now: the explicit checkpoint. `discard` throws the draft away
 * and leaves the head as it was. Both are idempotent: with no draft there is
 * nothing to do, and the answer says so with `version: null`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await artifactWriteLimited(user, "save");
  if (limited) return limited;

  const text = await req.text().catch(() => "");
  let raw: unknown = {};
  if (text.trim()) {
    try {
      raw = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    }
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { id } = await params;
  const artifact = await prisma.artifact.findFirst({ where: ownedArtifactWhere(user.id, { id }), select: { id: true } });
  if (!artifact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (parsed.data.action === "discard") {
    const discarded = await discardArtifactDraft(artifact.id, user.id);
    return NextResponse.json({ ok: true, discarded });
  }
  const version = await sealArtifactDraft(artifact.id, user.id);
  return NextResponse.json({ ok: true, version });
}
