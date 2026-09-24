import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { createRoutineSchema } from "@/lib/agents/domain";
import { createAgentRoutine, findAgent, listAgentRoutines } from "@/lib/agents/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** Its routines: the automations whose task belongs to it. Full editing lives in Automations. */
export async function GET(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  return NextResponse.json({ routines: await listAgentRoutines(user.id, agent.id) });
}

export async function POST(req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;
  const agent = await findAgent(user.id, id);
  if (!agent) return NextResponse.json({ error: "not_found", message: "That agent no longer exists." }, { status: 404 });
  const limit = await rateLimit({ key: `agents:routine:${user.id}`, limit: 30, windowSec: 3600 });
  if (!limit.success) {
    return NextResponse.json(
      { error: "rate_limited", message: "That is a lot of new routines at once. Try again in a little while." },
      { status: 429 }
    );
  }
  const parsed = createRoutineSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That routine could not be read." }, { status: 400 });
  }
  const result = await createAgentRoutine(user, agent, parsed.data);
  return NextResponse.json(result.body, { status: result.status });
}
