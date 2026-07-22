import { z } from "zod";
import { enqueueSessionCommand, type SessionRouteParams } from "@/lib/code-session-command-route";

export const runtime = "nodejs";
const schema = z.object({ idempotencyKey: z.string().min(8).max(200) });

export async function POST(req: Request, { params }: { params: SessionRouteParams }) {
  return enqueueSessionCommand(req, params, "stop", (body) => schema.safeParse(body));
}
