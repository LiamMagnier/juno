import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session";
import { acceptSkillCandidate, dismissSkillCandidate } from "@/lib/procedural-memory-store";

type Params = { params: Promise<{ id: string }> };

const bodySchema = z.object({ action: z.enum(["accept", "dismiss"]) });

/** The person's review of one proposal: make it a skill, or never propose it again. */
export async function POST(req: Request, { params }: Params) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
  if (parsed.data.action === "dismiss") {
    return (await dismissSkillCandidate(user.id, id))
      ? NextResponse.json({ ok: true })
      : NextResponse.json({ error: "That proposal is no longer open." }, { status: 404 });
  }
  const outcome = await acceptSkillCandidate(user.id, id);
  if (outcome.ok) return NextResponse.json({ ok: true, slug: outcome.slug, href: `/skills/${outcome.skillId}` });
  const message =
    outcome.reason === "slug_taken"
      ? "You already have a skill with this name. Rename that one, then try again."
      : outcome.reason === "no_name"
        ? "This method needs a name before it can become a skill."
        : "That proposal is no longer open.";
  return NextResponse.json({ error: message }, { status: outcome.reason === "not_found" ? 404 : 409 });
}
