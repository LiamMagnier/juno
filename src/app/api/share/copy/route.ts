import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";
import { copySharedArtifact } from "@/lib/share-copy";
import { artifactPath, chatArtifactPath } from "@/lib/artifact-links";

export const runtime = "nodejs";

const bodySchema = z.object({ token: z.string().min(16).max(128) });

/**
 * "Make a copy" on a public artifact page (src/lib/share-copy.ts): the
 * signed-in visitor gets the version the page shows as a new artifact of
 * their own. Keyed on the link's token, the same capability that shows the
 * page. 201 with the new artifact's address.
 */
export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in to make a copy.", code: "sign_in" }, { status: 401 });
  const limited = await artifactWriteLimited(user, "create");
  if (limited) return limited;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "This link can’t be copied." }, { status: 400 });

  const result = await copySharedArtifact(user.id, parsed.data.token);
  if (!result.ok) {
    if (result.error === "gone") return NextResponse.json({ error: "This link isn’t shared any more.", code: "gone" }, { status: 410 });
    if (result.error === "not_copyable") {
      return NextResponse.json({ error: "This kind of artifact can’t be copied from a shared link yet.", code: "not_copyable" }, { status: 409 });
    }
    return NextResponse.json({ error: "This link no longer exists.", code: "not_found" }, { status: 404 });
  }
  // `url` opens the copy's chat with the canvas on it; `artifactUrl` is its own page.
  return NextResponse.json(
    {
      id: result.id,
      conversationId: result.conversationId,
      url: chatArtifactPath(result.conversationId, result.identifier),
      artifactUrl: artifactPath(result.id),
    },
    { status: 201 }
  );
}
