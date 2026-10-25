import { NextResponse } from "next/server";
import { z } from "zod";
import { requestChatCancel } from "@/lib/chat-first-submission-receipt";
import { stopGeneration } from "@/lib/chat/stop-generation";
import { cancelGeneration, isGenerationLive, recordGenerationCancel } from "@/lib/generation-cancel";
import { rateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/session";

export const runtime = "nodejs";

const schema = z.object({
  generationId: z.string().trim().min(8).max(120),
});

/**
 * Durable Stops per account per minute. Each one that misses this process
 * inserts a row (expiring), so it is bounded; far above any real use — compare
 * mode stops a handful of panes at once — and never applied to the in-process
 * fast path, which writes nothing.
 */
const DURABLE_STOP_LIMIT = { limit: 120, windowSec: 60 } as const;

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const parsed = schema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400 });

  // Fast path first: the registry aborts a generation this process owns at
  // once. Otherwise the Stop is recorded durably and the process that holds
  // the generation — any instance — reads it within a poll (~1s); see
  // chat/stop-generation.ts. `cancelled` is true only when a terminal frame is
  // on its way, so the client keeps reading for it instead of tearing the
  // reader down itself; `delivery` says how the Stop travelled.
  const result = await stopGeneration(
    { generationId: parsed.data.generationId, userId: user.id },
    {
      cancelLocal: cancelGeneration,
      recordCancel: async (ref) => {
        const allowed = await rateLimit({ key: `chat-cancel:${user.id}`, ...DURABLE_STOP_LIMIT });
        if (!allowed.success) throw new Error("durable stop rate limit exceeded");
        await recordGenerationCancel(ref);
      },
      flagReceipt: requestChatCancel,
      isLive: (ref) => isGenerationLive(ref.generationId, ref.userId),
      onError: (stage, error) => {
        console.error("[chat] stop could not be fully recorded", {
          stage,
          generationId: parsed.data.generationId,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    }
  );
  return NextResponse.json({ ok: true, cancelled: result.cancelled, delivery: result.delivery });
}
