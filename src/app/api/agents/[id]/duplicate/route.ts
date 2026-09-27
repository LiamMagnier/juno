import { NextResponse } from "next/server";
import { requireUser } from "@/lib/code-remote";
import { rateLimit } from "@/lib/rate-limit";
import { duplicateAgentForUser } from "@/lib/agents/store";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function POST(_req: Request, { params }: Params) {
  const { user, error } = await requireUser();
  if (!user) return error;
  const { id } = await params;

  const limit = await rateLimit({
    key: `agents:create:${user.id}`,
    limit: 20,
    windowSec: 3600,
  });
  if (!limit.success) {
    return NextResponse.json(
      {
        error: "rate_limited",
        message: "That is a lot of new agents at once. Try again in a little while.",
      },
      { status: 429 }
    );
  }

  const result = await duplicateAgentForUser(user, id);
  return NextResponse.json(result.body, { status: result.status });
}
