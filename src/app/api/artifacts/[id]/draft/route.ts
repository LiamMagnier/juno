import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/session";
import { ownedArtifactWhere } from "@/lib/artifact-access";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";
import { discardArtifactDraft, sealArtifactDraft } from "@/lib/artifact-writes";
import { deleteCanvasDraft, readCanvasDraft, writeCanvasDraft } from "@/lib/artifact-canvas-draft";
import { MAX_ARTIFACT_CONTENT_CHARS } from "@/lib/artifact-content";

export const runtime = "nodejs";

/*
 * AN ARTIFACT'S DRAFT: work that is not a version yet.
 *
 * Two kinds live behind this one address, by artifact type:
 *
 *   - A DESIGN's working copy (ArtifactDraft, src/lib/artifact-writes.ts). The
 *     editor writes it through its transactions; here it is only sealed into a
 *     version or discarded (POST).
 *   - Every other type's unsaved canvas edit (ArtifactCanvasDraft,
 *     src/lib/artifact-canvas-draft.ts, G12). The canvas reads it when the
 *     artifact opens (GET), autosaves it as the person types (PUT) and drops
 *     it when they save a version or discard (DELETE). It never becomes a
 *     version on its own.
 */

const bodySchema = z.object({ action: z.enum(["seal", "discard"]).default("seal") });

const putSchema = z.object({
  content: z.string().max(MAX_ARTIFACT_CONTENT_CHARS),
  /** The version the edit started from. */
  baseVersion: z.number().int().positive(),
});

/**
 * The design editor's working copy.
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

/** The person's unsaved canvas edit, or `draft: null`. Never cached: it changes as they type. */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const draft = await readCanvasDraft(user.id, id);
  if (draft === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ draft }, { headers: { "Cache-Control": "no-store" } });
}

/** Autosave the canvas edit. Last write wins; the save that carries it checks its base. */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await artifactWriteLimited(user, "draft");
  if (limited) return limited;

  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "This draft is too large to keep, or it could not be read." }, { status: 400 });
  }
  const { id } = await params;
  const result = await writeCanvasDraft(user.id, id, parsed.data);
  if (!result.ok) {
    switch (result.error) {
      case "not_found":
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      case "design":
        return NextResponse.json({ error: "A design keeps its own draft.", code: "design_draft" }, { status: 409 });
      case "future_base":
        return NextResponse.json({ error: "That version does not exist yet.", code: "future_base" }, { status: 409 });
      case "too_large":
        return NextResponse.json({ error: "This draft is too large to keep." }, { status: 413 });
    }
  }
  return NextResponse.json({ ok: true, draft: { baseVersion: result.draft.baseVersion, updatedAt: result.draft.updatedAt } });
}

/** Drop the canvas edit (saved as a version, or discarded). Idempotent. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await artifactWriteLimited(user, "draft");
  if (limited) return limited;
  const { id } = await params;
  const removed = await deleteCanvasDraft(user.id, id);
  if (removed === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ ok: true, discarded: removed });
}
