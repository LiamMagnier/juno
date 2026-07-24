import { z } from "zod";
import { enqueueSessionCommand } from "@/lib/code-session-command-route";

export const runtime = "nodejs";
const schema = z.object({ approve: z.boolean(), idempotencyKey: z.string().min(8).max(200) });

export async function POST(req: Request, { params }: { params: Promise<{ deviceId: string; sessionId: string; requestId: string }> }) {
  const values = await params;
  const json = await req.json().catch(() => null);
  const body = json && typeof json === "object" ? { ...json, requestId: values.requestId } : json;
  const forwarded = new Request(req.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return enqueueSessionCommand(forwarded, Promise.resolve(values), "approval", (input) =>
    schema.extend({ requestId: z.string().min(1).max(200) }).safeParse(input));
}
