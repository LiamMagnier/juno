import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { createShare, listShares, serializeShare, ShareTakenDownError } from "@/lib/share";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";

export const runtime = "nodejs";

/**
 * The user's active links, newest first. `?conversationId=` or `?artifactId=`
 * narrows to one target's, which is how the Share dialog shows an existing
 * link without creating one: opening the dialog must never mint a link
 * (creating one is the explicit POST below).
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const conversationId = params.get("conversationId")?.trim() || undefined;
  const artifactId = params.get("artifactId")?.trim() || undefined;
  const shares = await listShares(user.id, { conversationId, artifactId });
  return NextResponse.json({ shares: shares.map(serializeShare) });
}

const createSchema = z
  .object({
    kind: z.enum(["CHAT", "ARTIFACT"]),
    conversationId: z.string().cuid().optional(),
    artifactId: z.string().cuid().optional(),
  })
  .refine((d) => (d.kind === "CHAT" ? !!d.conversationId : !!d.artifactId), {
    message: "Target id is required",
  });

/**
 * Create a link, or return the target's newest active one. An explicit action:
 * the web's Share dialog calls it only when the person presses Create link. The
 * web publishes artifacts instead (/api/artifacts/[id]/publication); an
 * ARTIFACT link here is the legacy frozen snapshot the installed apps still
 * create.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const limited = await artifactWriteLimited(user, "publish");
  if (limited) return limited;

  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { kind, conversationId, artifactId } = parsed.data;
  const targetId = kind === "CHAT" ? conversationId! : artifactId!;

  // createShare owner-checks the target and reuses the newest active link.
  let share;
  try {
    share = await createShare(user.id, kind, targetId);
  } catch (err) {
    if (err instanceof ShareTakenDownError) {
      return NextResponse.json({ error: err.message, code: "share_taken_down" }, { status: 403 });
    }
    throw err;
  }
  if (!share) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ share: serializeShare(share) });
}
