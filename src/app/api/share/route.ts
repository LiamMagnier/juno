import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { createShare, listShares, serializeShare, ShareNeedsTranscriptError, ShareTakenDownError, ShareTranscriptRefusedError } from "@/lib/share";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";
import { sanitizeSharedTranscript, type SharedTranscriptEntry } from "@/lib/share-transcript";

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
    // A Code session whose transcript lives on the user's Mac sends it with
    // the link (src/lib/share-transcript.ts re-checks, bounds and redacts it).
    transcript: z.array(z.unknown()).optional(),
  })
  .refine((d) => (d.kind === "CHAT" ? !!d.conversationId : !!d.artifactId), {
    message: "Target id is required",
  })
  .refine((d) => d.kind === "CHAT" || d.transcript === undefined, { message: "Only a chat link takes a transcript" });

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

  let transcript: SharedTranscriptEntry[] | undefined;
  if (parsed.data.transcript !== undefined) {
    const checked = sanitizeSharedTranscript(parsed.data.transcript);
    if (!checked.ok) return NextResponse.json({ error: checked.error, code: "transcript_invalid" }, { status: 400 });
    transcript = checked.entries;
  }

  // createShare owner-checks the target and reuses the newest active link.
  let share;
  try {
    share = await createShare(user.id, kind, targetId, transcript ? { transcript } : {});
  } catch (err) {
    if (err instanceof ShareTakenDownError) {
      return NextResponse.json({ error: err.message, code: "share_taken_down" }, { status: 403 });
    }
    if (err instanceof ShareTranscriptRefusedError || err instanceof ShareNeedsTranscriptError) {
      return NextResponse.json({ error: err.message, code: "transcript_invalid" }, { status: 400 });
    }
    throw err;
  }
  if (!share) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({ share: serializeShare(share) });
}
