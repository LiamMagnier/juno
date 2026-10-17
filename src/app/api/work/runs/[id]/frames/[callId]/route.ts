import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/code-remote";
import { isFrameRef, readRunFrame } from "@/lib/computer/frames";

export const runtime = "nodejs";

/*
 * One step's screenshot from a cloud computer run (src/lib/computer/frames.ts).
 *
 * Only the run's owner, and only while the run's session exists: everything
 * else is a 404 with no body worth reading, so the route is not an oracle for
 * which runs or steps exist. A screenshot is whatever was on the agent's
 * screen — a mailbox, a bank page — so it is never cached by anything between
 * here and the viewer, and the page it is shown on cannot leak its address
 * through a Referer.
 */

const PRIVATE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

function notFound(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { ...PRIVATE_HEADERS, "Content-Type": "text/plain; charset=utf-8" },
  });
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string; callId: string }> },
): Promise<Response> {
  const { user, error } = await requireUser();
  if (!user) return error;

  const { id, callId } = await params;
  if (!isFrameRef(id) || !isFrameRef(callId)) return notFound();

  const run = await prisma.workRun.findFirst({
    where: { id, userId: user.id, session: { userId: user.id, deletedAt: null } },
    select: { id: true },
  });
  // The query is scoped to the session user, so a run that is not theirs is simply absent.
  if (!run) return notFound();

  const bytes = await readRunFrame(user.id, run.id, callId);
  if (!bytes) return notFound();

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      ...PRIVATE_HEADERS,
      "Content-Type": "image/jpeg",
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": "inline",
    },
  });
}
