import { requireNativeRequest } from "@/lib/native-request";
import { prisma } from "@/lib/prisma";
import { parseCursor } from "@/lib/sync-protocol";
import { apiV1Error, CONTRACT_VERSION } from "@/lib/api-v1";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const current = await requireNativeRequest(request);
    const after = parseCursor(new URL(request.url).searchParams.get("after"));
    const latest = await prisma.accountChange.findFirst({
      where: { accountId: current.user.id }, orderBy: { cursor: "desc" }, select: { cursor: true },
    });
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(`event: ready\ndata: {"after":"${after}"}\n\n`));
        if (latest && latest.cursor > after) controller.enqueue(encoder.encode(`event: cursor\ndata: {"cursor":"${latest.cursor}"}\n\n`));
        controller.enqueue(encoder.encode("event: done\ndata: {}\n\n"));
        controller.close();
      },
    });
    return new Response(body, { headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
      "X-Juno-Contract-Version": CONTRACT_VERSION,
    } });
  } catch (error) {
    return apiV1Error(error);
  }
}
