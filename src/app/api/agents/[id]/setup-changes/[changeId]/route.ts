import { NextResponse } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { findAgent } from "@/lib/agents/store";
import {
  applySetupChange,
  findSetupChange,
  serializeSetupChange,
  undoSetupChange,
} from "@/lib/agents/setup-changes-store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string; changeId: string }> };

const NO_STORE = { "Cache-Control": "no-store" } as const;

/** One setup change as it stands now: what the card in the thread draws. */
export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id, changeId } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That crew member no longer exists." }, { status: 404, headers: NO_STORE });
  const change = await findSetupChange(user.id, agent.id, changeId);
  if (!change) return NextResponse.json({ error: "not_found", message: "That change no longer exists." }, { status: 404, headers: NO_STORE });
  return NextResponse.json({ change: serializeSetupChange(change, agent.name) }, { headers: NO_STORE });
}

/**
 * Apply or Undo, pressed by the person on the card.
 *
 * Apply carries the digest of the change the card showed
 * (`setupChangeDigest`): a press for a card that showed something else is
 * refused. That binding is what makes the card itself the deterministic
 * approval for a widening change that was not approved in the turn (it
 * expired, or the person said no and changed their mind). The model never
 * reaches this route: it is the person's session, from the person's page.
 */
const actionSchema = z.object({
  action: z.enum(["apply", "undo"]),
  digest: z.string().trim().length(64).optional(),
});

export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id, changeId } = await params;

  const limit = await rateLimit({ key: `agents:setup-change:${user.id}`, limit: 60, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json({ error: "rate_limited", message: "Too many changes this hour. Try again shortly." }, { status: 429, headers: NO_STORE });
  }
  const parsed = actionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "Say whether to apply or undo." }, { status: 400, headers: NO_STORE });
  }

  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That crew member no longer exists." }, { status: 404, headers: NO_STORE });
  const change = await findSetupChange(user.id, agent.id, changeId);
  if (!change) return NextResponse.json({ error: "not_found", message: "That change no longer exists." }, { status: 404, headers: NO_STORE });

  if (parsed.data.action === "apply") {
    const current = serializeSetupChange(change, agent.name);
    if (!current.canApply) {
      return NextResponse.json({ error: "not_applicable", message: "That change is not waiting to be applied." }, { status: 409, headers: NO_STORE });
    }
    if (parsed.data.digest !== current.digest) {
      return NextResponse.json(
        { error: "digest_mismatch", message: "This card is out of date. Reload it and look again before applying." },
        { status: 409, headers: NO_STORE }
      );
    }
    if (agent.status !== "active") {
      return NextResponse.json({ error: "agent_paused", message: `${agent.name} is paused. Resume it before changing its setup.` }, { status: 409, headers: NO_STORE });
    }
    const outcome = await applySetupChange(user, change);
    if (!outcome.ok) return NextResponse.json({ error: outcome.code, message: outcome.message }, { status: outcome.status, headers: NO_STORE });
    return NextResponse.json({ change: serializeSetupChange(outcome.change, agent.name) }, { headers: NO_STORE });
  }

  const outcome = await undoSetupChange(user, change);
  if (!outcome.ok) return NextResponse.json({ error: outcome.code, message: outcome.message }, { status: outcome.status, headers: NO_STORE });
  return NextResponse.json({ change: serializeSetupChange(outcome.change, agent.name) }, { headers: NO_STORE });
}
