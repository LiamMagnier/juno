import { z } from "zod";
import { enqueueSessionCommand, type SessionRouteParams } from "@/lib/code-session-command-route";

export const runtime = "nodejs";
const schema = z.object({
  prompt: z.string().trim().min(1).max(100_000),
  modelID: z.string().min(1).max(300).optional(),
  reasoningEffort: z.string().max(100).nullable().optional(),
  rolePreset: z.string().max(100).optional(),
  permissionMode: z.string().max(100).optional(),
  attachmentIDs: z.array(z.string().max(200)).max(20).optional(),
  idempotencyKey: z.string().min(8).max(200),
});

export async function POST(req: Request, { params }: { params: SessionRouteParams }) {
  return enqueueSessionCommand(req, params, "message", (body) => schema.safeParse(body));
}
