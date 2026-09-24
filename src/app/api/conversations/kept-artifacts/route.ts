import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { countKeptArtifacts } from "@/lib/artifact-home";
import { detachOnDeleteEnabled } from "@/lib/artifact-flags";

/**
 * What a conversation delete would keep, for the delete dialogs to say so
 * before the person confirms: "2 artifacts made here stay in Artifacts".
 *
 *   GET /api/conversations/kept-artifacts?id=<conversationId>  one chat
 *   GET /api/conversations/kept-artifacts                      every chat
 *
 * → `{ count, kept }`. `count` is the live artifacts in scope; `kept` is
 * whether a delete keeps them right now (the detach flag). The dialog shows
 * its middle sentence only when both say so, so with the flag rolled back it
 * never promises something the delete will not do.
 *
 * An id that is not one of this account's visible conversations counts 0
 * rather than answering 404: the dialog only drops a sentence, and the answer
 * cannot be used to learn whether some id (the anchor's, say) exists.
 */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const id = new URL(req.url).searchParams.get("id")?.trim() || undefined;
  const count = await countKeptArtifacts(user.id, id);
  return NextResponse.json(
    { count, kept: detachOnDeleteEnabled() },
    // A count read just before a delete; a cached one would quote the wrong
    // number in the dialog.
    { headers: { "cache-control": "no-store" } },
  );
}
