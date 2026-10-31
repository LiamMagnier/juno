import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { findAgent } from "@/lib/agents/store";
import { isAgentTeachConfigured } from "@/lib/env";
import { TeachError } from "@/lib/teach/service";

export const runtime = "nodejs";

/*
 * POST { demonstrationId } → { draft: ClientSkillDraft }
 *
 * Drafts a skill from a recorded demonstration (docs/design/agents-v2/TEACH.md)
 * with the account's background model, from the redacted trace alone. The
 * draft is only a draft: the review card hands it to the Teach page, whose
 * Save is the one write. Costs a model call, so it is rate limited.
 */

type Params = { params: Promise<{ id: string }> };

const HEADERS = { "Cache-Control": "no-store" } as const;

const bodySchema = z.object({ demonstrationId: z.string().trim().min(1).max(64) });

export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  if (!isAgentTeachConfigured()) {
    return NextResponse.json({ error: "teach_off", message: "Teaching by showing isn’t turned on for this server." }, { status: 404, headers: HEADERS });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "Say which recording to learn from." }, { status: 400, headers: HEADERS });
  }
  const limit = await rateLimit({ key: `agents:computer-teach-draft:${user.id}`, limit: 20, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "That’s a lot of drafts this hour. Try again a little later." },
      { status: 429, headers: HEADERS }
    );
  }
  const agent = await findAgent(user.id, id);
  if (!agent) {
    return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404, headers: HEADERS });
  }
  const { teachService } = await import("@/lib/teach/server");
  try {
    const draft = await teachService().draft(user.id, agent.id, parsed.data.demonstrationId, agent.name);
    return NextResponse.json({ draft }, { headers: HEADERS });
  } catch (err) {
    if (err instanceof TeachError) {
      return NextResponse.json({ error: `teach_${err.code}`, message: err.message }, { status: err.status, headers: HEADERS });
    }
    return NextResponse.json(
      { error: "teach_failed", message: "Couldn’t draft a skill right now. Try again in a moment." },
      { status: 500, headers: HEADERS }
    );
  }
}
