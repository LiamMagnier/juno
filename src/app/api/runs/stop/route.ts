import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { sessionCommandRateLimit } from "@/lib/code-session-command-route";
import { runStopSchema } from "@/lib/runs/protocol";
import { stopRun } from "@/lib/runs/remote-control";
import { prismaRunControlDeps, remoteActorFor } from "@/lib/runs/remote-control-prisma";

export const runtime = "nodejs";

/**
 * Stop one live run (a Code session on a paired Mac, or a Work attempt) from
 * any signed-in surface: the iPhone's Runs screen and Live Activity, the
 * web's agents tree. Idempotent: a second Stop, from the same device or
 * another, answers `already_stopping` / `already_stopped` with a 2xx and
 * queues nothing new. The rules are in src/lib/runs/remote-control.ts.
 */
export async function POST(req: Request) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const limited = await sessionCommandRateLimit(user.id);
  if (limited) return limited;
  const parsed = runStopSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input", message: "That stop could not be read." }, { status: 400 });
  }
  const result = await stopRun(prismaRunControlDeps(req), {
    userId: user.id,
    actor: await remoteActorFor(req),
    ref: parsed.data.run,
  });
  return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
}
