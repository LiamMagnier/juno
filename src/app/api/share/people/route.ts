import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { serializeShare, ShareNeedsTranscriptError, ShareTakenDownError, ShareTranscriptRefusedError } from "@/lib/share";
import { addPeopleToShare, sharePeopleFor } from "@/lib/share-people";
import type { ShareTarget } from "@/lib/share-people-core";
import { artifactWriteLimited } from "@/lib/artifact-rate-limit";
import { isSharePeopleEnabled } from "@/lib/env";

export const runtime = "nodejs";

/*
 * Sharing a chat or an artifact with specific people (src/lib/share-people-core.ts).
 *
 *   GET  ?conversationId= | ?artifactId=   the target's people share and who is on it
 *   POST { kind, conversationId | artifactId, emails }   add people, inviting the new ones
 *
 * Removing one person is DELETE /api/share/people/{id}; stopping the share for
 * everyone is the same revoke as a link, DELETE /api/share/{id}.
 *
 * Nothing in either answer depends on whether an address has an account: the
 * list is the addresses the owner typed, and every refusal is about the
 * request (an address that is not one, too many at once, too many today).
 *
 * Off unless SHARE_PEOPLE_ENABLED=1 (src/lib/env.ts): then POST makes nothing
 * and answers 404 `not_enabled`. Reading a target's people share and removing
 * someone from it (DELETE /api/share/people/{id}) still work, so a share made
 * while it was on can always be narrowed; the share page keeps every people
 * share restricted to its people whatever the flag says.
 */

const ID = z.string().cuid();

/** Opening the dialog reads: this never creates a share. */
export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const conversationId = ID.safeParse(params.get("conversationId")?.trim());
  const artifactId = ID.safeParse(params.get("artifactId")?.trim());
  const target: ShareTarget | null = conversationId.success
    ? { kind: "CHAT", targetId: conversationId.data }
    : artifactId.success
      ? { kind: "ARTIFACT", targetId: artifactId.data }
      : null;
  if (!target) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  const { share, people } = await sharePeopleFor(user.id, target);
  return NextResponse.json({ share: share ? serializeShare(share) : null, people });
}

const addSchema = z
  .object({
    kind: z.enum(["CHAT", "ARTIFACT"]),
    conversationId: ID.optional(),
    artifactId: ID.optional(),
    // Entries may each hold several addresses ("a@x.test, b@y.test"); the
    // per-request limit is applied to the addresses once they are parsed.
    emails: z.array(z.string().max(2000)).min(1).max(50),
  })
  .refine((d) => (d.kind === "CHAT" ? !!d.conversationId : !!d.artifactId), { message: "Target id is required" });

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!isSharePeopleEnabled()) {
    return NextResponse.json({ error: "Sharing with specific people is not turned on for this server.", code: "not_enabled" }, { status: 404 });
  }
  // Making a people share is a publish-sized write, on the same budget as a
  // link; the invitations themselves have their own, tighter limits.
  const limited = await artifactWriteLimited(user, "publish");
  if (limited) return limited;

  const parsed = addSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  const { kind, conversationId, artifactId, emails } = parsed.data;
  const target: ShareTarget = { kind, targetId: kind === "CHAT" ? conversationId! : artifactId! };

  let result;
  try {
    result = await addPeopleToShare(user.id, target, emails);
  } catch (err) {
    if (err instanceof ShareTakenDownError) {
      return NextResponse.json({ error: err.message, code: "share_taken_down" }, { status: 403 });
    }
    if (err instanceof ShareTranscriptRefusedError || err instanceof ShareNeedsTranscriptError) {
      return NextResponse.json({ error: err.message, code: "transcript_invalid" }, { status: 400 });
    }
    throw err;
  }

  if (result.ok) {
    return NextResponse.json({ share: serializeShare(result.share), people: result.people, added: result.added });
  }
  switch (result.error) {
    case "not_found":
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    case "no_email":
      return NextResponse.json({ error: "Add an email address.", code: "invalid_email", invalid: [] }, { status: 400 });
    case "invalid_email":
      return NextResponse.json(
        {
          error: result.invalid.length === 1 ? `“${result.invalid[0]}” isn’t an email address.` : "Some of these aren’t email addresses.",
          code: "invalid_email",
          invalid: result.invalid,
        },
        { status: 400 },
      );
    case "too_many_at_once":
      return NextResponse.json({ error: `Add up to ${result.limit} people at a time.`, code: "too_many" }, { status: 400 });
    case "too_many_people":
      return NextResponse.json({ error: `A share can have up to ${result.limit} people.`, code: "too_many" }, { status: 400 });
    case "rate_limited":
      return NextResponse.json(
        { error: "You’ve invited a lot of people recently. Try again later.", code: "rate_limited" },
        { status: 429, headers: { "Retry-After": "3600" } },
      );
  }
}
